# Changelog

All notable changes to this project, with the conditions under which each
measurement was taken.

## [0.3.1] — 2026-08-26

The crackle, the warble, and the minute of being out of sync — all three
traced to root cause by control-loop analysis and closed.

### Fixed
- **Crackle on every listener while the host stayed clean.** The adaptive
  budget steered on *arrival* margin, which never sees decode latency,
  hardware output latency (up to ~250 ms on Bluetooth) or jitter dips — so it
  trimmed until the read head grazed the freshest write and every graze was a
  click. The worklet now measures its own **worst-case ring cushion** every
  quantum, listeners report the minimum over a rolling window, and the budget
  keeps the weakest listener's worst dip at 250 ms. Arrival margin remains as
  a diagnostic.
- **Rate-control saturation (warble, and the host running ahead).** The trim
  rate (2 ms/s) exactly equalled the steady correction ceiling (0.2 %), so
  every device saturated, ratcheted to the 20 ms recovery threshold and
  oscillated between 3.5 and 17 cents of correction, each lagging the moving
  schedule by its own excess — the host least, so it led. The ceiling is now
  0.3 % (≈5 cents, still inaudible) on both the worklet and the Mac, the trim
  is 1 ms/s — a third of the authority — and growth is 6 ms/s slewed on the
  shared value instead of a 25 ms/s step that exceeded even recovery
  authority. An unsaturated PI tracks a ramp with zero steady-state error
  (ζ≈0.94), so the schedule moves and nobody lags it.
- **"Completely out of sync, fine a minute later."** A locked or interrupted
  phone resumes with its audio clock frozen behind the room clock; the
  room↔context mapping was only allowed to crawl back at 10 ms/s, so the
  worklet hard-jumped to a *wrong* position and then audibly slewed for up to
  a minute — or, after a 30 s lock, landed outside the ring entirely:
  silence, the "reload the page" case. Three consecutive mapping measurements
  disagreeing by >30 ms now **step** the mapping to their median, re-anchor
  the stream once, and tell the worklet to snap in one clean jump. The clock
  itself re-bursts the moment the tab or audio context wakes, stepping the
  offset within one round trip instead of confirming a jump over 8 s of
  keepalives — resume-to-in-sync is now under a second.
- A context that refuses 48 kHz no longer desyncs at thousands of frames per
  second with a hidden pitch shift: all ring positions, sync targets and
  thresholds are in stream samples, and the read head advances at the
  stream/context rate ratio.
- A mid-song rejoin whose track download fails now retries on the next state
  broadcast instead of staying silent for the whole track.
- A dislocated listener's polluted margin history is re-seeded on re-lock, so
  one sleeping phone can no longer inflate the whole room's latency; a packet
  older than a ring rotation can no longer overwrite audio near the read head.

## [0.3.0] — 2026-08-26

The delay budget steers itself, and every device follows the source's real
timeline instead of a first impression of it.

