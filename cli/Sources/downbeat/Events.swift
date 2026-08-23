import Foundation

/**
 Machine-readable output for the terminal UI.

 The Swift core owns capture, timing and transport; the UI is a separate
 process that only draws. Keeping the boundary at a line of JSON means the
 audio path never waits on a render.

 Writes are non-blocking, and that is not a detail. `print` on a full pipe
 blocks until the reader catches up, and a UI that stalls -- or a consumer that
 never reads at all -- would then stall the thread emitting the event. Since
 events are emitted from the WebSocket handler, that stalls the clock, which
 stalls the stream. Telemetry must never be able to stop the music, so a write
 that cannot complete is dropped instead.
 */
enum Events {
    nonisolated(unsafe) static var enabled = false
    private static let lock = NSLock()
    nonisolated(unsafe) private static var configured = false
    nonisolated(unsafe) private static var dropped = 0

    private static func configureIfNeeded() {
        guard !configured else { return }
        configured = true
        let flags = fcntl(STDOUT_FILENO, F_GETFL, 0)
        _ = fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK)
    }

    static func emit(_ object: [String: Any]) {
        guard enabled else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }

        writeLine(String(data: data, encoding: .utf8) ?? "")
    }

    private static func writeLine(_ text: String) {
        guard enabled, !text.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        configureIfNeeded()

        var line = Data(text.utf8)
        line.append(0x0A)
        line.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let n = write(STDOUT_FILENO, base + offset, raw.count - offset)
                if n > 0 {
                    offset += n
                    continue
                }
                // EAGAIN: the reader is behind. Dropping a status line costs
                // nothing; blocking here would cost the audio stream.
                dropped += 1
                return
            }
        }
    }

    /// Emit a pre-encoded JSON array under a key, avoiding a re-parse.
    static func emitRaw(_ type: String, _ fields: [String: Any], jsonKey: String, json: String) {
        guard enabled else { return }
        var parts: [String] = ["\"t\":\(quote(type))"]
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            if let n = v as? Double { parts.append("\(quote(k)):\(n)") }
            else if let n = v as? Int { parts.append("\(quote(k)):\(n)") }
            else if let b = v as? Bool { parts.append("\(quote(k)):\(b)") }
            else { parts.append("\(quote(k)):\(quote(String(describing: v)))") }
        }
        parts.append("\(quote(jsonKey)):\(json)")
        writeLine("{" + parts.joined(separator: ",") + "}")
    }

    private static func quote(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    static func log(_ level: String, _ message: String) {
        emit(["t": "log", "level": level, "msg": message])
    }

    /// Events discarded because the UI could not keep up.
    static var droppedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return dropped
    }
}
