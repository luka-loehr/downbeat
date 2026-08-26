import Foundation
import CoreAudio
import Accelerate
import Synchronization

// Line-buffer stdout: piped into a log or a pipeline, Swift block-buffers and
// the status lines only appear once the process ends, which is useless.
setvbuf(stdout, nil, _IOLBF, 0)

/*
 downbeat -- host a Downbeat room from a Mac, with Spotify (or anything else
 this machine plays) as the source.

 One native binary: capture, encode, transport, local playback and the
 terminal dashboard all live here. The model in one line: capture is stamped
 on the room clock, every device plays it `--buffer` milliseconds later, and
 this Mac is just one more speaker obeying the same rule.
 */

let VERSION = "0.4.0"

struct Options {
    var pid: pid_t?          // nil = whole system
    var sourceLabel = "Spotify"
    var bufferMs: Double = 2000
    /// Floor for the adaptive delay budget; the pipeline needs ~150 ms.
    var minBufferMs: Double = 350
    /// Adapt the budget at runtime from listener telemetry.
    var adapt = true
    var mute = true
    var playLocally = true
    var passphrase = ProcessInfo.processInfo.environment["DOWNBEAT_PASSPHRASE"] ?? ""
    var baseURL = URL(string: ProcessInfo.processInfo.environment["DOWNBEAT_URL"]
                      ?? "https://downbeat.lukaloehr.com")!
    var offline = false
    var code: String?
    var takeover = false
}

func parseOptions() -> Options {
    var o = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    if args.first == "host" { args.removeFirst() }

    var i = 0
    while i < args.count {
        switch args[i] {
        case "--source":
            i += 1
            let v = i < args.count ? args[i] : "spotify"
            if v.lowercased() == "system" {
                o.pid = nil; o.sourceLabel = "System"
            } else if let pid = pid_t(v) {
                o.pid = pid; o.sourceLabel = "PID \(pid)"
            } else if let found = AudioSources.find(named: v) {
                o.pid = found.pid; o.sourceLabel = found.name
            } else {
                o.pid = findProcess(named: v); o.sourceLabel = v
            }
        case "--buffer":
            i += 1
            if i < args.count, let ms = Double(args[i]) { o.bufferMs = ms }
        case "--min-buffer":
            i += 1
            if i < args.count, let ms = Double(args[i]) { o.minBufferMs = max(150, ms) }
        case "--no-adapt": o.adapt = false
        case "--passphrase":
            i += 1
            if i < args.count { o.passphrase = args[i] }
        case "--url":
            i += 1
            if i < args.count, let u = URL(string: args[i]) { o.baseURL = u }
        case "--code":
            i += 1
            if i < args.count { o.code = args[i].uppercased() }
        case "--takeover": o.takeover = true
        case "--no-mute": o.mute = false
        case "--no-local": o.playLocally = false
        case "--offline": o.offline = true
        case "-h", "--help":
            printHelp()
            exit(0)
        default: break
        }
        i += 1
    }
    if o.sourceLabel == "Spotify" && o.pid == nil {
        if let found = AudioSources.find(named: "Spotify") {
            o.pid = found.pid
        } else if let music = AudioSources.find(named: "Music") {
            // Nothing from Spotify, but Apple Music is playing -- take that
            // rather than refusing to start over a default nobody chose.
            o.pid = music.pid
            o.sourceLabel = music.name
        }
    }
    return o
}

