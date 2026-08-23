import Foundation
import CoreAudio
import AudioToolbox

/**
 Captures the audio of one process (or the whole system) using a Core Audio
 process tap -- macOS 14.2+, no virtual audio device, no kernel extension.

 The important part for Downbeat is `mute`: the tap can silence the source at
 the real output while still receiving it at full level. That is what lets the
 host Mac stop hearing Spotify directly and instead hear it back, in step with
 every phone, once the buffer has elapsed.
 */
final class ProcessTap {
    struct Format {
        let sampleRate: Double
        let channels: Int
    }

    private(set) var format = Format(sampleRate: 48000, channels: 2)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    /// Runs on a realtime audio thread; must never be main-actor isolated.
    private var onAudio: (@Sendable (UnsafePointer<Float>, Int, UInt64) -> Void)?

    enum TapError: Error, CustomStringConvertible {
        case processNotFound(pid_t)
        case tapFailed(OSStatus)
        case formatFailed(OSStatus)
        case aggregateFailed(OSStatus)
        case ioProcFailed(OSStatus)
        case startFailed(OSStatus)

        var description: String {
            switch self {
            case .processNotFound(let p): "kein Audio-Objekt für PID \(p) — läuft der Prozess und gibt er Ton aus?"
            case .tapFailed(let s): "Tap konnte nicht erstellt werden (OSStatus \(s))"
            case .formatFailed(let s): "Tap-Format nicht lesbar (OSStatus \(s))"
            case .aggregateFailed(let s): "Aggregate-Device fehlgeschlagen (OSStatus \(s))"
            case .ioProcFailed(let s): "IOProc fehlgeschlagen (OSStatus \(s))"
            case .startFailed(let s): "Start fehlgeschlagen (OSStatus \(s))"
            }
        }
    }

    static func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var p = pid
        var obj = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                            UInt32(MemoryLayout<pid_t>.size), &p, &size, &obj)
        return (st == noErr && obj != 0) ? obj : nil
    }

    /// `pid == nil` taps everything the machine plays.
    func start(pid: pid_t?, mute: Bool,
               onAudio: @escaping @Sendable (UnsafePointer<Float>, Int, UInt64) -> Void) throws {
        self.onAudio = onAudio

        let description: CATapDescription
        if let pid {
            guard let obj = Self.processObject(forPID: pid) else { throw TapError.processNotFound(pid) }
            description = CATapDescription(stereoMixdownOfProcesses: [obj])
        } else {
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        }
        description.name = "Downbeat"
        description.isPrivate = true
        description.muteBehavior = mute ? .muted : .unmuted

        let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
        guard tapStatus == noErr, tapID != kAudioObjectUnknown else { throw TapError.tapFailed(tapStatus) }

        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let fmtStatus = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
        guard fmtStatus == noErr else { throw TapError.formatFailed(fmtStatus) }
        format = Format(sampleRate: asbd.mSampleRate, channels: Int(asbd.mChannelsPerFrame))

        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Downbeat Capture",
            kAudioAggregateDeviceUIDKey as String: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [],
            kAudioAggregateDeviceTapListKey as String: [[
                kAudioSubTapUIDKey as String: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey as String: true,
            ]],
        ]
        let aggStatus = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggregateID)
        guard aggStatus == noErr, aggregateID != kAudioObjectUnknown else {
            throw TapError.aggregateFailed(aggStatus)
        }

        let channels = format.channels
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) {
            [weak self] _, inInputData, inInputTime, _, _ in
            guard let handler = self?.onAudio else { return }
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard let first = list.first, let data = first.mData else { return }
            let frames = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * channels)
            handler(data.bindMemory(to: Float.self, capacity: frames * channels),
                    frames, inInputTime.pointee.mHostTime)
        }
        guard ioStatus == noErr, let procID else { throw TapError.ioProcFailed(ioStatus) }

        let startStatus = AudioDeviceStart(aggregateID, procID)
        guard startStatus == noErr else { throw TapError.startFailed(startStatus) }
    }

    func stop() {
        if let procID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        procID = nil
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        aggregateID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
        onAudio = nil
    }
}
