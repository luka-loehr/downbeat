//! downbeat-source — a cloud audio source for a Downbeat room.
//!
//! It logs into Spotify with a short-lived access token minted by the Worker,
//! registers as a Spotify **Connect** device (so it shows up under Devices in
//! the operator's own Spotify app anywhere in the world), receives the decoded
//! stream in-process through a custom librespot sink, resamples 44.1 kHz →
//! 48 kHz, Opus-encodes 20 ms frames, and streams them to the room's Durable
//! Object as `role=source` — exactly the contract the old Mac host fulfilled.
//! Everything server- and phone-side is unchanged.
//!
//! Two supervision loops run side by side and fail independently:
//!
//!   * the **Spotify loop** owns the librespot session. When the AP link dies
//!     it asks the Worker for a fresh access token (the one in the environment
//!     would be an hour stale by then) and rebuilds the session under the same
//!     device id, so the Connect device never changes identity.
//!   * the **room loop** owns the websocket to the Durable Object. A drop here
//!     reconnects with a fresh clock burst and re-announces the same `epoch`,
//!     so listeners keep playing straight through the outage.
//!
//! Nothing is captured, screen-scraped, or stored: PCM crosses only RAM, on
//! the operator's own self-hosted deployment, under the operator's own
//! Premium account.

mod clock;

use anyhow::{anyhow, Context, Result};
use clock::RoomClock;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use librespot::connect::{ConnectConfig, Spirc};
use librespot::core::{authentication::Credentials, Session, SessionConfig};
use librespot::playback::audio_backend::{Sink, SinkResult};
use librespot::playback::config::PlayerConfig;
use librespot::playback::convert::Converter;
use librespot::playback::decoder::AudioPacket;
use librespot::playback::mixer::softmixer::SoftMixer;
use librespot::playback::mixer::{Mixer, MixerConfig};
use librespot::playback::player::Player;
use rubato::Resampler;

/// Spotify's native output rate; every track arrives at this rate.
const SPOTIFY_RATE: usize = 44_100;
/// Downbeat's rate: Opus is native here and the whole pipeline assumes it.
const STREAM_RATE: usize = 48_000;
const CHANNELS: usize = 2;
/// 20 ms at 48 kHz — one Opus packet, the unit the whole system moves in.
const OPUS_FRAME: usize = 960;

/// Delay-budget bounds and the cushion band that steers it, all ms. The worst
/// ring cushion in the room (reported by every member as telemetry and echoed
/// back in state broadcasts) is the one number that predicts crackle, so the
/// budget grows immediately when any device sinks below the floor and creeps
/// back down only while the whole room is comfortably above the ceiling.
const BUDGET_MIN_MS: f64 = 700.0;
const BUDGET_MAX_MS: f64 = 3000.0;
const CUSHION_FLOOR_MS: f64 = 150.0;
const CUSHION_CEIL_MS: f64 = 500.0;

struct Config {
    room_code: String,
    host_token: String,
    /// Base URL of the deployment, e.g. https://downbeat.example.workers.dev
    worker_url: String,
    /// The operator's Spotify app client id — the session must present the
    /// same client the access token was minted for.
    client_id: String,
    device_name: String,
    buffer_ms: f64,
    port: u16,
}

impl Config {
    fn from_env() -> Result<Self> {
        let get = |k: &str| std::env::var(k).map_err(|_| anyhow!("missing env {k}"));
        Ok(Self {
            room_code: get("ROOM_CODE")?,
            host_token: get("HOST_TOKEN")?,
            worker_url: get("WORKER_URL")?.trim_end_matches('/').to_string(),
            client_id: get("SPOTIFY_CLIENT_ID")?,
            device_name: std::env::var("DEVICE_NAME").unwrap_or_else(|_| "Downbeat".into()),
            buffer_ms: std::env::var("BUFFER_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500.0),
            port: std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080),
        })
    }

    fn ws_url(&self) -> String {
        let base = self
            .worker_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        format!(
            "{base}/api/ws?code={}&role=source&name=Cloud%20source&hostToken={}",
            self.room_code, self.host_token
        )
    }
}

/// What `/` on the health port reports. Cloudflare Containers use the open
/// port as the readiness signal; the dashboard reads the body.
struct Status {
    spotify: Mutex<String>,
    room: Mutex<String>,
    packets: AtomicU64,
    started: std::time::Instant,
}

