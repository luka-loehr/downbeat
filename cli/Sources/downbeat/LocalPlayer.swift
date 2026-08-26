import Foundation
import CoreAudio
import AudioToolbox

/**
 Plays the captured stream back on this Mac, `bufferMs` behind capture, timed
 by the room clock rather than by buffer fill.

 That distinction is the whole point: the phones compute the very same
 "which sample belongs to this instant" from the very same clock, so the Mac is
 not a special case that happens to sound right -- it is just another speaker.

 And like the phones, the read head is STEERED, not snapped. The output device
 and the CPU clock run on different crystals, so an integer read position that
 only moves when it has drifted 30 ms produces a sawtooth: the Mac walks up to
 30 ms away from the phones over the better part of an hour, then clicks back.
 Instead the read position is fractional, advances at a rate, and that rate is
 corrected every callback by the same PI law the browser worklet uses -- the
 error is driven to zero continuously and inaudibly, for as long as the
 session runs.
 */

/// Proportional gain as a time constant: the error is erased over ~1.5 s.
private let TAU_S = 1.5
/// Integral time constant; what drives a constant crystal offset to ZERO.
private let TAU_INTEGRAL_S = 8.0
/// Steady-state correction ceiling: 0.2 % is ~3.5 cents, inaudible.
private let MAX_RATE_DEV = 0.002
/// After a real dislocation, pull harder rather than be out of step for a minute.
private let RECOVERY_RATE_DEV = 0.01
private let RECOVERY_THRESHOLD_S = 0.020
/// Beyond this, steering is hopeless -- jump once and count it honestly.
private let HARD_RESYNC_S = 0.5
/// The timeline correction may move the target this fast, ms per second --
/// the same limit the encoder applies, so Mac and phones track together.
private let MAX_CORRECTION_MS_PER_S = 2.0

final class LocalPlayer {
    private let ring: RingBuffer
    private let clock: RoomClock
    private let sampleRate: Double
    private let channels: Int
    /**
     Delay between capture and playout, ms. The adaptive budget rewrites it at
     runtime, slewed slowly enough that the PI controller below simply tracks
     the move -- read from the realtime IO proc, written from the status loop,
     atomic-width like `gain`.
     */
    nonisolated(unsafe) var bufferMs: Double

    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    /// Source span for interpolation, and the rendered output, both interleaved.
    private var scratch: UnsafeMutablePointer<Float>
    private var rendered: UnsafeMutablePointer<Float>
    private let scratchFrames = 4096
    /// The span read for interpolation is stretched by the recovery rate plus
    /// the cubic's neighbours, so its buffer is a little wider than the output.
    private let spanFrames = 4200

    /// Local monotonic time that capture frame 0 corresponds to. Set once by
    /// the tap. Deliberately not in room time: the clock offset keeps moving,
    /// and an anchor expressed in room time would move with it.
    var anchorLocalMs: Double = 0
    var anchored = false
    /**
     How far the nominal-rate timeline has drifted from the capture device's
     real progress, in ms. Read from the realtime IO proc, so it must be a
     plain non-blocking closure over atomics. The encoder folds the very same
     measurement into the packets it stamps, which is what keeps this Mac and
     every phone aiming at the same instant even after hours of crystal drift.
     */
    nonisolated(unsafe) var timelineError: (@Sendable () -> Double)?
    /// Frames that arrived too late to be played, for honest reporting.
    private(set) var starvedFrames: Int = 0
    /// Times steering was hopeless and the read head had to jump.
    private(set) var reanchors: Int = 0

    /**
     Output level for this Mac only, 0...1.

     Muting the host is a listening decision, not a transport one: the capture,
     the encode and every phone in the room carry on untouched. Read from the
     realtime IO proc and written from the control thread, so it is a plain
     Double behind atomic-width access rather than anything that could block
     the audio thread.
     */
    nonisolated(unsafe) var gain: Double = 1

    /// Fractional read position in absolute capture frames, and its rate.
    private var readPos: Double = 0
    private var playRate: Double = 1
    /// Accumulated error, in frame-seconds. See TAU_INTEGRAL_S.
    private var integral: Double = 0
    private var reading = false
    /// Slewed copy of `timelineError`, so a measurement step never becomes a click.
    private var correctionMs: Double = 0

    init(ring: RingBuffer, clock: RoomClock, sampleRate: Double, channels: Int, bufferMs: Double) {
        self.ring = ring
        self.clock = clock
        self.sampleRate = sampleRate
        self.channels = channels
        self.bufferMs = bufferMs
        self.scratch = .allocate(capacity: spanFrames * channels)
        self.scratch.initialize(repeating: 0, count: spanFrames * channels)
        self.rendered = .allocate(capacity: scratchFrames * channels)
        self.rendered.initialize(repeating: 0, count: scratchFrames * channels)
    }

    deinit {
        scratch.deallocate()
        rendered.deallocate()
    }

    enum PlayerError: Error, CustomStringConvertible {
        case noDefaultOutput(OSStatus)
        case ioProcFailed(OSStatus)
        case startFailed(OSStatus)
        var description: String {
            switch self {
            case .noDefaultOutput(let s): "no default output device (OSStatus \(s))"
            case .ioProcFailed(let s): "output IOProc failed (OSStatus \(s))"
            case .startFailed(let s): "output start failed (OSStatus \(s))"
            }
        }
    }

    func start() throws {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                            &addr, 0, nil, &size, &deviceID)
        guard st == noErr, deviceID != kAudioObjectUnknown else { throw PlayerError.noDefaultOutput(st) }

