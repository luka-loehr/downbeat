![Downbeat banner](docs/assets/banner.svg)

[![Worker](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?style=flat&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![CLI](https://img.shields.io/badge/CLI-Swift%206%20%C2%B7%20one%20native%20binary-F05138?style=flat&logo=swift&logoColor=white)](cli/)
[![Codec](https://img.shields.io/badge/audio-Opus%2020%20ms%20%C2%B7%2048%20kHz-3ef2a0?style=flat)](#5-how-the-synchronisation-works)
[![Drift](https://img.shields.io/badge/steady--state%20drift-0.00%20ms-3ef2a0?style=flat)](#5-how-the-synchronisation-works)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat)](LICENSE)

**Play one song on every phone in the room, on the same millisecond.**

Point a camera at the QR code your Mac prints. Tap once. That is the entire
setup — no app, no account, no pairing. Whatever your Mac is playing comes out
of every phone at the same instant, and stays there.

Spotify's own group session drifts by roughly a second between devices, because
it streams at playback time and every device buffers differently. Downbeat
inverts that: the audio is on your phone **before** a deadline exists, and all
that crosses the network at playback time is a timestamp. Network jitter then
has nothing left to affect.

```bash
git clone https://github.com/luka-loehr/downbeat && cd downbeat
./scripts/install.sh          # builds the one native binary Downbeat is
downbeat login                # once, against your own deployment
downbeat host                 # prints a QR code
```

Downbeat runs on **your** Cloudflare account, not a service someone else
operates: one Worker, one Durable Object, one R2 bucket, one D1 database, all
comfortably inside the free tiers except Durable Objects. See
[§7](#7-deploying-your-own) to stand one up.

## 1. Results

Measured against the production deployment on `downbeat.lukaloehr.com` from
Karlsruhe (Cloudflare VIE edge), 2026-08-23.

| what | measured |
| --- | ---: |
| Steady-state drift, 100 ppm crystal, simulated hour | **0.0000 ms** |
| ... and between two devices with opposite crystals | **0.0000 ms** |
| Room-clock spread across three clients, 90 probes each | **0.47 ms** |
| Inter-device playout spread, 4 min, ±110 ppm crystals | **2.4 ms median** |
| ... and whether it accumulates (first half → second half) | **flat** |
| Live stream over 4 minutes, packets late | **0 of 11,980** |
| Distinct start instants across 3 clients (file mode) | **1** |
| Opus packet rate / bitrate | **50 /s · ~110 kbit/s** |

> **Status: working, v0.1.0.** File playback and live capture both run end to
> end. The inter-device figures come from three virtual clients running the
> real clock estimator and the real control law against the deployed server and
> a real capture source; the clock numbers are shared with the browser, while
> the rest carries some jitter from the harness, whose loop is a JS timer
> rather than an audio clock. A calibrated acoustic measurement across physical
> devices has **not** been taken, so these describe the timing pipeline, not
> the air in the room -- where 34 cm of distance is already a millisecond.

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
- **One native binary on the host.** Capture, Opus, transport, local playback
  and the terminal dashboard are a single Swift executable — no Node runtime,
  no helper processes, a few tens of megabytes and a few percent of one core.
- **Shared memory to the speaker.** In the browser, decoded audio is written
  straight into a SharedArrayBuffer ring the AudioWorklet reads on the
  realtime thread: zero copies, zero message ports, and main-thread jank
  cannot touch playback. An adaptive delay budget then trims itself to the
  smallest value the room's weakest listener can actually carry.
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
  iPhone       iPad         Mac        shared-memory ring,
                                       indexed by stream sample
```

| path | contents |
| --- | --- |
| `src/worker/index.ts` | Router, sessions, host tokens, R2 range serving, cron sweep |
| `src/worker/room-do.ts` | Durable Object: WS hub, time server, arm barrier, live relay |
| `src/audio/clock.ts` | Room clock — Cristian's algorithm, min-RTT filtering, slew |
| `src/audio/engine.ts` | Decode-ahead playback, drift control, live player |
| `src/audio/room.ts` | Connection, reconnect, state reconciliation |
| `public/live-processor.js` | AudioWorklet reading the shared-memory ring |
| `cli/Sources/downbeat/` | the host binary: tap, Opus, transport, local playback, dashboard, QR |
| `migrations/` | D1 schema |

## 4. Quickstart

### Listening

Open the room URL or scan the QR, tap once, done. The tap is not decoration —
browsers refuse to start audio without a user gesture.

### Hosting from a Mac

```bash
./scripts/install.sh      # or: cd cli && swift build -c release

downbeat login            # passphrase once
downbeat host             # taps Spotify, draws the dashboard, opens the room
```

While hosting, the terminal is live: `m` mutes this Mac without touching
anyone else, `+` and `-` set its level, and `s` switches capture to another
app — Spotify, Apple Music, a browser tab, or everything at once — without
interrupting the room.

Useful flags:

| flag | effect |
| --- | --- |
| `--code PARTY7` | claim a fixed room code instead of a random one |
| `--buffer 3000` | starting delay budget (default 2000 ms); the host then adapts it toward the smallest value the room's listeners can carry |
| `--min-buffer 500` | the adaptive budget's floor (default 350 ms) |
| `--no-adapt` | pin the budget at `--buffer` |
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

**Live playback** writes decoded audio into a **SharedArrayBuffer ring
indexed by absolute stream sample**, read directly by the AudioWorklet on the
realtime audio thread — no copies, no message ports, so a janky main thread
cannot stutter playback (the pages are served cross-origin isolated to make
that legal). The alternative — scheduling each 20 ms packet as its
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
- **No claim of perfect synchronisation.** Sound travels 34 cm per millisecond,
  so two speakers three metres apart are ~9 ms apart at any listener no matter
  what the software does. Downbeat removes the software error; the room is the
  room.

## 7. Deploying your own

Downbeat is not a hosted service. It is a thing you run, and the whole of it is
in this repository.

```bash
npm install
npx wrangler r2 bucket create downbeat-audio
npx wrangler d1 create downbeat-sessions      # put the id in wrangler.jsonc
npx wrangler d1 migrations apply downbeat-sessions --remote
npx wrangler secret put HOST_PASSPHRASE       # gates room creation and uploads
npm run build && npx wrangler deploy
```

Point `routes` in `wrangler.jsonc` at a hostname on a zone you control, or drop
it and use the `*.workers.dev` URL. Then on the Mac that will host:

```bash
./scripts/install.sh
DOWNBEAT_URL=https://your-worker.example.com downbeat login
downbeat host
```

Requires **Workers Paid** for Durable Objects, and macOS 15+ on the host.
Listeners need nothing but a modern browser (the pages are served
cross-origin isolated for shared-memory audio).

### Working on it

```bash
npm run typecheck        # worker + web
npm test                 # clock estimator, drift controller, room codes
npm run build
cd cli && swift build -c release
./.build/release/downbeat selftest      # Opus encoder against live capture
./.build/release/downbeat selftest-qr   # renders a QR and decodes it back
```

`selftest-qr` is not cosmetic: printing something that *looks* like a QR code
and printing one a phone can actually scan differ in ways the eye cannot see,
so the rendered modules are fed back through Vision and compared.

Deployment runs from GitHub Actions on push to `main`; tagging `v*` builds a
universal CLI binary and attaches it to a release.

## 8. License

[MIT](LICENSE). Downbeat plays audio you provide or that your own machine is
already playing; it circumvents no protection and ships no content.