### Added
- **An adaptive delay budget.** Every listener now reports how far ahead of
  its deadline packets arrive and whether its ring ever ran dry; the host
  trims the budget while the weakest listener still has ~300 ms in hand
  (2 ms/s — inside every drift controller's inaudible band) and grows it an
  order of magnitude faster the moment anyone struggles. `--buffer` is now
  the starting value, `--min-buffer` the floor (default 350 ms), `--no-adapt`
  pins it. The terminal shows the budget moving.
- Listeners follow the stamped timeline, not the anchor line. A device used
  to extrapolate its first packet at exactly nominal rate forever, so the
  stamps — which move when the budget adapts and as the timeline is
  disciplined to the capture crystal — walked away from it (~36 ms per hour
  per 10 ppm, and the whole point of adaptation would never have reached the
  ring). The residual is slewed into the sync target at ≤7.5 ms/s; a
  dislocation past 500 ms re-anchors once instead of slewing for minutes.

### Fixed
- Only a verified source socket may inject binary audio into a room; any
  listener could previously stream into the relay path.
- Browser reconnects are jittered so a room full of phones dropped by one
  outage does not stampede back in a single synchronised wave, and a
  WebSocket constructor that throws no longer ends the retry chain.

## [0.2.2] — 2026-08-26

Reconnection that actually reconnects, on every side of the wire.

### Fixed
- **A CLI socket drop no longer kills the room for good.** When the source
  socket died, the server cleared the live state and told every listener to
  stop — and the reconnected CLI never announced the stream again, so it
  resumed sending packets every phone silently discarded. The CLI now stores
  its announcement and repeats it on every reconnect.
- **Half-open sockets are detected within seconds, not minutes.** A network
  that dies silently leaves the socket "open": sends keep succeeding and
  `close` may not fire for minutes, while nothing comes back. Both the CLI
  and the browser now notice an unanswered clock probe (probes flow every
  2 s) and force a reconnect — the browser pairs ping against pong rather
  than wall time, so a throttled background tab cannot condemn a healthy
  socket.
- **A fast source reconnect no longer races its own corpse.** The server only
  clears the live state when the closing socket was the *last* source; a
  replacement that connected before the old close event arrived keeps the
  stream alive, and listeners who never noticed the outage keep playing
  without a restart. Streams carry an epoch so a genuinely restarted CLI —
  a fresh sample timeline — still restarts every listener exactly once.
- **Joining or reconnecting mid-song now plays the song.** File-mode
  reconciliation only handled the arming phase, so a device arriving while
  the room was already playing sat silent until the next track — the
  "have to reload the page" bug. The schedule is now derived from room state,
  clamped to now, at the correct in-track position; a missed pause lands too.
- The CLI's reconnect backoff only resets once a message actually arrives,
  instead of on every attempt — a dead network is no longer a hot retry loop.
  Stale receive callbacks from a cancelled socket can no longer tear down the
  healthy replacement.

## [0.2.1] — 2026-08-26

The ten-hour session: every drift source that only shows up after hours is
now closed, and capturing the whole system no longer feeds Downbeat back
into itself.

### Fixed
- **System capture no longer loops.** The system-wide tap excluded no
  processes, so Downbeat's own local playback was captured again and replayed
  `bufferMs` later, forever. The tap now excludes the Downbeat process, which
  also exempts its output from the tap's mute — local monitoring stays audible
  while everything else is silenced at the speaker.
- **The Mac no longer saws against the phones.** Local playback advanced its
  read head with the output device's clock but placed it with the CPU clock,
  reconciling only when 30 ms apart — a sawtooth of up to 30 ms against the
  phones with an audible click at each reset, roughly hourly per 10 ppm of
  crystal difference. The read head is now fractional and steered every
  callback by the same PI law and constants as the browser worklet, with the
  same Catmull-Rom interpolation.
- **The stream timeline is disciplined to real capture progress.** Packet
  timestamps assumed the capture device delivers exactly nominal rate; per
  10 ppm of crystal error the whole room slid 36 ms per hour against real
  time, silently eating the delay budget on multi-hour sessions. The encoder
  now measures the drift against the capture buffers' own hardware timestamps
  and folds it into the existing slewed offset; the local player applies the
  identical correction, so Mac and phones keep aiming at the same instant
  indefinitely.
- Live playback could seed its room↔context mapping from a clock that had not
  converged when a binary frame beat the first pong to the socket handler —
  an offset error the mapping's deliberately sluggish slew could never walk
  off. The mapping is now only ever touched after the clock has converged.
- The CLI clock starts a fresh probe burst after a reconnect instead of
  letting the old path's history outvote the new path's truth for minutes.
- A stalled network can no longer queue unbounded audio in the CLI transport:
  past ~2.5 s of backlog, packets are dropped and counted rather than
  delivered too late to be played.
- Zeroing a ring hole after a long outage is bounded and vectorised in the
  worklet, so a listener returning from minutes offline cannot glitch the
  render thread.

### Changed
- Room state broadcasts are coalesced to at most one per 750 ms for telemetry,
  joins and leaves. With N devices each reporting every two seconds the old
  behaviour was N²/2 member-entries per second across the room — the actual
  ceiling on room size. Transport changes still broadcast immediately.
- The last German strings in the terminal UI and CLI are English.

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