impl Status {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            spotify: Mutex::new("starting".into()),
            room: Mutex::new("connecting".into()),
            packets: AtomicU64::new(0),
            started: std::time::Instant::now(),
        })
    }
    fn set_spotify(&self, s: &str) {
        *self.spotify.lock().unwrap() = s.into();
    }
    fn set_room(&self, s: &str) {
        *self.room.lock().unwrap() = s.into();
    }
    fn json(&self) -> String {
        serde_json::json!({
            "spotify": *self.spotify.lock().unwrap(),
            "room": *self.room.lock().unwrap(),
            "packets": self.packets.load(Ordering::Relaxed),
            "uptimeSec": self.started.elapsed().as_secs(),
        })
        .to_string()
    }
}

/// How far ahead of realtime the decoder may run. Enough to ride out encoder
/// hiccups, small next to the delay budget.
const SINK_LEAD: Duration = Duration::from_millis(250);

/// The librespot sink: hands every decoded packet to the encoder task, at
/// realtime pace.
///
/// The pacing is not optional. librespot has no clock of its own — a real
/// audio backend blocks on the sound card and THAT is what holds playback to
/// realtime. A sink that accepts samples as fast as they decode "plays" a
/// three-minute track in seconds: Spotify sees each song end moments after it
/// began and advances the queue, while the room drowns in a firehose of
/// packets stamped into the far future. So this sink is the metronome: it
/// tracks a virtual playhead and sleeps whenever decode runs more than
/// [`SINK_LEAD`] ahead of the wall clock. `write` runs on librespot's player
/// thread, where blocking is exactly what backends are expected to do.
struct ChannelSink {
    tx: mpsc::UnboundedSender<Vec<f32>>,
    /// Wall-clock instant the next chunk is due; `None` until the first write.
    next: Option<std::time::Instant>,
}

