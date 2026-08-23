import Foundation

/// Creates a room over HTTP and then holds the WebSocket that carries both the
/// clock probes and the audio.
final class Transport: NSObject, @unchecked Sendable {
    private let baseURL: URL
    private let clock: RoomClock
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var probeTimer: Thread?
    private var running = false
    private var burstLeft = 20

    private(set) var code = ""
    private(set) var hostToken = ""
    var onOpen: (() -> Void)?
    /// Full member list, so the host can see who is connected and how well.
    var onMembers: (([[String: Any]]) -> Void)?

    init(baseURL: URL, clock: RoomClock) {
        self.baseURL = baseURL
        self.clock = clock
        super.init()
        session = URLSession(configuration: .default)
    }

    enum TransportError: Error, CustomStringConvertible {
        case http(Int, String)
        case badResponse
        case alreadyHosted(String)
        var description: String {
            switch self {
            case .http(let c, let b): "Server antwortete \(c): \(b)"
            case .badResponse: "unerwartete Antwort vom Server"
            case .alreadyHosted(let code):
                "Raum \(code) wird bereits bespielt. Mit --takeover übernehmen."
            }
        }
    }

    /// Ask the Worker for a room. Requires the host passphrase. Passing `code`
    /// claims that specific room instead of taking whatever is generated.
    func createRoom(passphrase: String, code requested: String? = nil,
                    takeover: Bool = false, sourceLabel: String? = nil) throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/rooms"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: Any] = ["passphrase": passphrase, "takeover": takeover]
        if let requested { payload["code"] = requested }
        if let sourceLabel { payload["sourceLabel"] = sourceLabel }
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(String, String), Error>?
        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error { result = .failure(error); return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if status == 409 {
                let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                result = .failure(TransportError.alreadyHosted(obj?["code"] as? String ?? "?"))
                return
            }
            guard status == 200,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let code = obj["code"] as? String,
                  let token = obj["hostToken"] as? String
            else {
                result = .failure(status == 200 ? TransportError.badResponse
                                                : TransportError.http(status, body))
                return
            }
            result = .success((code, token))
        }.resume()
        semaphore.wait()

        switch result {
        case .success(let (code, token)): self.code = code; self.hostToken = token
        case .failure(let error): throw error
        case .none: throw TransportError.badResponse
        }
    }

    func connect() {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/ws"),
                                       resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "http" ? "ws" : "wss"
        components.queryItems = [
            .init(name: "code", value: code),
            .init(name: "role", value: "source"),
            .init(name: "name", value: "Mac (Quelle)"),
            .init(name: "hostToken", value: hostToken),
        ]
        let task = session.webSocketTask(with: components.url!)
        self.task = task
        running = true
        task.resume()
        receive()

        // Clock probes: a fast opening burst, then a slow keepalive.
        let thread = Thread { [weak self] in
            while let self, self.running {
                self.sendPing()
                let interval = self.burstLeft > 0 ? 0.04 : 2.0
                if self.burstLeft > 0 { self.burstLeft -= 1 }
                Thread.sleep(forTimeInterval: interval)
            }
        }
        thread.name = "downbeat.clock"
        thread.start()
        probeTimer = thread
        onOpen?()
    }

    func close() {
        running = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// Hand the room back so its code is immediately reusable. Best effort: a
    /// session left open simply expires on its own.
    func endSession() {
        guard !code.isEmpty, !hostToken.isEmpty else { return }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/rooms/end"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["code": code, "hostToken": hostToken])
        let semaphore = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { _, _, _ in semaphore.signal() }.resume()
        _ = semaphore.wait(timeout: .now() + 2)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self, self.running else { return }
            switch result {
            case .failure:
                self.running = false
            case .success(let message):
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["t"] as? String else { return }
        if type == "pong", let t0 = obj["t0"] as? Double, let t1 = obj["t1"] as? Double {
            clock.onPong(t0: t0, t1: t1)
            return
        }
        if type == "state" || type == "welcome",
           let state = obj["state"] as? [String: Any],
           let members = state["members"] as? [[String: Any]] {
            // The source is in the member list too; the host cares about speakers.
            onMembers?(members.filter { ($0["role"] as? String) != "source" })
        }
    }

    private func sendPing() {
        send(json: ["t": "ping", "t0": RoomClock.localNow()])
    }

    func announceLive(sampleRate: Double, channels: Int, frameSize: Int,
                      bufferMs: Double, sourceLabel: String) {
        send(json: ["t": "cmd", "cmd": [
            "c": "liveStart",
            "live": [
                "sampleRate": sampleRate,
                "channels": channels,
                "frameSize": frameSize,
                "bufferMs": bufferMs,
                "sourceLabel": sourceLabel,
            ],
        ]])
    }

    func stopLive() {
        send(json: ["t": "cmd", "cmd": ["c": "liveStop"]])
    }

    private func send(json object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    /**
     One wire frame: play instant, sample index, then the packet.

     The receiver places audio by `sampleIndex`, never by the timestamp: the
     index is exact and monotonic, so consecutive packets land exactly their own
     length apart. Deriving position from the timestamp instead lets every
     fractional clock correction round into a one-sample hole, which is audible
     as a crackle fifty times a second.
     */
    func sendPacket(_ packet: Data, playAtRoomMs: Double, sampleIndex: Int64) {
        var frame = Data(capacity: 16 + packet.count)
        withUnsafeBytes(of: playAtRoomMs.bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: Double(sampleIndex).bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        frame.append(packet)
        task?.send(.data(frame)) { _ in }
    }
}
