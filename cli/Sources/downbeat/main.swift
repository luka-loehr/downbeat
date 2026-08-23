import Foundation
import CoreAudio

// Line-buffer stdout: piped into a log or a pipeline, Swift block-buffers and
// the status lines only appear once the process ends, which is useless.
setvbuf(stdout, nil, _IOLBF, 0)

/*
 downbeat -- host a Downbeat room from a Mac, with Spotify (or anything else
 this machine plays) as the source.

 The model in one line: capture is stamped on the room clock, every device
 plays it `--buffer` milliseconds later, and this Mac is just one more speaker
 obeying the same rule.
 */

struct Options {
    var pid: pid_t?          // nil = whole system
    var sourceLabel = "Spotify"
    var bufferMs: Double = 2000
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
            } else {
                o.pid = findProcess(named: v); o.sourceLabel = v
            }
        case "--buffer":
            i += 1
            if i < args.count, let ms = Double(args[i]) { o.bufferMs = ms }
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
            print("""
            downbeat login              Passphrase einmalig hinterlegen
            downbeat logout             hinterlegte Passphrase löschen
            downbeat host [Optionen]

              --source <app|system|pid>  Quelle (Standard: spotify)
              --buffer <ms>              Verzögerung, Standard 2000
              --code <ABC123>            fester Raumcode statt zufällig
              --takeover                 laufende Session dieses Codes übernehmen
              --passphrase <wort>        Host-Passphrase (sonst Schlüsselbund)
              --url <https://...>        Server (oder DOWNBEAT_URL)
              --no-mute                  Quelle lokal NICHT stummschalten
              --no-local                 auf diesem Mac nicht mitspielen
              --offline                  nur lokal, kein Raum
            """)
            exit(0)
        default: break
        }
        i += 1
    }
    if o.sourceLabel == "Spotify" && o.pid == nil { o.pid = findProcess(named: "Spotify") }
    return o
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
    FileHandle.standardError.write("downbeat: \(message)\n".data(using: .utf8)!)
    exit(1)
}

// ------------------------------------------------------------------ run

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
    guard let passphrase = Credentials.prompt("Host-Passphrase für \(host): ") else {
        die("keine Passphrase eingegeben")
    }
    // Verify before storing, so a typo is caught now and not at the party.
    let probe = Transport(baseURL: url, clock: RoomClock())
    do { try probe.createRoom(passphrase: passphrase) }
    catch { die("Anmeldung fehlgeschlagen — \(error)") }
    guard Credentials.save(passphrase, host: host) else { die("Keychain hat abgelehnt") }
    print("angemeldet an \(host) — die Passphrase liegt jetzt im Schlüsselbund")
    exit(0)
case "logout":
    let (_, host) = serverHost(from: Array(CommandLine.arguments))
    Credentials.delete(host: host)
    print("abgemeldet von \(host)")
    exit(0)
default:
    break
}

if CommandLine.arguments.dropFirst().first == "selftest-qr" {
    let sample = "https://downbeat.lukaloehr.com/r/ABC123"
    guard let modules = TerminalQR.modules(for: sample) else {
        die("QR konnte nicht erzeugt werden")
    }
    print(TerminalQR.render(modules))
    print("Module          \(modules.count)x\(modules.first?.count ?? 0)")
    let decoded = TerminalQR.decodes(modules, to: sample)
    print("zurückdekodiert \(decoded ?? "NICHTS")")
    print(decoded == sample ? "PASS  das gedruckte Muster ist ein scanbarer QR-Code"
                            : "FAIL  Muster ist nicht lesbar")
    exit(decoded == sample ? 0 : 1)
}

let options = parseOptions()

if options.pid == nil && options.sourceLabel != "System" {
    die("\(options.sourceLabel) läuft nicht — starte es und spiel etwas ab.")
}
var passphrase = options.passphrase
if !options.offline && passphrase.isEmpty {
    passphrase = Credentials.load(host: options.baseURL.host ?? "downbeat") ?? ""
}
if !options.offline && passphrase.isEmpty {
    die("nicht angemeldet. Einmal `downbeat login` ausführen.")
}

nonisolated(unsafe) let clock = RoomClock()
nonisolated(unsafe) let tap = ProcessTap()
let ring = RingBuffer(seconds: max(8, options.bufferMs / 1000 * 3), sampleRate: 48000, channels: 2)

final class Stats: @unchecked Sendable {
    var peak: Float = 0
    var captured: Int64 = 0
    var sent: Int64 = 0
    var bytes: Int64 = 0
    let lock = NSLock()
}
let stats = Stats()

nonisolated(unsafe) var player: LocalPlayer?
nonisolated(unsafe) var transport: Transport?
nonisolated(unsafe) var anchorLocalMs: Double = 0
nonisolated(unsafe) var anchored = false

