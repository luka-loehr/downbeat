import Foundation

/**
 The terminal itself: raw mode, the alternate screen, size, and keys.

 This is everything the Node/Ink process used to be for, in ~100 lines with no
 runtime, no React and no JSON pipe. The dashboard draws whole frames; this
 file only owns the modes and the byte stream.
 */
enum Terminal {
    nonisolated(unsafe) private static var saved = termios()
    nonisolated(unsafe) private static var active = false

    static var isInteractive: Bool {
        isatty(STDOUT_FILENO) == 1 && isatty(STDIN_FILENO) == 1
    }

    /// Alternate screen, cursor hidden, canonical mode and echo off.
    static func enter() {
        guard !active else { return }
        tcgetattr(STDIN_FILENO, &saved)
        var raw = saved
        raw.c_lflag &= ~UInt(ICANON | ECHO)
        // Return after ≥0 bytes with a 0.1 s timeout, so the key thread can
        // tell a lone Escape press from the start of an escape sequence.
        raw.c_cc.16 = 0 // VMIN
        raw.c_cc.17 = 1 // VTIME
        tcsetattr(STDIN_FILENO, TCSANOW, &raw)
        write("\u{1b}[?1049h\u{1b}[H\u{1b}[2J\u{1b}[?25l")
        active = true
    }

    /// Back to the user's screen, cursor shown, modes restored. Idempotent —
    /// it runs from normal shutdown and from signal handlers alike.
    static func restore() {
        guard active else { return }
        active = false
        write("\u{1b}[?1049l\u{1b}[?25h")
        tcsetattr(STDIN_FILENO, TCSANOW, &saved)
    }

    static func size() -> (cols: Int, rows: Int) {
        var w = winsize()
        if ioctl(STDOUT_FILENO, TIOCGWINSZ, &w) == 0, w.ws_col > 0, w.ws_row > 0 {
            return (Int(w.ws_col), Int(w.ws_row))
        }
        return (80, 24)
    }

    /// One whole frame, one write: no flicker, no interleaving with anything.
    static func write(_ s: String) {
        let bytes = Array(s.utf8)
        bytes.withUnsafeBufferPointer { buf in
            var done = 0
            while done < buf.count {
                let n = Foundation.write(STDOUT_FILENO, buf.baseAddress! + done, buf.count - done)
                if n <= 0 { break }
                done += n
            }
        }
    }

    enum Key {
        case char(Character)
        case escape
    }

    /// Blocking-ish read of one key press; nil on timeout.
    static func readKey() -> Key? {
        var byte: UInt8 = 0
        let n = read(STDIN_FILENO, &byte, 1)
        guard n == 1 else { return nil }
        if byte == 0x1b {
            // Escape, or the start of a sequence (arrows etc.). The 0.1 s
            // VTIME window separates them; sequences are read and dropped.
            var next: UInt8 = 0
            if read(STDIN_FILENO, &next, 1) == 1 {
                if next == UInt8(ascii: "[") || next == UInt8(ascii: "O") {
                    var rest: UInt8 = 0
                    while read(STDIN_FILENO, &rest, 1) == 1 {
                        if (0x40...0x7e).contains(rest) { break }
                    }
                    return nil
                }
                return .char(Character(UnicodeScalar(next)))
            }
            return .escape
        }
        guard byte >= 0x20 || byte == 0x03 else { return nil }
        return .char(Character(UnicodeScalar(byte)))
    }
}
