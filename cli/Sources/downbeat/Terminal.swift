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
    nonisolated(unsafe) private static var savedStderr: Int32 = -1
    /// Resolved eagerly on the main thread (first `enter()`), because the
    /// SIGCONT handler also calls `enter()` and must not touch Foundation.
    private static let stderrLogPath = NSHomeDirectory() + "/Library/Logs/downbeat.log"

    static var isInteractive: Bool {
        isatty(STDOUT_FILENO) == 1 && isatty(STDIN_FILENO) == 1
    }

    /// Alternate screen, cursor hidden, canonical mode and echo off.
    static func enter() {
        guard !active else { return }
        guard tcgetattr(STDIN_FILENO, &saved) == 0 else { return }
        var raw = saved
        raw.c_lflag &= ~UInt(ICANON | ECHO)
        // Ctrl-S would otherwise freeze the dashboard until a Ctrl-Q that
        // nobody will think to press.
        raw.c_iflag &= ~UInt(IXON)
        // Return after ≥0 bytes with a 0.1 s timeout, so the key thread can
        // tell a lone Escape press from the start of an escape sequence.
        raw.c_cc.16 = 0 // VMIN
        raw.c_cc.17 = 1 // VTIME
        tcsetattr(STDIN_FILENO, TCSANOW, &raw)
        // While the dashboard owns the screen, anything that prints to stderr
        // mid-frame — NSLog, Network.framework chatter — would land at the
        // cursor, wrap on the bottom row and scroll the frame. Send it to a
        // log file instead; it comes back on restore.
        savedStderr = dup(STDERR_FILENO)
        let fd = open(stderrLogPath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        if fd >= 0 {
            dup2(fd, STDERR_FILENO)
            close(fd)
        }
        // Alternate screen, home, clear, cursor hidden — and auto-wrap OFF.
        // The dashboard clips its own lines, but the wrap flag is the last
        // line of defence: with it set, one line one cell too long scrolls
        // the screen, every frame, and the display walks down the terminal.
        write("\u{1b}[?1049h\u{1b}[H\u{1b}[2J\u{1b}[?25l\u{1b}[?7l")
        active = true
    }

    /// Back to the user's screen, cursor shown, modes restored. Idempotent —
    /// it runs from normal shutdown and from signal handlers alike, so it
    /// sticks to async-signal-safe calls: write, tcsetattr, dup2, close.
    static func restore() {
        guard active else { return }
        active = false
        write("\u{1b}[?7h\u{1b}[?1049l\u{1b}[?25h")
        tcsetattr(STDIN_FILENO, TCSANOW, &saved)
        if savedStderr >= 0 {
            dup2(savedStderr, STDERR_FILENO)
            close(savedStderr)
            savedStderr = -1
        }
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
                if n <= 0 {
                    // A signal mid-frame must not tear the frame in half.
                    if errno == EINTR { continue }
                    break
                }
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
