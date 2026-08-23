# Changelog

All notable changes to this project, with the conditions under which each
measurement was taken.

## [0.2.0] — 2026-08-23

Zero steady-state drift, runtime control, and every browser.

### Added
- Runtime control from the terminal: mute the host (`m`), set its level
  (`+`/`-`) and switch capture source (`s`) without restarting the room.
  Sources are discovered from Core Audio and filtered to real applications, so
  Apple Music, Spotify, a browser tab or the whole system appear by themselves.
- Opus decoding in WebAssembly where WebCodecs is missing, so Firefox and Tor
  Browser work. Loaded as a separate chunk only where it is needed.
- Devices remember their speaker name and the room they were in.
- Room codes accept the glyphs people substitute when reading them aloud:
  O for zero, I and L for one.
- A build id shared by the Worker and the page, so a tab left open across a
  deploy reloads itself rather than running old audio code.

### Changed
- The drift controller gained an integral term. Proportional-only control
  cannot remove a constant disturbance, and a crystal offset is exactly that,
  so every device settled at a small but different residue — audible on sharp
  transients. Steady-state error at 100 ppm: 0.15 ms → **0.0000 ms**; spread
  between two devices with opposite crystals: 0.30 ms → **0.0000 ms**.
- Interpolation moved from linear to Catmull-Rom. Linear is a lowpass whose
  corner depends on the fractional offset, so two devices rounded the same
  transient differently.
- The clock filter was deliberately left alone: measured against 90 real probes
  per client, the existing window (min×1.5 + 2 ms, median) gives 0.47 ms spread
  across three clients, while every stricter variant tested was 3 ms or worse.
- Credentials moved from the Keychain to a 0600 file, because every Keychain
  read opened a dialog that made the CLI unusable unattended.
- The terminal UI is monochrome — bold, dim and inverse rather than hue — so it
  reads correctly on light and dark terminals. The QR keeps real black on real
  white, which a scanner needs. The waveform's automatic gain dropped from 8×
  to 3× with slower release and per-column smoothing.
- All interface text and documentation is English.

### Fixed
- The capture engine died the moment a device joined. `onMembers` ran on the
  URLSession delegate queue while the compiler had inferred main-actor
  isolation from surrounding top-level code, and Swift 6 verifies that at
  runtime. Sends kept succeeding into the dead socket and the packet counter
  kept climbing, so the host looked healthy while listeners received nothing.
- Live playback anchored on a clock that had not converged yet, fixing a
  joining device to a position that could be hundreds of milliseconds wrong.
- The audio context is resumed when live playback starts and when the tab
  becomes visible. A host handover already recovered at the protocol level, but
  the hardware had been suspended underneath — which is why it appeared to need
  a page reload.
- Telemetry writes are non-blocking; a stalled UI could previously stall the
  audio thread.
- The CLI transport reconnects instead of failing silently, and no longer
  counts frames handed to a dead socket.
- Capturing the whole system is clamped: two players at once measured
  +6.7 dBFS, which Opus handles badly.

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