impl Sink for ChannelSink {
    fn start(&mut self) -> SinkResult<()> {
        Ok(())
    }
    fn stop(&mut self) -> SinkResult<()> {
        self.next = None;
        Ok(())
    }
    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        if let AudioPacket::Samples(samples) = packet {
            let now = std::time::Instant::now();
            let frames = samples.len() / CHANNELS;
            let dur = Duration::from_secs_f64(frames as f64 / SPOTIFY_RATE as f64);

            // A pause or seek leaves `next` in the past; re-anchor instead of
            // rushing to catch up — bursts are exactly what this prevents.
            let next = match self.next {
                Some(n) if n > now => n,
                _ => now,
            };
            let ahead = next - now;
            if ahead > SINK_LEAD {
                std::thread::sleep(ahead - SINK_LEAD);
            }
            self.next = Some(next + dur);

            // f64 interleaved stereo at 44.1 kHz -> f32 for the encoder path.
            let f32s: Vec<f32> = samples.iter().map(|s| *s as f32).collect();
            let _ = self.tx.send(f32s);
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Two rustls crypto providers exist in this dependency tree (ring via
    // reqwest, aws-lc-rs via the websocket stack), and rustls panics on the
    // first handshake rather than pick one. Choose ring, up front, always.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let status = Status::new();
    tracing::info!(room = %config.room_code, "downbeat-source starting");

    tokio::spawn(serve_health(config.port, status.clone()));

    // One run of this process = one epoch. Listeners treat a re-announce with
    // the same epoch as "the stream you are already playing", so websocket
    // reconnects are seamless; only a process restart forces a re-anchor.
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<f32>>();

    let streamer = tokio::spawn(run_stream(config.clone(), status.clone(), epoch, pcm_rx));
    let spotify = run_spotify(config, status, pcm_tx);

    // If the stream task dies it took an unrecoverable error with it (a
    // resampler or encoder failure); exit so the container supervisor restarts
    // us with a clean slate.
    tokio::select! {
        r = streamer => tracing::error!(?r, "stream task ended"),
        _ = spotify => tracing::error!("spotify supervisor ended"),
    }
    std::process::exit(1);
}

/* ------------------------------------------------------------------ spotify */

/// Owns the librespot session for the life of the process. Each (re)connect
/// fetches a fresh access token from the Worker — the Worker holds the client
/// secret and refresh token; this container never sees either.
async fn run_spotify(
    config: Arc<Config>,
    status: Arc<Status>,
    pcm_tx: mpsc::UnboundedSender<Vec<f32>>,
) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("http client");

    // Built once so the device id — and with it the Connect device identity —
    // survives every reconnect.
    let session_config = SessionConfig {
        client_id: config.client_id.clone(),
        ..SessionConfig::default()
    };
    let connect_config = ConnectConfig {
        name: config.device_name.clone(),
        ..Default::default()
    };

    // 401/409 from the token endpoint is authoritative — the room session was
    // revoked or Spotify was disconnected. A container with dead credentials
    // must stop costing money, so after a few confirmations we exit for good
    // (the supervisor's restart cap ends the story).
    let mut denied = 0u32;

    loop {
        status.set_spotify("fetching-token");
        let token = match fetch_token(&http, &config).await {
            Ok(t) => {
                denied = 0;
                t
            }
            Err(TokenError::Denied(status_code)) => {
                denied += 1;
                tracing::warn!(status_code, denied, "token denied");
                status.set_spotify("token-denied");
                if denied >= 10 {
                    tracing::error!("credentials revoked; shutting down");
                    std::process::exit(2);
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            Err(TokenError::Other(e)) => {
                tracing::warn!(?e, "token fetch failed; retrying");
                status.set_spotify("token-failed");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        status.set_spotify("connecting");
        let session = Session::new(session_config.clone(), None);
        let mixer = match SoftMixer::open(MixerConfig::default()) {
            Ok(m) => Arc::new(m),
            Err(e) => {
                tracing::error!(?e, "softmixer open failed");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let tx = pcm_tx.clone();
        let player = Player::new(
            PlayerConfig::default(),
            session.clone(),
            mixer.get_soft_volume(),
            move || Box::new(ChannelSink { tx: tx.clone(), next: None }),
        );

        match Spirc::new(
            connect_config.clone(),
            session,
            Credentials::with_access_token(token),
            player,
            mixer,
        )
        .await
        {
            Ok((spirc, spirc_task)) => {
                status.set_spotify("connected");
                tracing::info!("spotify connect device online");
                spirc_task.await; // runs until the session dies
                let _ = spirc.shutdown();
                status.set_spotify("reconnecting");
                tracing::warn!("spotify session ended; reconnecting");
            }
            Err(e) => {
                status.set_spotify("connect-failed");
                tracing::warn!(?e, "spotify connect failed; retrying");
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

enum TokenError {
    /// The Worker said no on purpose: revoked session or Spotify disconnected.
    Denied(u16),
    Other(anyhow::Error),
}

async fn fetch_token(http: &reqwest::Client, config: &Config) -> Result<String, TokenError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TokenResponse {
        access_token: String,
    }
    let resp = http
        .post(format!("{}/api/source/token", config.worker_url))
        .json(&serde_json::json!({
            "code": config.room_code,
            "hostToken": config.host_token,
        }))
        .send()
        .await
        .map_err(|e| TokenError::Other(anyhow!(e).context("token request")))?;
    let code = resp.status().as_u16();
    if code == 401 || code == 409 {
        return Err(TokenError::Denied(code));
    }
    if !resp.status().is_success() {
        return Err(TokenError::Other(anyhow!("token endpoint returned {code}")));
    }
    resp.json::<TokenResponse>()
        .await
        .map(|t| t.access_token)
        .map_err(|e| TokenError::Other(anyhow!(e).context("token body")))
}

/* --------------------------------------------------------------------- room */

/// Everything downstream of the decoder: resample, encode, stamp, ship, plus
/// the clock probes and reconnects. Owns its own websocket so a drop here
/// never touches the Spotify session.
async fn run_stream(
    config: Arc<Config>,
    status: Arc<Status>,
    epoch: u64,
    mut pcm_rx: mpsc::UnboundedReceiver<Vec<f32>>,
) -> Result<()> {
    let clock = Arc::new(Mutex::new(RoomClock::new()));

    // rubato works on planar (per-channel) data in fixed-size chunks.
    let mut resampler = rubato::FftFixedIn::<f32>::new(
        SPOTIFY_RATE,
        STREAM_RATE,
        1024, // input frames per process call
        2,    // sub-chunks
        CHANNELS,
    )
    .context("resampler")?;

    let mut encoder = opus::Encoder::new(
        STREAM_RATE as u32,
        opus::Channels::Stereo,
        opus::Application::Audio,
    )
    .context("opus encoder")?;
    encoder.set_bitrate(opus::Bitrate::Bits(128_000)).ok();

    // Planar input buffers accumulate until a full resampler chunk is ready.
    let mut in_l: Vec<f32> = Vec::new();
    let mut in_r: Vec<f32> = Vec::new();
    // Interleaved 48 kHz output waiting to be sliced into Opus frames.
    let mut out_interleaved: Vec<f32> = Vec::new();

    let mut anchor_local_ms: Option<f64> = None;
    let mut emitted: i64 = 0; // resampled frames emitted, the sample index

    // The clock offset and the delay budget both fold into the packet stamps,
    // and both are slewed at the same bounded rate: a stamp discontinuity is
    // indistinguishable from network jitter to every listener, so there must
    // never be one.
    let mut stream_offset = 0.0_f64;
    let mut offset_primed = false;
    let mut budget = config.buffer_ms.clamp(BUDGET_MIN_MS, BUDGET_MAX_MS);
    let mut budget_target = budget;
    let packet_seconds = OPUS_FRAME as f64 / STREAM_RATE as f64;
    let max_step = 2.0 * packet_seconds; // ≤2 ms/s per steered quantity

    let mut opus_out = vec![0u8; 4000];

    // The websocket, reconnected on drop with a fresh clock burst.
    loop {
        let ws = match tokio_tungstenite::connect_async(config.ws_url()).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                tracing::warn!(?e, "room connect failed; retrying");
                status.set_room("reconnecting");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let (mut write, mut read) = ws.split();
        clock.lock().unwrap().reset();
        status.set_room("connected");

        if let Err(e) = announce_live(&mut write, budget, epoch).await {
            tracing::warn!(?e, "live announce failed; reconnecting");
            continue;
        }

        // Clock probes: a fast opening burst, then a slow keepalive. Each
        // steady-state tick also reports telemetry so the host's device list
        // shows the source's link quality like any other member's.
        let clock_ping = clock.clone();
        let (ping_tx, mut ping_rx) = mpsc::unbounded_channel::<String>();
        let pinger = tokio::spawn(async move {
            let mut burst = 20;
            loop {
                let (t0, rtt, sync) = {
                    let c = clock_ping.lock().unwrap();
                    (c.local_now(), c.min_rtt(), c.uncertainty())
                };
                if ping_tx.send(format!("{{\"t\":\"ping\",\"t0\":{t0}}}")).is_err() {
                    break;
                }
                if burst == 0 {
                    let telemetry = serde_json::json!({
                        "t": "telemetry",
                        "rtt": rtt,
                        "sync": sync,
                        "startError": serde_json::Value::Null,
                    });
                    if ping_tx.send(telemetry.to_string()).is_err() {
                        break;
                    }
                }
                let wait = if burst > 0 { 40 } else { 2000 };
                if burst > 0 {
                    burst -= 1;
                }
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
        });

        'session: loop {
            tokio::select! {
                // Outgoing clock pings.
                Some(text) = ping_rx.recv() => {
                    if write.send(Message::Text(text)).await.is_err() { break 'session; }
                }
                // Incoming control (pongs, state) from the room.
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Some((t0, t1)) = parse_pong(&text) {
                                clock.lock().unwrap().on_pong(t0, t1);
                            } else if let Some(worst) = parse_worst_cushion(&text) {
                                // Grow by the full deficit at once (the slew
                                // limits how fast it lands); shrink by creep.
                                if worst < CUSHION_FLOOR_MS {
                                    budget_target = (budget_target
                                        + (CUSHION_FLOOR_MS - worst)).min(BUDGET_MAX_MS);
                                } else if worst > CUSHION_CEIL_MS {
                                    budget_target = (budget_target - 2.0).max(BUDGET_MIN_MS);
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break 'session,
                        Some(Err(e)) => { tracing::warn!(?e, "ws read"); break 'session; }
                        _ => {}
                    }
                }
                // Decoded PCM from librespot.
                pcm = pcm_rx.recv() => {
                    let Some(pcm) = pcm else {
                        return Err(anyhow!("pcm channel closed"));
                    };
                    if anchor_local_ms.is_none() {
                        anchor_local_ms = Some(clock.lock().unwrap().local_now());
                    }
                    // Deinterleave into the resampler's planar input.
                    for frame in pcm.chunks_exact(CHANNELS) {
                        in_l.push(frame[0]);
                        in_r.push(frame[1]);
                    }
                    // Feed full 1024-frame chunks through the resampler.
                    while in_l.len() >= 1024 {
                        let chunk_l: Vec<f32> = in_l.drain(..1024).collect();
                        let chunk_r: Vec<f32> = in_r.drain(..1024).collect();
                        let resampled = resampler
                            .process(&[chunk_l, chunk_r], None)
                            .map_err(|e| anyhow!("resample: {e}"))?;
                        let (rl, rr) = (&resampled[0], &resampled[1]);
                        for i in 0..rl.len() {
                            out_interleaved.push(rl[i]);
                            out_interleaved.push(rr[i]);
                        }
                    }
                    // Peel off whole 20 ms Opus frames.
                    while out_interleaved.len() >= OPUS_FRAME * CHANNELS {
                        let frame: Vec<f32> =
                            out_interleaved.drain(..OPUS_FRAME * CHANNELS).collect();
                        let n = encoder.encode_float(&frame, &mut opus_out)
                            .map_err(|e| anyhow!("opus: {e}"))?;

                        let anchor = anchor_local_ms.unwrap();
                        let offset = clock.lock().unwrap().offset();
                        if !offset_primed { stream_offset = offset; offset_primed = true; }
                        stream_offset += (offset - stream_offset).clamp(-max_step, max_step);
                        budget += (budget_target - budget).clamp(-max_step, max_step);

                        let capture_room_ms = anchor
                            + emitted as f64 / STREAM_RATE as f64 * 1000.0
                            + stream_offset;
                        let play_at = capture_room_ms + budget;

                        let mut wire = Vec::with_capacity(16 + n);
                        wire.extend_from_slice(&play_at.to_le_bytes());
                        wire.extend_from_slice(&(emitted as f64).to_le_bytes());
                        wire.extend_from_slice(&opus_out[..n]);
                        // A dead socket ends the SESSION, not just this batch —
                        // an unlabeled break here would only stop peeling and
                        // leave the select loop spinning against a broken pipe.
                        if write.send(Message::Binary(wire)).await.is_err() { break 'session; }

                        emitted += OPUS_FRAME as i64;
                        status.packets.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
        pinger.abort();
        status.set_room("reconnecting");
        tracing::warn!("room link dropped; reconnecting");
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn announce_live<S>(write: &mut S, budget_ms: f64, epoch: u64) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let msg = serde_json::json!({
        "t": "cmd",
        "cmd": {
            "c": "liveStart",
            "live": {
                "sampleRate": STREAM_RATE,
                "channels": CHANNELS,
                "frameSize": OPUS_FRAME,
                "bufferMs": budget_ms,
                "sourceLabel": "Spotify",
                "epoch": epoch,
            }
        }
    });
    write.send(Message::Text(msg.to_string())).await?;
    Ok(())
}

fn parse_pong(text: &str) -> Option<(f64, f64)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("t")?.as_str()? != "pong" {
        return None;
    }
    Some((v.get("t0")?.as_f64()?, v.get("t1")?.as_f64()?))
}

/// The smallest ring cushion any member reported, from a state broadcast.
fn parse_worst_cushion(text: &str) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("t")?.as_str()? != "state" {
        return None;
    }
    v.get("state")?
        .get("members")?
        .as_array()?
        .iter()
        .filter_map(|m| m.get("cushionMs")?.as_f64())
        .fold(None, |acc, c| Some(acc.map_or(c, |a: f64| a.min(c))))
}

/* ------------------------------------------------------------------- health */

/// A deliberately tiny HTTP responder: whatever arrives on the port gets the
/// status JSON. Cloudflare Containers treat the open port as readiness, and
/// the Worker polls it for the dashboard.
async fn serve_health(port: u16, status: Arc<Status>) {
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(?e, port, "health port bind failed");
            return;
        }
    };
    tracing::info!(port, "health endpoint up");
    loop {
        let Ok((mut sock, _)) = listener.accept().await else { continue };
        let status = status.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await; // drain the request line
            let body = status.json();
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
    }
}
