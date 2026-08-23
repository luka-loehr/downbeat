import Foundation
import CoreAudio
import AudioToolbox

/**
 Plays the captured stream back on this Mac, `bufferMs` behind capture, timed
 by the room clock rather than by buffer fill.

 That distinction is the whole point: the phones compute the very same
 "which sample belongs to this instant" from the very same clock, so the Mac is
 not a special case that happens to sound right -- it is just another speaker.
 */
/// How far the read head may drift from the clock before it is worth moving.
private let ANCHOR_RESET_S = 0.030

final class LocalPlayer {
    private let ring: RingBuffer
    private let clock: RoomClock
    private let sampleRate: Double
    private let channels: Int
    private let bufferMs: Double

    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var scratch: UnsafeMutablePointer<Float>
    private let scratchFrames = 4096

    /// Local monotonic time that capture frame 0 corresponds to. Set once by
    /// the tap. Deliberately not in room time: the clock offset keeps moving,
    /// and an anchor expressed in room time would move with it.
    var anchorLocalMs: Double = 0
    var anchored = false
    /// Frames that arrived too late to be played, for honest reporting.
    private(set) var starvedFrames: Int = 0
    /// Times the read position had to be re-derived from the clock.
    private(set) var reanchors: Int = 0

    /**
     Read position, advanced by exactly the frames consumed.

     Recomputing it from the clock on every callback sounds equivalent and is
     not: the rounding moves by a sample here and there, and every one of those
     is a hole or a repeat -- a crackle rather than a glitch. The clock is
     consulted to place the read head once, and afterwards only to notice if it
     has drifted far enough to be worth moving.
     */
    private var readFrame: Int64 = 0
    private var reading = false

    init(ring: RingBuffer, clock: RoomClock, sampleRate: Double, channels: Int, bufferMs: Double) {
        self.ring = ring
        self.clock = clock
        self.sampleRate = sampleRate
        self.channels = channels
        self.bufferMs = bufferMs
        self.scratch = .allocate(capacity: scratchFrames * channels)
        self.scratch.initialize(repeating: 0, count: scratchFrames * channels)
    }

    deinit { scratch.deallocate() }

    enum PlayerError: Error, CustomStringConvertible {
        case noDefaultOutput(OSStatus)
        case ioProcFailed(OSStatus)
        case startFailed(OSStatus)
        var description: String {
            switch self {
            case .noDefaultOutput(let s): "kein Standard-Ausgabegerät (OSStatus \(s))"
            case .ioProcFailed(let s): "Ausgabe-IOProc fehlgeschlagen (OSStatus \(s))"
            case .startFailed(let s): "Ausgabe-Start fehlgeschlagen (OSStatus \(s))"
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
        let delay = bufferMs
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, nil) {
            [weak self] _, _, _, outOutputData, inOutputTime in
            guard let self else { return }
            let out = UnsafeMutableAudioBufferListPointer(outOutputData)
            guard self.anchored else { Self.silence(out); return }

            // When will these samples actually be heard? Local domain on both
            // sides, so the room-clock offset cancels out entirely.
            let outLocalMs = RoomClock.localMs(hostTime: inOutputTime.pointee.mHostTime)
            let wantMs = outLocalMs - delay - self.anchorLocalMs
            let wantFrame = Int64((wantMs / 1000 * rate).rounded())

            let frames = Int(out[0].mDataByteSize) / MemoryLayout<Float>.size
                / max(1, Int(out[0].mNumberChannels))
            let n = min(frames, self.scratchFrames)

            if !self.reading {
                self.readFrame = wantFrame
                self.reading = true
            } else if abs(self.readFrame - wantFrame) > Int64(rate * ANCHOR_RESET_S) {
                self.readFrame = wantFrame
                self.reanchors += 1
            }

            let got = self.ring.read(into: self.scratch, from: self.readFrame, frames: n)
            self.readFrame += Int64(n)
            if got < n { self.starvedFrames += (n - got) }

            Self.scatter(self.scratch, frames: n, sourceChannels: chans, into: out)
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
                                sourceChannels: Int,
                                into out: UnsafeMutableAudioBufferListPointer) {
        if out.count == 1 {
            guard let d = out[0].mData else { return }
            let dstChannels = max(1, Int(out[0].mNumberChannels))
            let p = d.bindMemory(to: Float.self, capacity: frames * dstChannels)
            for f in 0..<frames {
                for c in 0..<dstChannels {
                    p[f * dstChannels + c] = src[f * sourceChannels + min(c, sourceChannels - 1)]
                }
            }
        } else {
            for (c, buf) in out.enumerated() {
                guard let d = buf.mData else { continue }
                let p = d.bindMemory(to: Float.self, capacity: frames)
                let sc = min(c, sourceChannels - 1)
                for f in 0..<frames { p[f] = src[f * sourceChannels + sc] }
            }
        }
    }
}