        let rate = sampleRate
        let chans = channels
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, nil) {
            [weak self] _, _, _, outOutputData, inOutputTime in
            guard let self else { return }
            let out = UnsafeMutableAudioBufferListPointer(outOutputData)
            guard self.anchored else { Self.silence(out); return }

            let frames = Int(out[0].mDataByteSize) / MemoryLayout<Float>.size
                / max(1, Int(out[0].mNumberChannels))
            let n = min(frames, self.scratchFrames)
            let dt = Double(n) / rate

            // Walk the correction toward the measured timeline error, slowly
            // enough that it can never be heard as a pitch step.
            let targetCorr = self.timelineError?() ?? 0
            let maxStep = MAX_CORRECTION_MS_PER_S * dt
            self.correctionMs += max(-maxStep, min(maxStep, targetCorr - self.correctionMs))

            // When will these samples actually be heard? Local domain on both
            // sides, so the room-clock offset cancels out entirely.
            let outLocalMs = RoomClock.localMs(hostTime: inOutputTime.pointee.mHostTime)
            let want = (outLocalMs - self.bufferMs - self.anchorLocalMs - self.correctionMs) / 1000 * rate

            if !self.reading {
                self.readPos = want
                self.playRate = 1
                self.integral = 0
                self.reading = true
            }

            // Steer, do not jump: same law, same constants as the worklet.
            let err = self.readPos - want
            if abs(err) > rate * HARD_RESYNC_S {
                self.readPos = want
                self.playRate = 1
                self.integral = 0
                self.reanchors += 1
            } else {
                let ceiling = abs(err) > rate * RECOVERY_THRESHOLD_S
                    ? RECOVERY_RATE_DEV : MAX_RATE_DEV
                let proportional = -err / (TAU_S * rate)
                // Anti-windup: bound the integrator to the authority available.
                let integralLimit = ceiling * TAU_INTEGRAL_S * rate
                self.integral = max(-integralLimit,
                                    min(integralLimit, self.integral - err * dt))
                let integralTerm = self.integral / (TAU_INTEGRAL_S * rate)
                self.playRate = 1 + max(-ceiling, min(ceiling, proportional + integralTerm))
            }

            self.render(frames: n)
            Self.scatter(self.rendered, frames: n, sourceChannels: chans,
                         gain: Float(self.gain), into: out)
        }
        guard ioStatus == noErr, let procID else { throw PlayerError.ioProcFailed(ioStatus) }

        let startStatus = AudioDeviceStart(deviceID, procID)
        guard startStatus == noErr else { throw PlayerError.startFailed(startStatus) }
    }

    func stop() {
        if let procID, deviceID != kAudioObjectUnknown {
            AudioDeviceStop(deviceID, procID)
            AudioDeviceDestroyIOProcID(deviceID, procID)
        }
        procID = nil
    }

    /**
     Fill `rendered` with `frames` output frames read at fractional positions.

     Catmull-Rom, exactly like the worklet: linear interpolation is a lowpass
     whose corner depends on the fractional offset, so two devices sitting at
     different offsets round a transient differently, and the ear reads that
     as looseness even when the timing is right.
     */
    private func render(frames: Int) {
        let base = Int64(readPos.rounded(.down)) - 1
        // One frame before the span, two after, plus the rate's stretch.
        let span = Int((Double(frames) * playRate).rounded(.up)) + 4
        let got = ring.read(into: scratch, from: base, frames: min(span, spanFrames))
        if got < frames { starvedFrames += frames - got }

        var pos = readPos
        for f in 0..<frames {
            let idx = Int(pos.rounded(.down)) - Int(base)
            let t = Float(pos - pos.rounded(.down))
            for c in 0..<channels {
                let p0 = scratch[(idx - 1) * channels + c]
                let p1 = scratch[idx * channels + c]
                let p2 = scratch[(idx + 1) * channels + c]
                let p3 = scratch[(idx + 2) * channels + c]
                let b = p2 - p0
                let d = 2 * p0 - 5 * p1 + 4 * p2 - p3
                let e = -p0 + 3 * p1 - 3 * p2 + p3
                rendered[f * channels + c] = 0.5 * (2 * p1 + b * t + d * t * t + e * t * t * t)
            }
            pos += playRate
        }
        readPos = pos
    }

    private static func silence(_ out: UnsafeMutableAudioBufferListPointer) {
        for buf in out {
            guard let d = buf.mData else { continue }
            memset(d, 0, Int(buf.mDataByteSize))
        }
    }

    /**
     Devices present output either as one interleaved buffer or as one buffer
     per channel, and both are common. Handle both rather than assuming.
     */
    private static func scatter(_ src: UnsafePointer<Float>, frames: Int,
                                sourceChannels: Int, gain: Float,
                                into out: UnsafeMutableAudioBufferListPointer) {
        if out.count == 1 {
            guard let d = out[0].mData else { return }
            let dstChannels = max(1, Int(out[0].mNumberChannels))
            let p = d.bindMemory(to: Float.self, capacity: frames * dstChannels)
            for f in 0..<frames {
                for c in 0..<dstChannels {
                    p[f * dstChannels + c] =
                        src[f * sourceChannels + min(c, sourceChannels - 1)] * gain
                }
            }
        } else {
            for (c, buf) in out.enumerated() {
                guard let d = buf.mData else { continue }
                let p = d.bindMemory(to: Float.self, capacity: frames)
                let sc = min(c, sourceChannels - 1)
                for f in 0..<frames { p[f] = src[f * sourceChannels + sc] * gain }
            }
        }
    }
}