func printHelp() {
    print("""
    downbeat — one song, every phone, the same millisecond

    COMMANDS
      downbeat host [options]      open a room and stream this Mac
      downbeat login               store the host passphrase once
      downbeat logout              forget the stored passphrase
      downbeat version             version

    OPTIONS FOR host
      --source <app|system|pid>  app name (Spotify, Music, …), "system"
                                 for everything, or a process id
      --buffer <ms>              starting delay budget, default 2000 —
                                 adapts at runtime toward the smallest
                                 value the room's listeners can carry
      --min-buffer <ms>          the adaptive budget's floor (350)
      --no-adapt                 pin the budget at --buffer
      --code <ABC123>            fixed room code instead of random
      --takeover                 take over a room already hosted
      --passphrase <word>        pass it directly instead of the store
      --url <https://...>        a different server
      --no-mute                  do NOT mute the source locally
      --no-local                 do not play on this Mac
      --offline                  local capture and playback only, no room

    KEYS WHILE HOSTING
      m    mute / unmute this Mac        + / -  this Mac's level
      s    switch source (1-8, a = everything, esc)
      q    quit

    DIAGNOSTICS
      downbeat selftest            Opus encoder against live capture
      downbeat selftest-qr         render a QR and decode it back
    """)
}

func findProcess(named name: String) -> pid_t? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-x", name]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    try? p.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (String(data: data, encoding: .utf8) ?? "")
        .split(separator: "\n").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }.first
}

func die(_ message: String) -> Never {
    Terminal.restore()
    FileHandle.standardError.write("downbeat: \(message)\n".data(using: .utf8)!)
    exit(1)
}

// ------------------------------------------------------------------ commands

if CommandLine.arguments.dropFirst().first == "selftest" {
    runSelfTest(pid: findProcess(named: "Spotify"), seconds: 3)
}

func serverHost(from args: [String]) -> (URL, String) {
    var url = URL(string: ProcessInfo.processInfo.environment["DOWNBEAT_URL"]
                  ?? "https://downbeat.lukaloehr.com")!
    if let i = args.firstIndex(of: "--url"), i + 1 < args.count,
       let override = URL(string: args[i + 1]) { url = override }
    return (url, url.host ?? "downbeat")
}

switch CommandLine.arguments.dropFirst().first {
case "login":
    let (url, host) = serverHost(from: Array(CommandLine.arguments))
    guard let passphrase = Credentials.prompt("Host passphrase for \(host): ") else {
        die("no passphrase entered")
    }
    // Verify before storing, so a typo is caught now and not at the party.
    let probe = Transport(baseURL: url, clock: RoomClock())
    do { try probe.createRoom(passphrase: passphrase) }
    catch { die("login failed — \(error)") }
    guard Credentials.save(passphrase, host: host) else { die("could not write \(Credentials.location)") }
    print("logged in to \(host) — passphrase stored in \(Credentials.location), readable only by you")
    exit(0)
case "logout":
    let (_, host) = serverHost(from: Array(CommandLine.arguments))
    Credentials.delete(host: host)
    print("logged out of \(host)")
    exit(0)
case "version", "-v", "--version":
    print("downbeat \(VERSION)")
    exit(0)
case "help", .none:
    printHelp()
    exit(0)
default:
    break
}

if CommandLine.arguments.dropFirst().first == "selftest-qr" {
    let sample = "https://downbeat.lukaloehr.com/r/ABC123"
    guard let modules = TerminalQR.modules(for: sample) else {
        die("could not generate the QR")
    }
    print(TerminalQR.render(modules))
    print("modules         \(modules.count)x\(modules.first?.count ?? 0)")
    let decoded = TerminalQR.decodes(modules, to: sample)
    print("decoded back    \(decoded ?? "NOTHING")")
    print(decoded == sample ? "PASS  the printed pattern is a scannable QR code"
                            : "FAIL  the pattern is not readable")
    exit(decoded == sample ? 0 : 1)
}

let options = parseOptions()

if options.pid == nil && options.sourceLabel != "System" {
    die("\(options.sourceLabel) is not running — start it and play something.")
}
var passphrase = options.passphrase
if !options.offline && passphrase.isEmpty {
    passphrase = Credentials.load(host: options.baseURL.host ?? "downbeat") ?? ""
}
if !options.offline && passphrase.isEmpty {
    die("not logged in. Run `downbeat login` once.")
}

// ------------------------------------------------------------------ state

