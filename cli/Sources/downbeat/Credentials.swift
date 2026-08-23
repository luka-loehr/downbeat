import Foundation
import Security

/**
 The host passphrase, kept in the macOS Keychain.

 Typing a passphrase into a shell every time is both tedious and a good way to
 leave it in `~/.zsh_history`, so `downbeat login` stores it once. It is scoped
 per server host, so a local dev instance and production do not overwrite each
 other's credentials.
 */
enum Credentials {
    private static let service = "downbeat"

    static func save(_ passphrase: String, host: String) -> Bool {
        delete(host: host)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host,
            kSecValueData as String: Data(passphrase.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func load(host: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8), !text.isEmpty
        else { return nil }
        return text
    }

    @discardableResult
    static func delete(host: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host,
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }

    /**
     Reads without echoing, so the passphrase never lands in the scrollback.

     When stdin is not a terminal -- a pipe, CI, a test -- `getpass` cannot work
     because it reads from /dev/tty, so fall back to a plain line. That also
     makes `echo "$SECRET" | downbeat login` a legitimate way to script setup.
     */
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
