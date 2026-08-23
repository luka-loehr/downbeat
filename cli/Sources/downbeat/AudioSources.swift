import Foundation
import CoreAudio
import AppKit

/**
 The apps this Mac could capture from, discovered rather than hardcoded.

 Core Audio keeps an object per process that has ever opened an audio device,
 so the list is authoritative: it knows Apple Music is playing and that some
 background helper is not, which no amount of guessing at bundle identifiers
 would. `isRunning` distinguishes an app that currently holds the device from
 one that merely could.
 */
struct AudioSource: Sendable {
    let pid: pid_t
    let name: String
    /// True when the process is actively rendering audio right now.
    let active: Bool
}

enum AudioSources {
    static func list() -> [AudioSource] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)

        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr,
            size > 0
        else { return [] }

        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var objects = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &objects) == noErr
        else { return [] }

        var seen = Set<pid_t>()
        var found: [AudioSource] = []
        let own = ProcessInfo.processInfo.processIdentifier
        for object in objects {
            guard let pid = pid(of: object), pid > 0, pid != own, !seen.contains(pid)
            else { continue }
            seen.insert(pid)
            // Only things a person would recognise as an app. Media helpers
            // report names like "2.1.241-c50", and capturing our own output
            // would be a feedback loop -- neither belongs in a picker.
            guard let app = NSRunningApplication(processIdentifier: pid),
                  app.activationPolicy == .regular,
                  let name = app.localizedName, !name.isEmpty
            else { continue }
            found.append(AudioSource(pid: pid, name: name, active: isRunning(object)))
        }
        // Whatever is making sound right now belongs at the top of a picker.
        return found.sorted {
            $0.active == $1.active
                ? $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                : $0.active
        }
    }

    /// Resolve a user-typed name ("music", "Spotify") to a running process.
    static func find(named needle: String) -> AudioSource? {
        let lower = needle.lowercased()
        let all = list()
        return all.first { $0.name.lowercased() == lower }
            ?? all.first { $0.name.lowercased().hasPrefix(lower) }
            ?? all.first { $0.name.lowercased().contains(lower) }
    }

    private static func pid(of object: AudioObjectID) -> pid_t? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr
        else { return nil }
        return value
    }

    private static func isRunning(_ object: AudioObjectID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningOutput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr
        else { return false }
        return value != 0
    }


}