let clock = RoomClock()
nonisolated(unsafe) let tap = ProcessTap()
let ring = RingBuffer(seconds: max(8, options.bufferMs / 1000 * 3), sampleRate: 48000, channels: 2)

/**
 The delay budget, live. Starts at `--buffer` and is then steered by the
 dashboard loop from listener telemetry: trimmed while every listener shows
 spare cushion, grown the moment one of them is struggling. Read by the
 encoder (into every packet's play instant) and mirrored into the local
 player, so this Mac and the phones move together.
 */
let adaptiveBufferMs = Atomic<UInt64>(options.bufferMs.bitPattern)
/// The budget's rails. An explicit --buffer above 2000 raises the ceiling.
let minBufferMs = min(options.minBufferMs, options.bufferMs)
let maxBufferMs = max(2000, options.bufferMs)

final class Stats: @unchecked Sendable {
    var peak: Float = 0
    var captured: Int64 = 0
    var sent: Int64 = 0
    var bytes: Int64 = 0
    /// One peak per capture callback (~10 ms), drained by the dashboard tick.
    var levels: [Float] = []
    let lock = NSLock()
}
let stats = Stats()

/// The dashboard's log panel; replaces stderr chatter while the UI is up.
final class UILog: @unchecked Sendable {
    private var lines: [(String, String)] = []
    private let lock = NSLock()
    private let clock = DateFormatter()
    init() { clock.dateFormat = "HH:mm:ss" }
    func add(_ msg: String) {
        lock.lock()
        lines.append((clock.string(from: Date()), msg))
        if lines.count > 120 { lines.removeFirst(lines.count - 120) }
        lock.unlock()
    }
    func snapshot() -> [(String, String)] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }
}
let uiLog = UILog()

final class MembersBox: @unchecked Sendable {
    private var list: [MemberInfo] = []
    private let lock = NSLock()
    func set(_ m: [MemberInfo]) { lock.lock(); list = m; lock.unlock() }
    func get() -> [MemberInfo] { lock.lock(); defer { lock.unlock() }; return list }
}
let membersBox = MembersBox()

/// Source-picker overlay state, shared between the key thread and the drawer.
final class PickerBox: @unchecked Sendable {
    private var sources: [AudioSource]? = nil
    private let lock = NSLock()
    func open(_ s: [AudioSource]) { lock.lock(); sources = s; lock.unlock() }
    func close() { lock.lock(); sources = nil; lock.unlock() }
    func get() -> [AudioSource]? { lock.lock(); defer { lock.unlock() }; return sources }
}
let picker = PickerBox()

nonisolated(unsafe) var player: LocalPlayer?
nonisolated(unsafe) var transport: Transport?
nonisolated(unsafe) var anchorLocalMs: Double = 0
nonisolated(unsafe) var anchored = false
nonisolated(unsafe) var stopping = false
/**
 Latest (host-time ms, frames-written) pair from the capture callback.

 The stream timeline is nominally `anchor + frames / rate`, but the capture
 device runs on its own crystal: at 10 ppm that mapping is 36 ms wrong after
 an hour and 360 ms after ten. This pair is the measurement that lets both the
 encoder and the local player correct for it. Packed into one double-wide
 atomic so a reader can never pair a fresh time with a stale frame count.
 */
let captureProgress = Atomic<WordPair>(WordPair(first: 0, second: 0))
/// Scratch for the clamp path; sized well beyond any device's buffer.
nonisolated(unsafe) var clampBuffer = [Float](repeating: 0, count: 16384)

// ---- room ----------------------------------------------------------------

if !options.offline {
    let t = Transport(baseURL: options.baseURL, clock: clock)
    do {
        try t.createRoom(passphrase: passphrase, code: options.code,
                         takeover: options.takeover, sourceLabel: options.sourceLabel)
    } catch { die("\(error)") }
    t.onLink = { @Sendable up, reason in
        uiLog.add(up ? "reconnected" : "connection lost: \(reason)")
    }
    t.onMembers = { @Sendable snapshot in
        membersBox.set(snapshot.members)
    }
    t.connect()
    transport = t
    uiLog.add("room \(t.code) open")
}

