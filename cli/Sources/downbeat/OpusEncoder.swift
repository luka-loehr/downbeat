import Foundation
import AudioToolbox

/**
 Opus encoding via AudioToolbox.

 macOS ships an Opus encoder (it appears in `kAudioFormatProperty_EncodeFormatIDs`),
 so the CLI needs no libopus, no Homebrew, and stays a self-contained binary.
 Opus is also the codec WebCodecs `AudioDecoder` handles on every browser we
 target, so the packets go on the wire exactly as produced.
 */
final class OpusEncoder {
    private var converter: AudioConverterRef?
    private let inputChannels: Int
    private(set) var framesPerPacket: Int = 0
    private let maxPacketBytes = 4000

    /// Interleaved Float32 waiting to be consumed by the converter callback.
    private var pending: UnsafeMutablePointer<Float>
    private var pendingFrames = 0
    private var pendingCapacity: Int

    enum EncoderError: Error, CustomStringConvertible {
        case createFailed(OSStatus)
        case bitrateFailed(OSStatus)
        case encodeFailed(OSStatus)
        var description: String {
            switch self {
            case .createFailed(let s): "Opus-Encoder nicht verfügbar (OSStatus \(s))"
            case .bitrateFailed(let s): "Bitrate ließ sich nicht setzen (OSStatus \(s))"
            case .encodeFailed(let s): "Opus-Encoding fehlgeschlagen (OSStatus \(s))"
            }
        }
    }

    init(sampleRate: Double, channels: Int, bitrate: Int = 128_000) throws {
        inputChannels = channels
        pendingCapacity = 48_000 * channels
        pending = .allocate(capacity: pendingCapacity)

        var input = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(4 * channels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(4 * channels),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 32,
            mReserved: 0)

        var output = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,   // let the encoder choose its packet length
            mBytesPerFrame: 0,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0,
            mReserved: 0)

        let status = AudioConverterNew(&input, &output, &converter)
        guard status == noErr, converter != nil else { throw EncoderError.createFailed(status) }

        var rate = UInt32(bitrate)
        let brStatus = AudioConverterSetProperty(converter!, kAudioConverterEncodeBitRate,
                                                 UInt32(MemoryLayout<UInt32>.size), &rate)
        // Not every encoder accepts an explicit bitrate; its default is fine.
        if brStatus != noErr { NSLog("downbeat: Bitrate nicht gesetzt (\(brStatus)), nutze Standard") }

        var actual = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        AudioConverterGetProperty(converter!, kAudioConverterCurrentOutputStreamDescription, &size, &actual)
        framesPerPacket = Int(actual.mFramesPerPacket)
        if framesPerPacket == 0 { framesPerPacket = 960 }  // 20 ms at 48 kHz
    }

    deinit {
        if let converter { AudioConverterDispose(converter) }
        pending.deallocate()
    }

    /**
     Feed interleaved Float32 and receive whole Opus packets.

     Returns one `Data` per packet, each covering exactly `framesPerPacket`
     frames, so the caller can label packets by absolute sample index and never
     has to trust a per-packet timestamp.
     */
    func encode(_ samples: UnsafePointer<Float>, frames: Int) throws -> [Data] {
        guard let converter else { return [] }

        if pendingFrames + frames > pendingCapacity / inputChannels {
            let needed = (pendingFrames + frames) * inputChannels * 2
            let grown = UnsafeMutablePointer<Float>.allocate(capacity: needed)
            grown.update(from: pending, count: pendingFrames * inputChannels)
            pending.deallocate()
            pending = grown
            pendingCapacity = needed
        }
        pending.advanced(by: pendingFrames * inputChannels)
            .update(from: samples, count: frames * inputChannels)
        pendingFrames += frames

        var packets: [Data] = []
        var buffer = [UInt8](repeating: 0, count: maxPacketBytes)

        while pendingFrames >= framesPerPacket {
            var context = FillContext(source: pending, frames: framesPerPacket,
                                      channels: inputChannels, consumed: false)
            var packetCount: UInt32 = 1
            var desc = AudioStreamPacketDescription()

            let status: OSStatus = buffer.withUnsafeMutableBytes { raw in
                var abl = AudioBufferList(
                    mNumberBuffers: 1,
                    mBuffers: AudioBuffer(mNumberChannels: UInt32(inputChannels),
                                          mDataByteSize: UInt32(raw.count),
                                          mData: raw.baseAddress))
                return withUnsafeMutablePointer(to: &context) { ctx in
                    AudioConverterFillComplexBuffer(converter, fillProc, ctx, &packetCount, &abl, &desc)
                }
            }
            guard status == noErr || status == kFillDone else { throw EncoderError.encodeFailed(status) }
            if packetCount == 0 { break }

            packets.append(Data(buffer[0..<Int(desc.mDataByteSize)]))

            let leftover = pendingFrames - framesPerPacket
            if leftover > 0 {
                pending.update(from: pending.advanced(by: framesPerPacket * inputChannels),
                               count: leftover * inputChannels)
            }
            pendingFrames = leftover
        }
        return packets
    }
}

private let kFillDone: OSStatus = 1_000_001

private struct FillContext {
    var source: UnsafeMutablePointer<Float>
    var frames: Int
    var channels: Int
    var consumed: Bool
}

private let fillProc: AudioConverterComplexInputDataProc = {
    _, ioNumberDataPackets, ioData, outDesc, userData in
    guard let userData else { ioNumberDataPackets.pointee = 0; return kFillDone }
    let ctx = userData.assumingMemoryBound(to: FillContext.self)
    if ctx.pointee.consumed {
        ioNumberDataPackets.pointee = 0
        return kFillDone
    }
    ctx.pointee.consumed = true
    let frames = ctx.pointee.frames
    let channels = ctx.pointee.channels
    ioNumberDataPackets.pointee = UInt32(frames)
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mNumberChannels = UInt32(channels)
    ioData.pointee.mBuffers.mDataByteSize = UInt32(frames * channels * 4)
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(ctx.pointee.source)
    outDesc?.pointee = nil
    return noErr
}
