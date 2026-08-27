import type {
  ClientMessage,
  HostCommand,
  RoomState,
  ServerMessage,
  Role,
} from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { SyncedClock, type ClockStats } from "./clock";
import { PlaybackEngine, LivePlayer, type EngineStatus, type LiveStats } from "./engine";
import { claimPlaybackAudioSession, unlockAudio } from "./latency";
import { journal } from "./journal";

export interface RoomSnapshot {
  connected: boolean;
  you: string | null;
  role: Role;
  state: RoomState | null;
  clock: ClockStats;
  engine: EngineStatus;
  live: LiveStats | null;
  error: string | null;
}

type Listener = (s: RoomSnapshot) => void;

const TELEMETRY_MS = 2000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
/**
 * A clock probe unanswered for this long means the socket is half-open: the
 * network died without telling us, sends still "succeed", and `close` may not
 * fire for minutes. Probes go out every 2 s, so a healthy link never trips it.
 */
const PONG_TIMEOUT_MS = 7000;

export class RoomConnection {
  private ws: WebSocket | null = null;
  private clock: SyncedClock;
  private engine: PlaybackEngine | null = null;
  private ctx: AudioContext | null = null;
  private live: LivePlayer | null = null;

  private you: string | null = null;
  private role: Role = "listener";
  private state: RoomState | null = null;
  private error: string | null = null;
  private connected = false;
  private closedByUs = false;
  private attempt = 0;

  private visibilityHooked = false;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  /** Guards against sending `ready` twice for the same arm. */
  private armedSeq = -1;
  /** Guards against re-scheduling the same start on every state broadcast. */
  private scheduledSeq = -1;
  /** Epoch of the live stream currently playing; see LiveState.epoch. */
  private liveEpoch: number | null = null;
  /** `performance.now()` of the oldest clock probe still awaiting its pong.
   *  Pairing ping against pong -- rather than against wall time -- keeps a
   *  throttled background tab from condemning a healthy socket. */
  private unansweredSince = 0;

  constructor(
    private readonly code: string,
    private readonly name: string,
    private readonly hostToken: string | null,
  ) {
    this.clock = new SyncedClock((t0) => {
      if (this.unansweredSince === 0) this.unansweredSince = performance.now();
      this.send({ t: "ping", t0 });
    });
  }

  /* ------------------------------------------------------------------ lifecycle */

