# Architecture

How Downbeat keeps every device in a room playing the same sample at the same
moment.

## System

- **Nothing streams at playback time.** For file playback the audio is fully
  decoded on every device *before* a deadline is chosen, so network jitter does
  not affect when a sample is heard. All that crosses the wire at playback time
  is one number.
- **An arm barrier, not a countdown.** No device is given a start instant until
  every device reports the track decoded and ready.
- **A drift controller.** Device crystals differ by 10–100 ppm, so two phones
  drift apart by ~1 ms every 10–100 s. The error is removed with a ±0.4 %
  playback-rate nudge (about 7 cents of pitch), applied as a ramp.
- **Live capture from a Mac** via a Core Audio process tap: an app (or the whole
  system) is captured *and muted at the real output* in one step, so the host
  hears it back through Downbeat in step with every phone.
- **One native binary on the host.** Capture, Opus, transport, local playback
  and the terminal dashboard are a single Swift executable, with no Node
  runtime or helper processes.
- **Shared memory to the speaker.** In the browser, decoded audio is written
  into a SharedArrayBuffer ring that the AudioWorklet reads on the realtime
  thread: no copies, no message ports, and main-thread jank cannot touch
  playback. An adaptive delay budget trims itself to the smallest value the
  room's weakest listener can carry.
- **Sessions are server state.** A signed token cannot be revoked and cannot
  stop two hosts claiming one room, so ownership lives in D1 with explicit
  takeover, and an hourly cron sweeps expired sessions and orphaned audio.
- **The player has no buttons.** A joined phone is a speaker, not a remote:
  every control is a way for one device to end up out of step with the others.

## Components

```text
  Music app  ───┐
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
     │  · time server            │
     │  · queue + arm barrier    │
     │  · live relay (tagged)    │
     └───────────────────────────┘
                │
   ┌────────────┼────────────┐
   ▼            ▼            ▼
 iPhone       iPad          Mac        shared-memory ring,
                                       indexed by stream sample
```

| Path | Contents |
| --- | --- |
| `src/worker/index.ts` | Router, sessions, host tokens, R2 range serving, cron sweep |
| `src/worker/room-do.ts` | Durable Object: WebSocket hub, time server, arm barrier, live relay |
| `src/shared/validate.ts` | Shape and size checks for every request body, header and socket message |
| `src/audio/clock.ts` | Room clock: Cristian's algorithm, min-RTT filtering, slew |
| `src/audio/engine.ts` | Decode-ahead playback, drift control, live player |
| `src/audio/room.ts` | Connection, reconnect, state reconciliation |
| `public/live-processor.js` | AudioWorklet reading the shared-memory ring |
| `cli/Sources/downbeat/` | Host binary: tap, Opus, transport, local playback, dashboard, QR |
| `migrations/` | D1 schema |

## HTTP API and limits

| Request | Auth | Answers |
| --- | --- | --- |
| `GET /api/health` | none | `{ ok, service, build }` |
| `POST /api/rooms` `{ passphrase, code?, takeover?, sourceLabel? }` | passphrase | `{ code, hostToken, expiresAt, tookOver }`; `401` wrong passphrase, `409` room already hosted (retry with `takeover: true`), `503` no `HOST_PASSPHRASE` secret |
| `POST /api/rooms/end` `{ code, hostToken }` | host token | `{ ok }`; frees the code at once |
| `GET /api/ws?code=&name=&role=&hostToken=` | none to listen, host token for `host` / `source` | WebSocket; `426` without an upgrade, `400` bad code |
| `POST /api/upload?code=&hostToken=` | host token | `{ track }`; `415` not an audio type, `413` over 25 MB, `400` empty |
| `GET`/`HEAD /audio/<id>` | none (ids are 128 bits of a SHA-256) | the file, with range support and edge caching |

Known paths with the wrong method answer `405`, unknown `/api/*` paths `404`.
A failure inside the Worker answers `500 {"error":"internal error"}`; the
cause is logged, not returned.

A host token is `code.expiry.HMAC`, valid for 24 hours, and only while it is
the session on record in D1: ending the room or a takeover invalidates it.

Everything a client sends is checked in `src/shared/validate.ts` before it is
stored or relayed:

