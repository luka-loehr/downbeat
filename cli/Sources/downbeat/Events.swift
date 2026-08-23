import Foundation

/**
 Machine-readable output for the Ink front end.

 The Swift core owns capture, timing and transport; the terminal UI is a
 separate process that only draws. Keeping the boundary as a line of JSON means
 the audio path never waits on a render, and the core stays usable on its own.
 */
enum Events {
    nonisolated(unsafe) static var enabled = false
    private static let lock = NSLock()

    static func emit(_ object: [String: Any]) {
        guard enabled else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        print(line)
        lock.unlock()
    }

    static func log(_ level: String, _ message: String) {
        emit(["t": "log", "level": level, "msg": message])
    }
}
