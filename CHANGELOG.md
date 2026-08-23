# Changelog

All notable changes to this project, with the conditions under which each
measurement was taken.

## [0.1.0] — 2026-08-23

First working system: file playback and live capture, both synchronised.

### Added
- Room clock over Durable Object WebSockets (Cristian's algorithm, min-RTT
  filtering, slew-not-step). Measured ±4.5 ms browser→edge over 40 probes.
- Arm barrier: no device is given a start instant until every device has the
  audio decoded. Verified with three clients receiving an identical `startAt`.
- Drift controller holding a 100 ppm crystal error under 1 ms, correcting via
  ±0.4 % playback rate (~7 cents, inaudible).
- `downbeat` CLI for macOS: Core Audio process tap, Opus encoding via
  AudioToolbox, terminal QR, Keychain-backed login.
- Live mode: 20 ms Opus packets at ~110 kbit/s, played from an AudioWorklet
  ring indexed by absolute output frame. Measured 0 gaps, 0 late packets,
  1868 ms median lead over an 8 s run.
- Host sessions in D1 with takeover semantics; hourly cron sweep of expired
  sessions and orphaned R2 objects.

### Fixed
- Stream timeline no longer inherits the room clock's 4 ms correction steps;
  a separate, slowly-slewed offset keeps consecutive packets contiguous.
- Capture anchor moved from room time to monotonic time, so a clock correction
  no longer drags the entire timeline with it.
- Local playback anchor is offered until taken, rather than once — the player
  is created after the tap starts, and losing that race left the Mac silent.
- Live playback moved off per-packet source-node scheduling, which put the
  room↔context mapping in the signal path 50 times a second and turned its
  jitter into audible gaps.
- Page content no longer depends on an animation clock advancing.
