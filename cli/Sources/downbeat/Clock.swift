import Foundation
import CoreAudio
import Synchronization

/**
 The room clock, CLI side.

 Identical in spirit to `SyncedClock` in the browser: Cristian's algorithm over
 the room WebSocket, min-RTT filtering, slew rather than step. Until it is fed
 by a connection it simply reports local monotonic time, which is exactly right
 for a Mac playing to itself.

 Everything is expressed in milliseconds on the mach monotonic timebase, so a
 wall-clock correction mid-song cannot move playback.
 */
final class RoomClock: @unchecked Sendable {
    private struct Sample { let rtt: Double; let offset: Double }

    private let lock = NSLock()
    private var samples: [Sample] = []
    private var applied: Double = 0
    private var hasApplied = false

    private static let burst = 20
    private static let window = 60
    private static let stepThresholdMs = 250.0
    private static let maxSlewMs = 4.0
    private static let rttAcceptFactor = 1.5
    private static let rttAcceptSlackMs = 2.0

    /// Local monotonic milliseconds. The CLI's `performance.now()`.
    static func localNow() -> Double {
        Double(AudioConvertHostTimeToNanos(mach_absolute_time())) / 1_000_000
    }

    /// Convert a Core Audio host timestamp to the local monotonic ms domain.
    static func localMs(hostTime: UInt64) -> Double {
        Double(AudioConvertHostTimeToNanos(hostTime)) / 1_000_000
    }

    func now() -> Double { RoomClock.localNow() + offset }

    var offset: Double {
        lock.lock(); defer { lock.unlock() }
        return applied
    }

    var isSynced: Bool {
        lock.lock(); defer { lock.unlock() }
        return hasApplied && samples.count >= 4
    }

    /// Uncertainty in ms: the spread of the probes we chose to believe.
    var uncertainty: Double {
        lock.lock(); defer { lock.unlock() }
        let kept = accepted()
        guard kept.count > 1 else { return 0 }
        let offs = kept.map(\.offset)
        return ((offs.max() ?? 0) - (offs.min() ?? 0)) / 2
    }

    func onPong(t0: Double, t1: Double) {
        let t2 = RoomClock.localNow()
        let rtt = t2 - t0
        guard rtt >= 0 else { return }
        lock.lock(); defer { lock.unlock() }
        samples.append(Sample(rtt: rtt, offset: t1 - (t0 + t2) / 2))
        if samples.count > Self.window { samples.removeFirst() }
        update()
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        samples.removeAll()
        hasApplied = false
    }

    // Callers already hold the lock.
    private func accepted() -> [Sample] {
        guard let minRtt = samples.map(\.rtt).min() else { return [] }
        let limit = minRtt * Self.rttAcceptFactor + Self.rttAcceptSlackMs
        let kept = samples.filter { $0.rtt <= limit }
        return kept.isEmpty ? [samples[samples.count - 1]] : kept
    }

    private func update() {
        let kept = accepted()
        guard !kept.isEmpty else { return }
        let target = median(kept.map(\.offset))

        // Still learning during the opening burst: step freely, nothing plays yet.
        if !hasApplied || samples.count <= Self.burst {
            applied = target
            hasApplied = true
            return
        }

        // Suspend/resume leaves the whole window describing a world that no
        // longer exists; if the recent probes agree against us, drop history.
        let recent = samples.suffix(4)
        if recent.count == 4 {
            let above = recent.allSatisfy { $0.offset - applied > Self.stepThresholdMs }
            let below = recent.allSatisfy { applied - $0.offset > Self.stepThresholdMs }
            if above || below {
                samples = Array(recent)
                applied = median(recent.map(\.offset))
                return
            }
        }

        let err = target - applied
        if abs(err) > Self.stepThresholdMs {
            applied = target
        } else {
            applied += max(-Self.maxSlewMs, min(Self.maxSlewMs, err))
        }
    }
}

func median(_ xs: [Double]) -> Double {
    guard !xs.isEmpty else { return 0 }
    let s = xs.sorted()
    let mid = s.count / 2
    return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