// ---- capture -------------------------------------------------------------

/**
 The capture callback. Runs on a realtime audio thread: it may allocate
 nothing, lock nothing that another thread holds for long, and above all never
 block. Everything it touches is either atomic, the lock-free ring, or vDSP
 over preallocated buffers.
 */
@Sendable func captureCallback(_ samples: UnsafePointer<Float>, _ frames: Int, _ hostTime: UInt64) {
    let localMs = RoomClock.localMs(hostTime: hostTime)
    if !anchored {
        anchorLocalMs = localMs
        anchored = true
    }
    if let p = player, !p.anchored {
        p.anchorLocalMs = anchorLocalMs
        p.anchored = true
    }
    // Real progress: at host time `localMs`, exactly this many frames existed.
    // The buffer's own hardware timestamp, not the time this thread ran.
    captureProgress.store(
        WordPair(first: UInt(localMs.bitPattern),
                 second: UInt(bitPattern: Int(ring.framesWritten))),
        ordering: .releasing)
    // Capturing the whole system sums every app, and two players at once
    // routinely exceeds full scale -- measured +6.7 dBFS with Music and
    // Spotify together. Opus handles out-of-range samples badly, so clamp
    // before anything downstream sees them. Peak scan and clamp are vDSP:
    // vectorised, allocation-free, realtime-safe.
    let n = frames * 2
    var localPeak: Float = 0
    vDSP_maxmgv(samples, 1, &localPeak, vDSP_Length(n))

    if localPeak > 1 {
        clampBuffer.withUnsafeMutableBufferPointer { buf in
            guard let base = buf.baseAddress, buf.count >= n else { return }
            var lo: Float = -1
            var hi: Float = 1
            vDSP_vclip(samples, 1, &lo, &hi, base, 1, vDSP_Length(n))
            ring.write(base, frames: frames)
        }
    } else {
        ring.write(samples, frames: frames)
    }

    stats.lock.lock()
    stats.captured += Int64(frames)
    if localPeak > stats.peak { stats.peak = localPeak }
    stats.levels.append(localPeak)
    if stats.levels.count > 400 { stats.levels.removeFirst(stats.levels.count - 400) }
    stats.lock.unlock()
}

do {
    try tap.start(pid: options.pid, mute: options.mute) { @Sendable s, f, h in
        captureCallback(s, f, h)
    }
} catch {
    die("\(error)")
}

let rate = tap.format.sampleRate
let channels = tap.format.channels

/**
 How far the nominal-rate stream timeline has drifted from the capture
 device's real progress, in ms. Positive means the device is running slow.

 Fed to the encoder (into the packet timestamps, slewed) and to the local
 player (into its read target, slewed at the same limit), so this Mac and
 every phone keep aiming at the same instant no matter how long the session
 runs or how honest the capture crystal is.
 */
@Sendable func timelineErrorMs() -> Double {
    guard anchored else { return 0 }
    let pair = captureProgress.load(ordering: .acquiring)
    guard pair.first != 0 else { return 0 }
    let hostMs = Double(bitPattern: UInt64(pair.first))
    let frames = Double(Int(bitPattern: pair.second))
    return hostMs - (anchorLocalMs + frames / rate * 1000)
}

if options.playLocally {
    let p = LocalPlayer(ring: ring, clock: clock, sampleRate: rate,
                        channels: channels, bufferMs: options.bufferMs)
    if anchored {
        p.anchorLocalMs = anchorLocalMs
        p.anchored = true
    }
    p.timelineError = { timelineErrorMs() }
    player = p
    do { try p.start() } catch { tap.stop(); die("\(error)") }
}

// ---- encode and ship -----------------------------------------------------
//
// Encoding runs on its own thread, not in the capture callback: the callback is
// a realtime audio thread and has no business allocating or blocking. The ring
// is the hand-off, and the encoder simply walks it in order.