| What | Limit |
| --- | --- |
| JSON body of `/api/rooms`, `/api/rooms/end` | 4 kB, must be an object |
| Upload | 25 MB, enforced while reading, also without `Content-Length` |
| Track title / source label / device name | 120 / 80 / 24 characters, control characters removed |
| Track duration, seek target | 0 to 86,400 s |
| Queue | 200 tracks, ids must be upload ids (32 hex digits) |
| Socket text frame | 64 kB; anything that is not a JSON object is ignored |
| Live audio frame | 256 kB, accepted from the verified source socket only |
| Telemetry | finite numbers only; other values count as not reported |
| Host commands | checked field by field; a malformed one is answered with a non-fatal `error` |

## How the synchronization works

**The clock.** Each client probes the Durable Object over its WebSocket: send
`t0`, the DO replies with `t1`, the client stamps `t2`.

```
offset = t1 − (t0 + t2) / 2        rtt = t2 − t0
```

Only probes close to the fastest round trip are used, because a slow round trip
has more room to hide the path asymmetry that Cristian's algorithm cannot see.
The estimate is stepped during the opening burst and slewed afterwards.

Two details matter on Cloudflare specifically:

- Workers **freeze `Date.now()` between I/O** as a Spectre mitigation. In a
  WebSocket handler the message arrival *is* that I/O, so the timestamp is
  fresh, provided it is taken before any other work. It is the first statement
  of the handler.
- **A shared clock error cancels.** Sync is relative: if the DO clock is 40 ms
  from UTC, every device is 40 ms from UTC together and they still agree with
  each other. Only per-device jitter matters, and min-RTT filtering removes it.

**Scheduling.** `getOutputTimestamp()` pairs a context time with the moment that
sample reaches the output, so it already includes the hardware latency. The
mapping collapses to one scalar, `ctx = room/1000 + k`.

**Live playback** writes decoded audio into a SharedArrayBuffer ring indexed by
absolute stream sample, read directly by the AudioWorklet on the realtime audio
thread (the pages are served cross-origin isolated to allow this). Scheduling
each 20 ms packet as its own source node would put the clock mapping in the
signal path fifty times a second, and its jitter would become audible gaps
between packets. With the ring, the mapping only decides *where* audio lands,
and the output itself stays continuous.

## Measurements

Taken on 2026-08-23 against a production deployment. See
[CHANGELOG.md](../CHANGELOG.md) for the conditions of each measurement.

| What | Measured |
| --- | ---: |
| Steady-state drift, 100 ppm crystal, simulated hour | < 0.01 ms |
| Between two devices with opposite crystals | < 0.01 ms |
| Room-clock spread across three clients, 90 probes each | 0.47 ms |
| Inter-device playout spread, 4 min, ±110 ppm crystals | 2.4 ms median |
| Accumulation (first half vs. second half) | none measured |
| Live stream over 4 minutes, packets late | 0 of 11,980 |
| Distinct start instants across 3 clients (file mode) | 1 |
| Opus packet rate / bitrate | 50 /s, ~110 kbit/s |

The drift figures come from simulation; the inter-device figures come from
three virtual clients running the real clock estimator and control law against
a deployed server and a real capture source. Their harness loop is a JS timer
rather than an audio clock, so it adds some jitter. No calibrated acoustic
measurement across physical devices has been taken: these numbers describe the
timing pipeline, not the air in the room, where 34 cm of distance is already a
millisecond.

## Design choices

- **No Spotify Web API.** Downbeat captures the Mac's audio output instead, so
  it works with any app and needs no API access or per-listener accounts.
- **No phone as source.** `getDisplayMedia` does not deliver audio in mobile
  browsers, and there is no other route to system audio on iOS or Android. The
  host is a Mac.
- **No WebRTC.** WebRTC minimizes latency and tolerates drift, resampling
  independently per peer. Downbeat instead accepts a fixed delay and aims for
  identical playout instants.
- **No per-device latency slider in the player.** Timing is the engine's job.
  The per-device offset exists in the engine, at zero, as the hook Bluetooth
  speakers will need.
- **No claim of perfect synchronization.** Sound travels 34 cm per millisecond,
  so two speakers three meters apart are ~9 ms apart at a listener regardless
  of the software. Downbeat removes the software error; the room is the room.
