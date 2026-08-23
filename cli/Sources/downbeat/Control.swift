import Foundation

/**
 Runtime commands from the terminal UI, one JSON object per line on stdin.

 The UI is a separate process, so a keystroke has to travel somewhere. Reading
 stdin on its own thread keeps that path entirely off the audio and network
 threads: a command changes a value and returns, and the realtime side picks it
 up on its next pass without ever waiting on anything.
 */
enum Control {
    /// Starts a reader thread. `handler` runs on that thread, never inline.
    static func listen(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
        let thread = Thread {
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty,
                      let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                handler(obj)
            }
        }
        thread.name = "downbeat.control"
        thread.stackSize = 128 * 1024
        thread.start()
    }
}