nonisolated(unsafe) var encoderThread: Thread?

if let t = transport {
    let encoder: OpusEncoder
    do { encoder = try OpusEncoder(sampleRate: rate, channels: channels) }
    catch { tap.stop(); die("\(error)") }

    // Wait briefly for the opening clock burst so the first packets are stamped
    // against a settled offset rather than a guess.
    let deadline = Date().addingTimeInterval(2.0)
    while !clock.isSynced && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }

    t.announceLive(sampleRate: rate, channels: channels,
                   frameSize: encoder.framesPerPacket, bufferMs: options.bufferMs,
                   sourceLabel: options.sourceLabel)

    // The encoder is owned solely by the thread below; nothing else touches it.
    nonisolated(unsafe) let ownedEncoder = encoder
    let frameSize = encoder.framesPerPacket
    // The room clock corrects itself in steps of up to 4 ms. Reading it directly
    // per packet would stamp that step straight into the stream timeline, and a
    // 4 ms step between two 20 ms packets is a 4 ms hole -- an audible click on
    // every device at once. So the stream keeps its own offset and walks it
    // toward the clock slowly enough that consecutive packets stay contiguous.
    let maxDriftMsPerSecond = 2.0
    let thread = Thread {
        var encoded: Int64 = 0
        var streamOffset = clock.offset
        var offsetPrimed = false
        let packetSeconds = Double(frameSize) / rate
        let maxStep = maxDriftMsPerSecond * packetSeconds
        let scratch = UnsafeMutablePointer<Float>.allocate(capacity: frameSize * channels)
        defer { scratch.deallocate() }
        while true {
            guard anchored, ring.framesWritten >= encoded + Int64(frameSize) else {
                Thread.sleep(forTimeInterval: 0.005); continue
            }
            ring.read(into: scratch, from: encoded, frames: frameSize)
            let packets = (try? ownedEncoder.encode(scratch, frames: frameSize)) ?? []
            for packet in packets {
                if !offsetPrimed { streamOffset = clock.offset; offsetPrimed = true }
                // Two corrections share the walk: the room-clock offset, and
                // the drift of the nominal-rate timeline against the capture
                // device's real progress. Folding the second one in is what
                // stops the whole room sliding against real time -- and
                // eating the delay budget -- over a many-hour session.
                let target = clock.offset + timelineErrorMs()
                streamOffset += max(-maxStep, min(maxStep, target - streamOffset))
                // This packet's first sample was captured here:
                let captureRoomMs = anchorLocalMs
                    + Double(encoded) / rate * 1000
                    + streamOffset
                let buffer = Double(bitPattern: adaptiveBufferMs.load(ordering: .relaxed))
                t.sendPacket(packet, playAtRoomMs: captureRoomMs + buffer, sampleIndex: encoded)
                stats.lock.lock()
                stats.sent += 1
                stats.bytes += Int64(packet.count)
                stats.lock.unlock()
            }
            encoded += Int64(frameSize)
        }
    }
    thread.name = "downbeat.encoder"
    thread.stackSize = 512 * 1024
    thread.start()
    encoderThread = thread
}

// ---- runtime source switching ---------------------------------------------

/// Guards a swap against a second one arriving while the first is in flight.
let switching = Atomic<Bool>(false)
nonisolated(unsafe) var currentLabel = options.sourceLabel

/**
 Point the capture at a different app without interrupting the room.

 The stream keeps its identity across the swap: same room, same sample
 timeline, same listeners. Only what is being recorded changes.
 */
