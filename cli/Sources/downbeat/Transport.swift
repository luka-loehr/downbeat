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
    /// Set once the socket is open; sends are pointless before that.
    private(set) var linked = false
    /// Frames handed to a dead socket, i.e. audio that reached nobody.
    private(set) var droppedFrames = 0
    /// Sends the socket itself rejected. Ignoring these hid a dead stream
    /// behind a healthy-looking packet counter.
    private(set) var sendErrors = 0
    private(set) var lastSendError = ""
    /// Frames handed to the socket but not yet acknowledged.
    private(set) var inFlight = 0
    /// Messages the socket has handed us. If this stops climbing while sends
    /// keep succeeding, the connection is half-open and the stream is going
    /// nowhere -- which is invisible from the send side alone.
    private(set) var received = 0
    private(set) var receiveArmed = false
    private var attempt = 0
    private var reopening = false
    var onOpen: (@Sendable () -> Void)?
    /// Connection state changes, for the host display.
    var onLink: (@Sendable (Bool, String) -> Void)?
    /**
     Member updates, as a Sendable snapshot.

     These callbacks fire on the URLSession delegate queue, never on the main
     actor. Handing a closure an `[[String: Any]]` there let the compiler infer
     main-actor isolation for the closure body, and Swift 6 verifies that at
     runtime: the first state broadcast after a device joined trapped the
     process on a queue assertion. Marking the callbacks `@Sendable` and passing
     a Sendable value makes that mistake unrepresentable rather than merely
     unlikely.
     */
    struct MemberSnapshot: Sendable {
        let count: Int
        let spreadMs: Double
        /// The member array, already encoded, so no dictionary crosses threads.
        let json: String
    }
    var onMembers: (@Sendable (MemberSnapshot) -> Void)?

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
        linked = true
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
        receiveArmed = true
        task?.receive { [weak self] result in
            self?.receiveArmed = false
            guard let self, self.running else { return }
            switch result {
            case .failure(let error):
                // A dropped socket used to end the stream silently: sends kept
                // being handed to a dead task and the packet counter kept
                // rising, so the host looked healthy while nobody heard
                // anything. Reconnect, and say so.
                self.linked = false
                self.onLink?(false, error.localizedDescription)
                self.scheduleReopen()
            case .success(let message):
                self.received += 1
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func scheduleReopen() {
        guard running, !reopening else { return }
        reopening = true
        attempt += 1
        let delay = min(pow(2.0, Double(attempt)) * 0.25, 8.0)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.running else { return }
            self.reopening = false
            self.task?.cancel()
            self.reconnect()
        }
    }

    /// Re-open the same room. The room code and token outlive the socket.
    private func reconnect() {
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
        task.resume()
        receive()
        linked = true
        attempt = 0
        onLink?(true, "wieder verbunden")
        onOpen?()
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
            let speakers = members.filter { ($0["role"] as? String) != "source" }
            var spread = 0.0
            let playouts = speakers.compactMap { $0["playoutMs"] as? Double }
            if playouts.count > 1, let lo = playouts.min(), let hi = playouts.max() {
                spread = hi - lo
            }
            let encoded = (try? JSONSerialization.data(withJSONObject: speakers))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            onMembers?(MemberSnapshot(count: speakers.count, spreadMs: spread, json: encoded))
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
        guard linked, let task else {
            droppedFrames += 1
            return
        }
        var frame = Data(capacity: 16 + packet.count)
        withUnsafeBytes(of: playAtRoomMs.bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: Double(sampleIndex).bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        frame.append(packet)
        inFlight += 1
        task.send(.data(frame)) { [weak self] error in
            guard let self else { return }
            self.inFlight -= 1
            if let error {
                self.sendErrors += 1
                self.lastSendError = error.localizedDescription
            }
        }
    }
}