// ---- room ----------------------------------------------------------------

if !options.offline {
    let t = Transport(baseURL: options.baseURL, clock: clock)
    do {
        try t.createRoom(passphrase: passphrase, code: options.code,
                         takeover: options.takeover, sourceLabel: options.sourceLabel)
    } catch { die("\(error)") }
    t.connect()
    transport = t
}

// ---- capture -------------------------------------------------------------

do {
    try tap.start(pid: options.pid, mute: options.mute) { samples, frames, hostTime in
        if !anchored {
            anchorLocalMs = RoomClock.localMs(hostTime: hostTime)
            anchored = true
        }
        // The player is created after the tap, so the first callbacks may find
        // it missing. Keep offering the anchor until it has been taken --
        // setting it once on the wrong side of that race left the player
        // unanchored forever, which reads as "the Mac plays nothing".
        if let p = player, !p.anchored {
            p.anchorLocalMs = anchorLocalMs
            p.anchored = true
        }
        ring.write(samples, frames: frames)
        stats.lock.lock()
        stats.captured += Int64(frames)
        let n = frames * 2
        for i in 0..<n { let a = abs(samples[i]); if a > stats.peak { stats.peak = a } }
        stats.lock.unlock()
    }
} catch {
    die("\(error)")
}

let rate = tap.format.sampleRate
let channels = tap.format.channels

if options.playLocally {
    let p = LocalPlayer(ring: ring, clock: clock, sampleRate: rate,
                        channels: channels, bufferMs: options.bufferMs)
    if anchored {
        p.anchorLocalMs = anchorLocalMs
        p.anchored = true
    }
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

    let frameSize = encoder.framesPerPacket
    let buffer = options.bufferMs
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
            let packets = (try? encoder.encode(scratch, frames: frameSize)) ?? []
            for packet in packets {
                if !offsetPrimed { streamOffset = clock.offset; offsetPrimed = true }
                let target = clock.offset
                streamOffset += max(-maxStep, min(maxStep, target - streamOffset))
                // This packet's first sample was captured here:
                let captureRoomMs = anchorLocalMs
                    + Double(encoded) / rate * 1000
                    + streamOffset
                t.sendPacket(packet, playAtRoomMs: captureRoomMs + buffer)
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

// ---- report --------------------------------------------------------------

nonisolated func shutdown() {
    transport?.stopLive()
    transport?.endSession()
    transport?.close()
    player?.stop()
    tap.stop()
    print("\ngestoppt — Quelle ist wieder hörbar")
}

signal(SIGINT) { _ in shutdown(); exit(0) }
signal(SIGTERM) { _ in shutdown(); exit(0) }

print("")
print("  Quelle    \(options.sourceLabel)  \(Int(rate)) Hz, \(channels) ch")
print("  Puffer    \(Int(options.bufferMs)) ms")
print("  Lokal     \(options.mute ? "stummgeschaltet" : "hörbar")"
      + (options.playLocally ? ", Wiedergabe über Downbeat" : ", keine Wiedergabe"))
if let t = transport {
    print("")
    let joinURL = options.baseURL.appendingPathComponent("r").appendingPathComponent(t.code)
    if let modules = TerminalQR.modules(for: joinURL.absoluteString) {
        print("")
        print(TerminalQR.render(modules), terminator: "")
    }
    print("")
    print("  Kamera drauf halten  –  oder Code eingeben:")
    print("  \u{1b}[1m\(t.code)\u{1b}[0m   \((joinURL.host ?? "") + joinURL.path)")
} else {
    print("  Modus     offline (nur dieser Mac)")
}
print("\n  Strg-C zum Beenden\n")

let started = RoomClock.localNow()
while true {
    Thread.sleep(forTimeInterval: 1)
    stats.lock.lock()
    let peak = stats.peak, captured = stats.captured, sent = stats.sent, bytes = stats.bytes
    stats.peak = 0
    stats.lock.unlock()

    let db = peak > 0 ? String(format: "%6.1f dBFS", 20 * log10(peak)) : "  -inf dBFS"
    let secs = max(1, Int((RoomClock.localNow() - started) / 1000))
    let kbits = Double(bytes) * 8 / Double(secs) / 1000
    let sync = transport == nil ? "offline"
        : (clock.isSynced ? String(format: "±%.1fms", clock.uncertainty) : "sync…")
    print(String(format: "  %@  aufgenommen %5.1fs  Pakete %5d  %5.0f kbit/s  Uhr %@  starved %d",
                 db, Double(captured) / rate, sent, kbits, sync, player?.starvedFrames ?? 0))
}