@Sendable func switchSource(pid: pid_t?, label: String) {
    guard !switching.exchange(true, ordering: .acquiring) else { return }
    defer { switching.store(false, ordering: .releasing) }

    tap.stop()
    // Pad the silence of the swap so stream position keeps tracking the clock.
    if anchored {
        let expected = Int64((RoomClock.localMs(hostTime: mach_absolute_time())
                              - anchorLocalMs) / 1000 * 48000)
        let behind = expected - ring.framesWritten
        if behind > 0 { ring.writeSilence(frames: Int(min(behind, 48000 * 4))) }
    }

    do {
        try tap.start(pid: pid, mute: options.mute) { @Sendable samples, frames, hostTime in
            captureCallback(samples, frames, hostTime)
        }
        currentLabel = label
        uiLog.add("source: \(label)")
    } catch {
        uiLog.add("source switch failed: \(error)")
        // Put the previous source back rather than leaving the room silent.
        try? tap.start(pid: options.pid, mute: options.mute) { @Sendable s, f, h in
            captureCallback(s, f, h)
        }
    }
}

// ---- shutdown -------------------------------------------------------------

nonisolated func shutdown() {
    stopping = true
    transport?.stopLive()
    transport?.endSession()
    transport?.close()
    player?.stop()
    tap.stop()
    Terminal.restore()
    print("stopped — the source is audible again")
}

signal(SIGINT) { _ in shutdown(); exit(0) }
signal(SIGTERM) { _ in shutdown(); exit(0) }

// ---- keys ------------------------------------------------------------------

if Terminal.isInteractive {
    Terminal.enter()
    let keys = Thread {
        while !stopping {
            guard let key = Terminal.readKey() else { continue }
            switch key {
            case .escape:
                picker.close()
            case .char(let c):
                let k = Character(String(c).lowercased())
                if picker.get() != nil {
                    if k == "a" {
                        picker.close()
                        switchSource(pid: nil, label: "System")
                        continue
                    }
                    if let d = k.wholeNumberValue, d >= 1,
                       let sources = picker.get(), d <= sources.count {
                        let chosen = sources[d - 1]
                        picker.close()
                        switchSource(pid: chosen.pid, label: chosen.name)
                        continue
                    }
                }
                switch k {
                case "q", "\u{3}":
                    shutdown()
                    exit(0)
                case "m":
                    if let p = player { p.gain = p.gain > 0 ? 0 : 1 }
                case "+", "=":
                    if let p = player { p.gain = min(1, p.gain + 0.1) }
                case "-", "_":
                    if let p = player { p.gain = max(0, p.gain - 0.1) }
                case "s":
                    if picker.get() == nil {
                        picker.open(Array(AudioSources.list().prefix(8)))
                    } else {
                        picker.close()
                    }
                default:
                    break
                }
            }
        }
    }
    keys.name = "downbeat.keys"
    keys.start()
}

// ---- dashboard loop --------------------------------------------------------

let qrModules: [[Bool]]? = transport.flatMap { t in
    TerminalQR.modules(for: options.baseURL.appendingPathComponent("r")
        .appendingPathComponent(t.code).absoluteString)
}
let joinHost: String = transport.map { t in
    let u = options.baseURL.appendingPathComponent("r").appendingPathComponent(t.code)
    return (u.host ?? "") + u.path
} ?? "offline — this Mac only"

/// Aim to keep the weakest listener's WORST ring cushion this healthy. The
/// cushion is measured at the point of consumption, so decode latency,
/// hardware output latency and every jitter dip are already inside it.
let safeCushionMs = 250.0
/// Trim at a third of the 0.3 % steady correction ceiling, so every device
/// tracks the moving schedule with authority to spare. Growth deliberately
/// exceeds the steady ceiling -- it is an emergency -- but stays inside the
/// 1 % recovery band, slewed on the shared value rather than stepped.
let trimMsPerSecond = 1.0
let growMsPerSecond = 6.0
let tick = 0.2
var lastUnderrunTotal = 0
var levelHistory: [Double] = []
let started = RoomClock.localNow()
var lastPlainPrint = 0.0

