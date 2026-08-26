import Foundation

/// Encodes a few seconds of live capture and reports what actually comes out,
/// so the wire format is proven before anything is built on top of it.
func runSelfTest(pid: pid_t?, seconds: Double) -> Never {
    let tap = ProcessTap()
    let encoder: OpusEncoder
    let collected = Collector()

    do {
        try tap.start(pid: pid, mute: false) { samples, frames, _ in
            collected.append(samples, frames: frames)
        }
    } catch {
        FileHandle.standardError.write("selftest: \(error)\n".data(using: .utf8)!)
        exit(1)
    }

    do {
        encoder = try OpusEncoder(sampleRate: tap.format.sampleRate, channels: tap.format.channels)
    } catch {
        FileHandle.standardError.write("selftest: \(error)\n".data(using: .utf8)!)
        tap.stop(); exit(1)
    }

    print("Format          \(Int(tap.format.sampleRate)) Hz, \(tap.format.channels) ch")
    print("framesPerPacket \(encoder.framesPerPacket)  (= \(String(format: "%.1f", Double(encoder.framesPerPacket) / tap.format.sampleRate * 1000)) ms)")
    print("collecting \(Int(seconds)) s ...")
    Thread.sleep(forTimeInterval: seconds)
    tap.stop()

    let (buf, frames) = collected.take()
    var packets: [Data] = []
    do {
        try buf.withUnsafeBufferPointer { p in
            guard let base = p.baseAddress else { return }
            packets = try encoder.encode(base, frames: frames)
        }
    } catch {
        FileHandle.standardError.write("selftest: \(error)\n".data(using: .utf8)!)
        exit(1)
    }

    let bytes = packets.reduce(0) { $0 + $1.count }
    let audioSeconds = Double(frames) / tap.format.sampleRate
    let sizes = packets.map(\.count).sorted()

    print("captured     \(String(format: "%.2f", audioSeconds)) s (\(frames) frames)")
    print("packets         \(packets.count)")
    if !packets.isEmpty {
        print("packet size     min \(sizes.first!) / median \(sizes[sizes.count/2]) / max \(sizes.last!) bytes")
        print("Bitrate         \(String(format: "%.0f", Double(bytes) * 8 / audioSeconds / 1000)) kbit/s")
        print("message rate    \(String(format: "%.0f", Double(packets.count) / audioSeconds)) /s")
        let expected = Int(audioSeconds * tap.format.sampleRate) / encoder.framesPerPacket
        print("completeness    \(packets.count)/\(expected) packets")
        print(packets.count >= expected - 1 ? "PASS  the encoder produces a gapless stream"
                                            : "FAIL  packets are missing")
        exit(packets.count >= expected - 1 ? 0 : 1)
    }
    print("FAIL  no packets produced")
    exit(1)
}

final class Collector: @unchecked Sendable {
    private var storage: [Float] = []
    private var frames = 0
    private let lock = NSLock()

    func append(_ src: UnsafePointer<Float>, frames n: Int) {
        lock.lock(); defer { lock.unlock() }
        storage.append(contentsOf: UnsafeBufferPointer(start: src, count: n * 2))
        frames += n
    }
    func take() -> ([Float], Int) {
        lock.lock(); defer { lock.unlock() }
        return (storage, frames)
    }
}