  /** Must be called from a user gesture: iOS will not start audio otherwise. */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // `interactive` asks for the smallest buffer the device will give us,
      // which keeps the browser's own latency estimate small and stable.
      //
      // 48 kHz is requested explicitly because live playback indexes its ring
      // in output frames: if the context ran at 44.1 kHz while the stream is
      // 48 kHz, every packet would land in the wrong place. Not every device
      // honours the request, so fall back rather than fail to start at all.
      try {
        this.ctx = new Ctor({ latencyHint: "interactive", sampleRate: 48000 });
      } catch {
        this.ctx = new Ctor({ latencyHint: "interactive" });
      }
      await unlockAudio(this.ctx);
      // Coming back from a suspension, the clock estimate is wrong by however
      // long the page's clocks were frozen -- and confirming that over the
      // 2-second keepalive takes ~8 s of playing at the wrong position. A
      // fresh burst steps the offset within one round trip instead.
      this.ctx.onstatechange = () => {
        // A suspended context IS silence on this device; nothing explains a
        // quiet phone in the logs better than this one line.
        journal.log("audio-context", { state: this.ctx?.state ?? "gone" });
        if (this.ctx?.state === "running" && this.connected) {
          this.clock.reset();
          this.clock.start();
        }
      };
      this.engine = new PlaybackEngine(this.ctx, this.clock);
      this.engine.subscribe(() => this.emit());
      this.live = new LivePlayer(
        this.ctx,
        this.clock,
        this.engine.output,
        () => this.engine?.deviceOffsetMs ?? 0,
      );
    }
    this.closedByUs = false;
    this.open();

    // Coming back to a backgrounded tab is when the context is most likely to
    // have been suspended, and it is also exactly when the user expects sound.
    if (!this.visibilityHooked) {
      this.visibilityHooked = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        void this.wake();
        // A socket dropped while backgrounded will not have retried yet.
        if (!this.connected && !this.closedByUs) this.open();
        // iOS freezes performance.now() while hidden, so the clock offset is
        // wrong by the whole absence. Re-measure now, not over the next 8 s.
        else if (this.connected) {
          this.clock.reset();
          this.clock.start();
        }
      });
    }
  }

  stop(): void {
    this.closedByUs = true;
    this.clock.stop();
    this.live?.stop();
    this.engine?.pause();
    if (this.telemetryTimer !== null) clearInterval(this.telemetryTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.telemetryTimer = null;
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.emit();
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ code: this.code, name: this.name });
    if (this.hostToken) params.set("hostToken", this.hostToken);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/ws?${params}`);
    } catch {
      // A constructor that throws (a browser in a weird network state) must
      // not end the retry chain -- this has to recover unattended.
      this.scheduleReconnect();
      return;
    }
    // Live audio arrives as binary frames, not text.
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      const reconnected = this.attempt > 0;
      this.connected = true;
      this.attempt = 0;
      this.error = null;
      this.unansweredSince = 0;
      this.clock.reset();
      this.clock.start();
      this.send({
        t: "hello",
        role: this.hostToken ? "host" : "listener",
        name: this.name,
        hostToken: this.hostToken ?? undefined,
        v: PROTOCOL_VERSION,
      });
      if (this.telemetryTimer === null) {
        this.telemetryTimer = setInterval(() => this.sendTelemetry(), TELEMETRY_MS);
      }
      // From here on this device's flight recorder streams into the room's
      // quality journal. Registered per-connection; the journal buffers
      // across the gaps.
      journal.setSink((events) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        this.send({ t: "log", events });
        return true;
      });
      if (reconnected) journal.log("ws-reconnected");
      this.emit();
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.live?.push(ev.data);
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      void this.handle(msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.clock.stop();
      journal.setSink(null);
      if (!this.closedByUs) journal.log("ws-lost");
      this.emit();
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.error = "connection problem";
      this.emit();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Backoff, but never past a few seconds: this has to recover on its own
    // while the phone is in someone's pocket, with nobody there to retry.
    // Jittered, so a room full of phones dropped by the same outage does not
    // stampede back through the door in one synchronised wave.
    const delay =
      Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS) *
      (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUs) this.open();
    }, delay);
  }

  /* ------------------------------------------------------------------ messages */

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.t) {
      case "pong":
        this.unansweredSince = 0;
        this.clock.onPong(msg.t0, msg.t1);
        this.emit();
        return;

      case "welcome":
        this.you = msg.you;
        this.role = msg.role;
        this.state = msg.state;
        this.emit();
        await this.reconcile();
        return;

      case "state":
        this.state = msg.state;
        this.emit();
        await this.reconcile();
        return;

      case "play":
        if (!this.engine) return;
        // Claimed before the await so a state broadcast racing this handler
        // cannot double-schedule -- and RELEASED on failure, so a later state
        // message retries instead of leaving the device silent all track.
        this.scheduledSeq = msg.seq;
        if (!this.engine.has(msg.trackId)) {
          // Should not happen -- the barrier waits for `ready` -- but if it
          // does, load and let schedule() clamp and report the start error.
          await this.engine.load(msg.trackId, `/audio/${msg.trackId}`).catch(() => {});
        }
        if (this.engine.has(msg.trackId)) {
          this.engine.schedule(msg.trackId, msg.startAt, msg.offsetInTrack);
        } else {
          this.scheduledSeq = -1;
        }
        return;

      case "pause":
        this.engine?.pause();
        return;

      case "live":
        await this.applyLive(msg.live);
        return;

      case "error":
        this.error = msg.message;
        this.emit();
        return;
    }
  }

  /**
   * React to room state: while the room is arming, fetch and decode the track,
   * then report `ready`. Nobody gets a deadline until everyone has done this.
   */
  private async reconcile(): Promise<void> {
    const st = this.state;
    const engine = this.engine;
    if (!st || !engine) return;

    // A live stream owns the room; the file barrier does not apply. Restart
    // when nothing is playing OR when the stream's epoch changed underneath
    // us -- a source that was restarted while this socket was down has a
    // fresh sample timeline the current player knows nothing about.
    if (st.live?.active) {
      if (!this.live?.running || (st.live.epoch ?? null) !== this.liveEpoch) {
        await this.applyLive(st.live);
      }
      return;
    }
    if (this.live?.running && !st.live) this.live.stop();

    const track = st.queue[st.current];
    if (!track) return;

    // Decoded PCM for anything but the current and next track is dead
    // weight measured in hundreds of megabytes; drop it now.
    const keep = [track.id];
    const next = st.queue[st.current + 1];
    if (next) keep.push(next.id);
    engine.retain(keep);

    if (st.mode === "arming") {
      if (this.armedSeq === st.seq) return;
      this.armedSeq = st.seq;
      try {
        await engine.load(track.id, `/audio/${track.id}`);
        this.send({ t: "ready", trackId: track.id, seq: st.seq });
      } catch (err) {
        this.error = err instanceof Error ? err.message : "could not load track";
        this.emit();
      }
      return;
    }

    // A device that joins -- or reconnects -- while the room is already
    // playing never saw the `play` broadcast: it fired before this socket
    // existed. Derive the identical schedule from the state instead;
    // `schedule()` clamps the past deadline to now and computes the correct
    // in-track position from the room clock, and the seq guard keeps a device
    // that is already playing from restarting itself on every state message.
    if (st.mode === "scheduled" || st.mode === "playing") {
      if (this.scheduledSeq === st.seq) return;
      this.scheduledSeq = st.seq;
      try {
        await engine.load(track.id, `/audio/${track.id}`);
        engine.schedule(track.id, st.startAt, st.offsetInTrack);
      } catch (err) {
        // Release the claim: the next state broadcast retries the load
        // instead of the device staying silent for the rest of the track.
        this.scheduledSeq = -1;
        this.error = err instanceof Error ? err.message : "could not load track";
        this.emit();
      }
      return;
    }

    // A pause that happened while this device was away must still land.
    if (st.mode === "paused") {
      const es = engine.status().state;
      if (es === "playing" || es === "scheduled") engine.pause();
    }
  }

  /**
   * Keep the audio graph awake.
   *
   * A context that has been silent -- a host restarting, a phone backgrounded,
   * a screen locked -- gets suspended by the system, and nothing plays again
   * until something resumes it. That is why a handover appeared to need a page
   * reload: the protocol had already recovered, but the audio hardware had
   * been put to sleep underneath it.
   */
  private async wake(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* needs a gesture; the join tap already provided one */
      }
    }
    claimPlaybackAudioSession();
  }

  /** Start or stop live playback to match what the room says is happening. */
  private async applyLive(live: import("../shared/protocol").LiveState | null): Promise<void> {
    if (!this.live) return;
    if (live?.active) {
      // A re-announce after a source reconnect is not a new stream. If the
      // player is already running the same epoch, its sample timeline is
      // unchanged: packets keep landing by index and playback never blinks.
      // A different (or missing) epoch is a restarted source with a fresh
      // timeline, which genuinely requires starting over.
      if (this.live.running && this.liveEpoch !== null && live.epoch === this.liveEpoch) {
        return;
      }
      journal.log("live-start", {
        epoch: live.epoch ?? null,
        restart: this.live.running,
        bufferMs: live.bufferMs,
      });
      this.liveEpoch = live.epoch ?? null;
      this.engine?.pause();
      await this.wake();
      try {
        await this.live.start({
          sampleRate: live.sampleRate,
          channels: live.channels,
          frameSize: live.frameSize,
          bufferMs: live.bufferMs,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : "live playback unavailable";
        journal.log("live-start-failed", { message: String(err).slice(0, 150) });
        console.error("[downbeat] live start", err);
      }
    } else {
      if (this.live.running) journal.log("live-stop");
      this.live.stop();
      this.liveEpoch = null;
    }
    this.emit();
  }

  liveStats(): LiveStats | null {
    return this.live?.running ? this.live.getStats() : null;
  }

  private sendTelemetry(): void {
    // Half-open detection: if a probe has gone unanswered this long, the
    // socket is dead even though `close` never fired. Closing it by hand
    // hands recovery to the normal reconnect path.
    if (
      this.connected &&
      this.unansweredSince > 0 &&
      performance.now() - this.unansweredSince > PONG_TIMEOUT_MS
    ) {
      this.unansweredSince = 0;
      this.ws?.close();
      return;
    }
    const stats = this.clock.stats();
    const live = this.live?.running ? this.live.getStats() : null;
    // Margin only once the stream is genuinely flowing: the EMA starts at
    // zero, and reporting that during the opening seconds would read as an
    // emergency to the source's adaptive delay budget.
    const settled = live !== null && live.decoded > 100;
    this.send({
      t: "telemetry",
      rtt: Math.round(stats.rtt),
      sync: Math.round(stats.uncertainty * 10) / 10,
      startError: this.engine?.status().startErrorMs ?? null,
      // What this device believes about its own room-clock-to-speaker offset.
      // The spread of this across the room is the inter-device sync error.
      playoutMs: this.live?.running
        ? Math.round(this.live.playoutMs * 10) / 10
        : null,
      marginMs: settled ? Math.round(live.marginMs) : null,
      cushionMs:
        settled && live.cushionMs !== null ? Math.round(live.cushionMs) : null,
      underruns: settled ? live.underruns : null,
    });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /* ------------------------------------------------------------------ host API */

  command(cmd: HostCommand): void {
    this.send({ t: "cmd", cmd });
  }

  getEngine(): PlaybackEngine | null {
    return this.engine;
  }

  getClock(): SyncedClock {
    return this.clock;
  }

  /* ------------------------------------------------------------------ observers */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): RoomSnapshot {
    return {
      connected: this.connected,
      you: this.you,
      role: this.role,
      state: this.state,
      clock: this.clock.stats(),
      engine:
        this.engine?.status() ?? {
          state: "idle",
          trackId: null,
          position: 0,
          driftMs: 0,
          rate: 1,
          startErrorMs: null,
          loadProgress: 0,
        },
      live: this.liveStats(),
      error: this.error,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
