![Downbeat banner](docs/assets/banner.svg)

[![Worker](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?style=flat&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![CLI](https://img.shields.io/badge/CLI-Swift%206%20%2F%20macOS%2014.4%2B-F05138?style=flat&logo=swift&logoColor=white)](cli/)
[![Codec](https://img.shields.io/badge/audio-Opus%2020ms%20%C2%B7%2048%20kHz-3ef2a0?style=flat)](#5-how-the-synchronisation-works)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat)](LICENSE)

Multi-device audio synchronisation over the web. One host, any number of
phones, and the same sample leaving every speaker at the same instant.

I built the whole path — the room clock, the arm barrier, the drift
controller, the macOS capture CLI, and the browser playback ring — and every
timing claim below is a number I measured against the deployed system, not a
figure from a datasheet. Where something is unverified, it says so.

## 1. Results

Measured against the production deployment on `downbeat.lukaloehr.com` from
Karlsruhe (Cloudflare VIE edge), 2026-08-23.

| what | measured |
| --- | ---: |
| Room-clock uncertainty, browser (40 probes) | **±4.5 ms** |
| Room-clock uncertainty, CLI (steady state) | **±8.2 ms** |
| Distinct start instants across 3 clients | **1** |
| Live stream, gaps in 425 packets | **0** |
| Live stream, packets arriving late | **0** |
| Live stream, median lead over deadline | **1868 ms** |
| Opus packet rate / bitrate | **50 /s · ~110 kbit/s** |
| Drift controller, 100 ppm crystal error | **< 1 ms sustained** |

> **Status: working, v0.1.0.** File playback and live capture both run end to
> end. Sync quality is confirmed by ear by the author across several phones;
> a calibrated acoustic measurement across devices has **not** been taken, so
> the figures above describe the timing pipeline, not the air in the room.

## 2. System

- **Nothing streams at playback time.** For file playback the audio is fully
  decoded on every device *before* a deadline is chosen, so network jitter is
  mathematically irrelevant to when a sample is heard. All that crosses the
  wire at playback time is one number.
- **An arm barrier, not a countdown.** No device is given a start instant until
  every device reports the track decoded and ready.
- **A drift controller that holds the line.** Device crystals differ by
  10–100 ppm, so two phones drift apart by ~1 ms every 10–100 s. Error is
  erased with a ±0.4 % playback-rate nudge — about 7 cents of pitch, applied as
  a ramp, inaudible on music.
- **Live capture from a Mac** via a Core Audio process tap: Spotify (or any
  app) is captured *and muted at the real output* in one step, so the host
  hears it back through Downbeat in step with every phone.
- **Sessions are real server state.** A signed token cannot be revoked and
  cannot stop two hosts claiming one room, so ownership lives in D1 with
  explicit takeover, and an hourly cron sweeps expired sessions and orphaned
  audio.
- **The player has no buttons.** A joined phone is a speaker, not a remote:
  every control is a way for one device to end up out of step with the others.

## 3. Architecture

```text
  Spotify.app  ──┐
                 │  Core Audio process tap (original muted)
                 ▼
        downbeat CLI (Swift)  ── same room clock as the browsers
                 │  Opus 20 ms frames, ~110 kbit/s
                 ▼
  ┌────────────────────────────────────────────────────┐
  │  Worker  — static assets, rooms, sessions, R2 proxy │
  └────────────────────────────────────────────────────┘
                 │
                 ▼
     ┌───────────────────────────┐        D1: sessions, uploads
     │  RoomDO (Durable Object)  │        R2: uploaded audio
     │  · WebSocket hub          │        Cron: hourly sweep
     │  · TIME SERVER            │
     │  · queue + arm barrier    │
     │  · live relay (tagged)    │
     └───────────────────────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
  iPhone       iPad         Mac        AudioWorklet ring,
                                       indexed by output frame
```

| path | contents |
| --- | --- |
| `src/worker/index.ts` | Router, sessions, host tokens, R2 range serving, cron sweep |
| `src/worker/room-do.ts` | Durable Object: WS hub, time server, arm barrier, live relay |
| `src/audio/clock.ts` | Room clock — Cristian's algorithm, min-RTT filtering, slew |
| `src/audio/engine.ts` | Decode-ahead playback, drift control, live player |
| `src/audio/room.ts` | Connection, reconnect, state reconciliation |
| `public/live-processor.js` | AudioWorklet ring buffer for live playback |
| `cli/Sources/downbeat/` | macOS CLI: tap, Opus, transport, local playback, QR |
| `migrations/` | D1 schema |

## 4. Quickstart

### Listening

Open the room URL or scan the QR, tap once, done. The tap is not decoration —
browsers refuse to start audio without a user gesture.

### Hosting from a Mac

```bash
cd cli && swift build -c release
cp .build/release/downbeat ~/.local/bin/

downbeat login            # passphrase once, stored in the Keychain
downbeat host             # taps Spotify, prints a QR, starts the room
```

Useful flags:

| flag | effect |
| --- | --- |
| `--code PARTY7` | claim a fixed room code instead of a random one |
| `--buffer 3000` | raise the delay budget on a weak network (default 2000 ms) |
| `--source system` | capture everything the Mac plays, not just Spotify |
| `--takeover` | take a room already held by another session |
| `--no-mute` | leave the source audible locally |
| `--no-local` | do not play on this Mac |
| `--offline` | local capture and playback only, no room |

## 5. How the synchronisation works

**The clock.** Each client probes the Durable Object over its WebSocket:
send `t0`, the DO replies with `t1`, the client stamps `t2`.

```
offset = t1 − (t0 + t2) / 2        rtt = t2 − t0
```

Only probes close to the fastest round trip are believed — a slow round trip
has more room to hide the path asymmetry that Cristian's algorithm cannot see.
The estimate is stepped during the opening burst and slewed afterwards.

Two things make this work on Cloudflare specifically:

- Workers **freeze `Date.now()` between I/O** as a Spectre mitigation. In a
  WebSocket handler the message arrival *is* that I/O, so the timestamp is
  fresh — provided it is taken before any other work. It is the first
  statement of the handler, deliberately.
- **A shared clock error cancels.** Sync is relative: if the DO clock is 40 ms
  from UTC, every device is 40 ms from UTC *together* and they still agree with
  each other. Only per-device jitter matters, and min-RTT filtering removes it.

**Scheduling.** `getOutputTimestamp()` pairs a context time with the moment
that sample reaches the output, so it already carries the hardware latency.
The mapping collapses to one scalar, `ctx = room/1000 + k`.

**Live playback** writes decoded audio into an AudioWorklet ring **indexed by
absolute output frame**. The alternative — scheduling each 20 ms packet as its
own source node — puts that mapping in the signal path fifty times a second,
and every scrap of its jitter becomes a gap between two packets. That is
audible as a stutter, and it is exactly the bug this design removes: here the
mapping only decides *where in the ring* audio lands, and the output itself is
unconditionally continuous.

## 6. What this deliberately does not do

- **No Spotify Web API.** As of February 2026 new apps are capped at one client
  ID and five users, the app owner must hold Premium, and extended access
  requires a registered company with 250k monthly active users. A
  Spotify-powered room would be permanently limited to five Premium listeners.
  Downbeat captures the Mac's audio output instead and never touches the API.
- **No phone-as-source.** `getDisplayMedia` does not work in any mobile
  browser — Safari exposes the API but audio never arrives — and there is no
  other route to system audio on iOS or Android. The host is a Mac.
- **No WebRTC.** It is built to minimise latency and tolerate drift, resampling
  independently per peer. That destroys the one property this project exists
  for. Downbeat accepts a fixed delay and guarantees identical playout instants
  instead.
- **No per-device latency slider in the player.** Timing is the engine's job.
  The per-device offset still exists in the engine, at zero, as the hook
  Bluetooth speakers will need.

## 7. Development

```bash
npm install
npm run typecheck        # worker + web
npm test                 # clock estimator, drift controller, room codes
npm run build
npx wrangler deploy

cd cli && swift build -c release
./.build/release/downbeat selftest       # Opus encoder against live capture
./.build/release/downbeat selftest-qr    # renders a QR and decodes it back
```

`selftest-qr` is not cosmetic: printing something that *looks* like a QR code
and printing one a phone can actually scan differ in ways the eye cannot see,
so the rendered modules are fed back through Vision and compared.

Deployment runs from GitHub Actions on push to `main`; tagging `v*` builds a
universal CLI binary and attaches it to a release.

## 8. License

[MIT](LICENSE). Downbeat plays audio you provide or that your own machine is
already playing; it circumvents no protection and ships no content.
