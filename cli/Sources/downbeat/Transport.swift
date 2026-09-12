import Foundation
import Synchronization

/// Creates a room over HTTP and then holds the WebSocket that carries both the
/// clock probes and the audio.
final class Transport: NSObject, @unchecked Sendable {
    private let baseURL: URL
    private let clock: RoomClock
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var probeTimer: Thread?
    /// Read by the probe thread and socket callbacks, written on close.
    private let runningFlag = Atomic<Bool>(false)
    private var running: Bool { runningFlag.load(ordering: .relaxed) }
    private var burstLeft = 20

    private(set) var code = ""
    private(set) var hostToken = ""
    /// Set once the socket is open; sends are pointless before that. Written
    /// on the socket queue and the probe thread, read by the encoder thread
    /// fifty times a second and by the dashboard -- atomic, not luck.
    private let linkedFlag = Atomic<Bool>(false)
    var linked: Bool { linkedFlag.load(ordering: .relaxed) }
    /// Frames handed to a dead socket, i.e. audio that reached nobody.
    private(set) var droppedFrames = 0
    /// Sends the socket itself rejected. Ignoring these hid a dead stream
    /// behind a healthy-looking packet counter.
    private(set) var sendErrors = 0
    private(set) var lastSendError = ""
    /// Frames handed to the socket but not yet acknowledged. Incremented on
    /// the encoder thread, decremented on the URLSession queue: as a plain
    /// Int the lost updates only ever drifted UP, and once the drift reached
    /// the in-flight cap every packet was dropped forever -- a stream that
    /// dies silently hours in, with a healthy-looking dashboard.
    private let inFlightCount = Atomic<Int>(0)
    var inFlight: Int { inFlightCount.load(ordering: .relaxed) }
    /// Messages the socket has handed us. If this stops climbing while sends
    /// keep succeeding, the connection is half-open and the stream is going
    /// nowhere -- which is invisible from the send side alone.
    private(set) var received = 0
    private(set) var receiveArmed = false
    private var attempt = 0
    private var reopening = false
    /// Pings go out every 2 s, so a healthy link never stays silent this long.
    private static let staleAfterMs = 8000.0
    /// Written on the socket queue, read by the probe thread.
    private let lastReceivedBits = Atomic<UInt64>(RoomClock.localNow().bitPattern)
    private var lastReceivedMs: Double {
        get { Double(bitPattern: lastReceivedBits.load(ordering: .relaxed)) }
        set { lastReceivedBits.store(newValue.bitPattern, ordering: .relaxed) }
    }
    /// The last liveStart announcement, kept so a reconnect can repeat it --
    /// the Durable Object drops the live state when a source socket dies, and
    /// without a re-announce every listener would keep discarding our packets.
    private var liveAnnounce: [String: Any]?
    /// Identifies THIS run of the stream across reconnects. A listener that
    /// never noticed the outage sees the same epoch and keeps playing; a
    /// restarted CLI gets a new one, which tells listeners to start over.
    private let liveEpoch = Date().timeIntervalSince1970 * 1000
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
        let members: [MemberInfo]
    }
    var onMembers: (@Sendable (MemberSnapshot) -> Void)?

    /// Guards the listener-telemetry aggregates below: written on the socket
    /// queue, read by the adaptive-budget loop and the dashboard tick.
    private let teleLock = NSLock()
    private var _minListenerMarginMs = Double.nan
    private var _minListenerCushionMs = Double.nan
    private var _totalListenerUnderruns = 0
    /// Last cumulative underrun count per member name; see the note below.
    private var underrunBaselines: [String: Double] = [:]

    /// Smallest live-arrival margin any listener reports, ms. Diagnostic only:
    /// arrival margin hides decode and hardware latency. NaN = no reports.
    var minListenerMarginMs: Double {
        teleLock.lock(); defer { teleLock.unlock() }; return _minListenerMarginMs
    }
    /// Smallest worst-case ring cushion any listener reports, ms -- the least
    /// audio anyone actually had in hand recently, and therefore the adaptive
    /// delay budget's steering signal. NaN = nobody is reporting one yet.
    var minListenerCushionMs: Double {
        teleLock.lock(); defer { teleLock.unlock() }; return _minListenerCushionMs
    }
    /// Monotonic count of listener underruns SINCE THIS SOURCE HAS KNOWN each
    /// listener. Clients report lifetime-cumulative counts, but the steering
    /// question is "did anyone fall behind since last time" -- so a joining
    /// device's opening number is a baseline, not news. Summing raw counts
    /// made every join look like an emergency and grew the room's latency.
    var totalListenerUnderruns: Int {
        teleLock.lock(); defer { teleLock.unlock() }; return _totalListenerUnderruns
    }

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
            case .http(let c, let b): "server replied \(c): \(b)"
            case .badResponse: "unexpected response from the server"
            case .alreadyHosted(let code):
                "room \(code) is already being hosted. Use --takeover to take it."
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

        // A box rather than a captured `var`: the semaphore below does order
        // the write before the read, but the compiler cannot see that, and a
        // warning about concurrent mutation is not something to leave standing
        // in a file that has already produced one real isolation crash.
        final class Box: @unchecked Sendable {
            var value: Result<(String, String), Error>?
        }
        let box = Box()
        let semaphore = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error { box.value = .failure(error); return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if status == 409 {
                let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                box.value = .failure(TransportError.alreadyHosted(obj?["code"] as? String ?? "?"))
                return
            }
            guard status == 200,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let code = obj["code"] as? String,
                  let token = obj["hostToken"] as? String
            else {
                box.value = .failure(status == 200 ? TransportError.badResponse
                                                  : TransportError.http(status, body))
                return
            }
            box.value = .success((code, token))
        }.resume()
        semaphore.wait()

        switch box.value {
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
            .init(name: "name", value: "Mac (source)"),
            .init(name: "hostToken", value: hostToken),
        ]
        let task = session.webSocketTask(with: components.url!)
        self.task = task
        runningFlag.store(true, ordering: .relaxed)
        linkedFlag.store(true, ordering: .relaxed)
        lastReceivedMs = RoomClock.localNow()
        task.resume()
        receive()

        // Clock probes: a fast opening burst, then a slow keepalive.
        let thread = Thread { [weak self] in
            while let self, self.running {
                self.sendPing()
                // A dead network rarely closes the socket: sends keep being
                // accepted while nothing comes back, and the OS can take
                // minutes to notice. Pongs answer within one interval, so a
                // silent stretch this long means the link is gone -- reopen
                // it instead of waiting to be told.
                if self.linked, RoomClock.localNow() - self.lastReceivedMs > Self.staleAfterMs {
                    self.linkedFlag.store(false, ordering: .relaxed)
                    self.onLink?(false, "nothing received for \(Int(Self.staleAfterMs / 1000)) s")
                    self.scheduleReopen()
                }
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
        runningFlag.store(false, ordering: .relaxed)
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
        let current = task
        current?.receive { [weak self] result in
            // A callback from a task that has already been replaced must be
            // ignored: acting on it would tear down the healthy successor.
            guard let self, self.running, current === self.task else { return }
            self.receiveArmed = false
            switch result {
            case .failure(let error):
                // A dropped socket used to end the stream silently: sends kept
                // being handed to a dead task and the packet counter kept
                // rising, so the host looked healthy while nobody heard
                // anything. Reconnect, and say so.
                self.linkedFlag.store(false, ordering: .relaxed)
                self.onLink?(false, error.localizedDescription)
                self.scheduleReopen()
            case .success(let message):
                self.received += 1
                // Only a message proves the path works -- resetting the
                // backoff any earlier turns a dead network into a hot loop.
                self.attempt = 0
                self.lastReceivedMs = RoomClock.localNow()
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
            .init(name: "name", value: "Mac (source)"),
            .init(name: "hostToken", value: hostToken),
        ]
        let task = session.webSocketTask(with: components.url!)
        self.task = task
        task.resume()
        receive()
        linkedFlag.store(true, ordering: .relaxed)
        lastReceivedMs = RoomClock.localNow()
        // The new socket may ride a completely different network path, and the
        // old probe history would then outvote the truth for minutes. Start
        // over with a fresh burst; the encoder's slewed stream offset turns
        // whatever the estimate does into an inaudible ramp.
        clock.reset()
        burstLeft = 20
        // The DO dropped the live state when the old socket died, and told
        // every listener to stop. Announce the stream again -- same epoch, so
        // a listener that never noticed the outage keeps playing untouched.
        if let announce = liveAnnounce { send(json: announce) }
        onLink?(true, "reconnected")
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

            // A device whose context clock is not running at wall-clock rate
            // measured everything it reports with a broken ruler. Left in, its
            // runaway underrun count trips the emergency budget growth every
            // tick and pins the whole room at maximum latency; its cushion is
            // fiction in whichever direction the clock broke. Steer only by
            // the healthy devices, and let the dashboard show the sick one.
            // A cushion beyond a minute is the other face of the same fault:
            // the clock's RATE is fine but its read head has lost the stream
            // (no genuine ring holds a minute of audio), and `stuck` is the
            // device's own verdict that it has tried re-anchoring and failed.
            func fault(_ m: [String: Any]) -> AudioFault? {
                if let r = m["ctxRate"] as? Double, abs(r - 1) > 0.1 { return .clock(rate: r) }
                if let c = m["cushionMs"] as? Double, c > 60_000 { return .cushion(ms: c) }
                if m["stuck"] as? Bool == true { return .stuck }
                return nil
            }
            let healthy = speakers.filter { fault($0) == nil }

            var spread = 0.0
            let playouts = healthy.compactMap { $0["playoutMs"] as? Double }
            if playouts.count > 1, let lo = playouts.min(), let hi = playouts.max() {
                spread = hi - lo
            }
            let margins = healthy.compactMap { $0["marginMs"] as? Double }
            let cushions = healthy.compactMap { $0["cushionMs"] as? Double }
            teleLock.lock()
            _minListenerMarginMs = margins.min() ?? .nan
            _minListenerCushionMs = cushions.min() ?? .nan
            var baselines: [String: Double] = [:]
            for m in healthy {
                guard let name = m["name"] as? String,
                      let u = m["underruns"] as? Double else { continue }
                baselines[name] = u
                // A count below its baseline is a reloaded page starting over.
                if let prior = underrunBaselines[name], u > prior {
                    _totalListenerUnderruns += Int(u - prior)
                }
            }
            underrunBaselines = baselines
            teleLock.unlock()
            // Names arrive from strangers' phones and are drawn straight onto
            // the HOST's terminal: a control character in one is an escape-
            // sequence injection into the host's tty, not a display quirk.
            func safeName(_ raw: Any?) -> String {
                guard let raw = raw as? String else { return "Speaker" }
                let clean = String(String.UnicodeScalarView(
                    raw.unicodeScalars.filter {
                        // C0 controls, DEL and the C1 range: everything a
                        // terminal might interpret rather than display.
                        $0.value >= 0x20 && $0.value != 0x7f && !(0x80...0x9f).contains($0.value)
                    }))
                return clean.isEmpty ? "Speaker" : String(clean.prefix(24))
            }
            let infos = speakers.map { m in
                MemberInfo(
                    name: safeName(m["name"]),
                    role: m["role"] as? String ?? "listener",
                    rtt: m["rtt"] as? Double ?? 0,
                    sync: m["sync"] as? Double ?? 0,
                    cushionMs: m["cushionMs"] as? Double,
                    playoutMs: m["playoutMs"] as? Double,
                    ctxRate: m["ctxRate"] as? Double,
                    fault: fault(m))
            }
            onMembers?(MemberSnapshot(count: speakers.count, spreadMs: spread, members: infos))
        }
    }

    private func sendPing() {
        send(json: ["t": "ping", "t0": RoomClock.localNow()])
    }

    func announceLive(sampleRate: Double, channels: Int, frameSize: Int,
                      bufferMs: Double, sourceLabel: String) {
        let message: [String: Any] = ["t": "cmd", "cmd": [
            "c": "liveStart",
            "live": [
                "sampleRate": sampleRate,
                "channels": channels,
                "frameSize": frameSize,
                "bufferMs": bufferMs,
                "sourceLabel": sourceLabel,
                "epoch": liveEpoch,
            ],
        ]]
        liveAnnounce = message
        send(json: message)
    }

    func stopLive() {
        // Deliberate stop: a later reconnect must not resurrect the stream.
        liveAnnounce = nil
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
        // The in-flight cap bounds what a stalled network can queue: past ~2.5 s
        // of backlog every queued packet would arrive too late to be played
        // anyway, and an unbounded queue would grow for as long as a ten-hour
        // session keeps encoding into it.
        guard linked, inFlight < 128, let task else {
            droppedFrames += 1
            return
        }
        var frame = Data(capacity: 16 + packet.count)
        withUnsafeBytes(of: playAtRoomMs.bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: Double(sampleIndex).bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        frame.append(packet)
        inFlightCount.wrappingAdd(1, ordering: .relaxed)
        task.send(.data(frame)) { [weak self] error in
            guard let self else { return }
            self.inFlightCount.wrappingSubtract(1, ordering: .relaxed)
            if let error {
                self.sendErrors += 1
                self.lastSendError = error.localizedDescription
            }
        }
    }
}