while true {
    Thread.sleep(forTimeInterval: tick)

    // ---- adaptive delay budget -------------------------------------------
    if options.adapt, let t = transport {
        let current = Double(bitPattern: adaptiveBufferMs.load(ordering: .relaxed))
        let cushion = t.minListenerCushionMs
        if !cushion.isNaN {
            var target = current + (safeCushionMs - cushion)
            let underruns = t.totalListenerUnderruns
            if underruns > lastUnderrunTotal { target = max(target, current + 300) }
            lastUnderrunTotal = underruns
            target = min(max(target, minBufferMs), maxBufferMs)
            let delta = target - current
            // The deadband keeps measurement noise from rocking the budget.
            if abs(delta) > 40 {
                let slew = delta > 0 ? growMsPerSecond : trimMsPerSecond
                let step = min(abs(delta), slew * tick)
                let next = current + (delta > 0 ? step : -step)
                adaptiveBufferMs.store(next.bitPattern, ordering: .relaxed)
                player?.bufferMs = next
            }
        }
    }

    // ---- gather ----------------------------------------------------------
    stats.lock.lock()
    let peak = stats.peak
    let captured = stats.captured
    let sent = stats.sent
    let bytes = stats.bytes
    let drained = stats.levels
    stats.peak = 0
    stats.levels.removeAll(keepingCapacity: true)
    stats.lock.unlock()

    for level in drained {
        levelHistory.append(level > 0 ? 20 * log10(Double(level)) : -120)
    }
    if levelHistory.count > 1024 { levelHistory.removeFirst(levelHistory.count - 1024) }

    let secs = max(1, Int((RoomClock.localNow() - started) / 1000))
    let members = membersBox.get()

    if Terminal.isInteractive {
        var state = DashboardState()
        state.source = currentLabel
        state.uptimeSec = secs
        state.code = transport?.code ?? "OFFLINE"
        state.joinHost = joinHost
        state.qr = qrModules
        state.peakDb = peak > 0 ? 20 * log10(Double(peak)) : -120
        state.levelsDb = levelHistory
        state.clockMs = clock.uncertainty
        state.synced = clock.isSynced
        state.offline = options.offline
        state.bufferMs = Double(bitPattern: adaptiveBufferMs.load(ordering: .relaxed))
        state.cushionMs = transport?.minListenerCushionMs ?? .nan
        state.timelineErrMs = timelineErrorMs()
        state.kbits = Double(bytes) * 8 / Double(secs) / 1000
        state.packets = sent
        state.starved = player?.starvedFrames ?? 0
        state.gain = player?.gain ?? 0
        state.muted = (player?.gain ?? 1) == 0
        state.members = members
        state.log = uiLog.snapshot()
        state.picker = picker.get()
        state.stopping = stopping

        let linked = transport?.linked ?? true
        if options.offline {
            state.phase = "LOCAL"
        } else if !linked {
            state.phase = "RECONNECTING"; state.phaseBad = true
        } else if !clock.isSynced {
            state.phase = "SYNCING"
        } else if members.isEmpty {
            state.phase = "READY"
        } else {
            state.phase = "IN SYNC"
        }

        Terminal.write(Dashboard.render(state))
    } else {
        // Piped or logged: one plain line a second, no escape codes.
        let now = RoomClock.localNow()
        if now - lastPlainPrint >= 1000 {
            lastPlainPrint = now
            let db = peak > 0 ? String(format: "%6.1f dBFS", 20 * log10(Double(peak))) : "  -inf dBFS"
            let sync = transport == nil ? "offline"
                : (clock.isSynced ? String(format: "±%.1fms", clock.uncertainty) : "sync…")
            let buf = Double(bitPattern: adaptiveBufferMs.load(ordering: .relaxed))
            print(String(format: "  %@  captured %5.1fs  packets %5d  %5.0f kbit/s  clock %@  buffer %4.0fms  starved %d",
                         db, Double(captured) / rate, sent,
                         Double(bytes) * 8 / Double(secs) / 1000, sync, buf,
                         player?.starvedFrames ?? 0))
        }
    }
}
