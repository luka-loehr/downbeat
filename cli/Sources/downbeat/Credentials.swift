import Foundation

/**
 The host passphrase, in a file under `~/.config/downbeat`.

 The Keychain would be the safer store, but every read pops a system dialog
 that has to be clicked, which makes the CLI unusable from scripts, CI, or any
 unattended run. A 0600 file in the user's config directory is what `gh`, `aws`
 and most other CLIs do, and it is the difference between a tool that automates
 and one that does not.
 */
enum Credentials {
    private static var directory: URL {
        let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            .map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config")
        return base.appendingPathComponent("downbeat")
    }

    /// Scoped per server, so a dev instance and production do not collide.
    private static func file(for host: String) -> URL {
        let safe = host.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).passphrase")
    }

    @discardableResult
    static func save(_ passphrase: String, host: String) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let target = file(for: host)
            try Data(passphrase.utf8).write(to: target, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                  ofItemAtPath: target.path)
            return true
        } catch {
            return false
        }
    }

    static func load(host: String) -> String? {
        guard let data = try? Data(contentsOf: file(for: host)),
              let text = String(data: data, encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return nil }
        return text
    }

    @discardableResult
    static func delete(host: String) -> Bool {
        (try? FileManager.default.removeItem(at: file(for: host))) != nil
    }

    static var location: String {
        directory.path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~")
    }

    /// Reads without echoing where there is a terminal, and from a pipe where
    /// there is not -- so `echo "$SECRET" | downbeat login` works in scripts.
    static func prompt(_ message: String) -> String? {
        let text: String?
        if isatty(STDIN_FILENO) == 1 {
            text = getpass(message).map { String(cString: $0) }
        } else {
            text = readLine(strippingNewline: true)
        }
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }
}
