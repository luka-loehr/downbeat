import Foundation
import Synchronization

/**
 A single-producer, single-consumer ring of interleaved stereo Float32.

 Addressed by ABSOLUTE frame index, not by read/write pointers. The capture
 thread only ever appends; the playback thread asks for "the 512 frames that
 start at frame 91_238" and either gets them or gets silence. That is what lets
 playback be driven by the room clock instead of by how full the buffer happens
 to be -- the same inversion the file path uses.
 */
final class RingBuffer: @unchecked Sendable {
    private let capacity: Int
    private let channels: Int
    private let storage: UnsafeMutablePointer<Float>
    /// Total frames ever written. Monotonic; never wraps.
    private let written = Atomic<Int64>(0)

    init(seconds: Double, sampleRate: Double, channels: Int) {
        self.channels = channels
        // Round up to a power of two so wrapping is a mask, not a modulo.
        let want = Int((seconds * sampleRate).rounded(.up))
        var cap = 1
        while cap < want { cap <<= 1 }
        self.capacity = cap
        self.storage = .allocate(capacity: cap * channels)
        self.storage.initialize(repeating: 0, count: cap * channels)
    }

    deinit { storage.deallocate() }

    var framesWritten: Int64 { written.load(ordering: .acquiring) }

    /**
     Advance the write position by `frames` of silence.

     Swapping capture sources takes a moment, and during it nothing is written.
     Left alone the stream would simply resume where it stopped, so every
     sample after the swap would be that much later than the clock says it
     should be -- the whole room would slide behind. Padding the gap keeps
     stream position and wall clock the same thing.
     */
    func writeSilence(frames: Int) {
        guard frames > 0 else { return }
        let start = written.load(ordering: .relaxed)
        let mask = capacity - 1
        var offset = Int(start) & mask
        var remaining = frames
        while remaining > 0 {
            let chunk = min(remaining, capacity - offset)
            storage.advanced(by: offset * channels)
                .update(repeating: 0, count: chunk * channels)
            offset = (offset + chunk) & mask
            remaining -= chunk
        }
        written.store(start + Int64(frames), ordering: .releasing)
    }

    /// Append `frames` of interleaved audio. Called from the capture thread only.
    func write(_ src: UnsafePointer<Float>, frames: Int) {
        guard frames > 0 else { return }
        let start = written.load(ordering: .relaxed)
        let mask = capacity - 1
        var offset = Int(start) & mask
        var remaining = frames
        var s = src
        while remaining > 0 {
            let chunk = min(remaining, capacity - offset)
            storage.advanced(by: offset * channels)
                .update(from: s, count: chunk * channels)
            s = s.advanced(by: chunk * channels)
            offset = (offset + chunk) & mask
            remaining -= chunk
        }
        written.store(start + Int64(frames), ordering: .releasing)
    }

    /**
     Read `frames` starting at absolute frame `from`. Anything outside the
     window still held in the ring is filled with silence rather than stale
     audio -- a gap is honest, a repeat is a glitch that sounds like a fault.

     Returns the number of frames that were real audio.
     */
    @discardableResult
    func read(into dst: UnsafeMutablePointer<Float>, from: Int64, frames: Int) -> Int {
        let end = written.load(ordering: .acquiring)
        let oldest = max(0, end - Int64(capacity))
        dst.update(repeating: 0, count: frames * channels)
        guard frames > 0, from < end else { return 0 }

        let begin = max(from, oldest)
        let stop = min(from + Int64(frames), end)
        guard stop > begin else { return 0 }

        let mask = capacity - 1
        var idx = begin
        var out = dst.advanced(by: Int(begin - from) * channels)
        var remaining = Int(stop - begin)
        while remaining > 0 {
            let offset = Int(idx) & mask
            let chunk = min(remaining, capacity - offset)
            out.update(from: storage.advanced(by: offset * channels), count: chunk * channels)
            out = out.advanced(by: chunk * channels)
            idx += Int64(chunk)
            remaining -= chunk
        }
        return Int(stop - begin)
    }
}
