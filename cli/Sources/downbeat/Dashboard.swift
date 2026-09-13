import Foundation

/**
 The host dashboard, drawn as whole frames at 5 Hz.

 Monochrome on purpose — bold, dim and inverse read correctly on light and
 dark terminals, and the QR keeps real black on real white, which a scanner
 needs. The layout is a single column that gives rows to the QR first, then
 the join line, telemetry, speakers and log, and drops from the bottom when
 the terminal is small.

 One rule above all others: NO LINE MAY EVER WRAP. A frame that prints one
 more row than the terminal has scrolls the screen, the next frame homes to
 a viewport that has moved, and within seconds the display is walking down
 the terminal shredding itself. So every row is measured in visible cells —
 not bytes, not `String.count`, and never a hand-maintained number that
 drifts the first time a label changes — and clipped to the width that is
 actually there.
 */
struct MemberInfo: Sendable {
    let name: String
    let role: String
    let rtt: Double
    let sync: Double
    let cushionMs: Double?
    let playoutMs: Double?
    /** Context-clock rate vs wall time as the device measured it; 1.0 is healthy. */
    let ctxRate: Double?
    /**
     * Why this device is silent, or nil when it is healthy. A faulted device
     * is excluded from budget steering; the dashboard names the fault.
     */
    let fault: AudioFault?
}

/** The ways a speaker's numbers stop meaning anything. */
enum AudioFault: Equatable, Sendable {
    /** Its audio-context clock runs at the wrong speed: the OS stream is dead. */
    case clock(rate: Double)
    /** It claims more audio ahead of the play head than its ring can hold. */
    case cushion(ms: Double)
    /** It has given up and is showing its tap-to-fix prompt. */
    case stuck

    /** Short form for a dashboard row: what and how much. */
    var detail: String {
        switch self {
        case .clock(let r): return String(format: "clock ×%.1f", r)
        case .cushion(let ms): return String(format: "cushion %.0f s", ms / 1000)
        case .stuck: return "needs a tap"
        }
    }
}

struct DashboardState {
    var source = ""
    var phase = ""
    var phaseBad = false
    var uptimeSec = 0
    var code = ""
    var joinHost = ""
    var qr: [[Bool]]? = nil
    var peakDb = -120.0
    var clockMs = Double.nan
    var synced = false
    var offline = false
    var bufferMs = 0.0
    var cushionMs = Double.nan
    var timelineErrMs = 0.0
    var kbits = 0.0
    var packets: Int64 = 0
    var starved = 0
    var gain = 1.0
    var muted = false
    var members: [MemberInfo] = []
    var log: [(String, String)] = []
    var picker: [AudioSource]? = nil
    var stopping = false
}

enum Dashboard {
    private static let B = "\u{1b}[1m"
    private static let D = "\u{1b}[2m"
    private static let R = "\u{1b}[0m"
    /// Only the render loop's thread touches this.
    nonisolated(unsafe) private static var qrCache: (modules: Int, block: [String]) = (0, [])

    static func render(_ s: DashboardState) -> String {
        let (cols, rows) = Terminal.size()
        var lines: [String] = []

        // Header.
        let devices = s.members.count == 1 ? "1 SPEAKER" : "\(s.members.count) SPEAKERS"
        let right = "\(s.phase)   \(devices)   \(uptime(s.uptimeSec))"
        lines.append(pad("\(B)DOWNBEAT\(R)  \(D)\(s.source)\(R)",
                         (s.phaseBad ? B : "") + right + R, cols: cols))
        lines.append(D + String(repeating: "─", count: max(0, cols)) + R)

        // Join: the QR when it fits, always the code and address. The block
        // is wider than its module count — quiet zone and indent included —
        // so measure the rendered thing, never a number derived from it.
        // Rendered once: the code never changes for the life of the process,
        // and re-emitting ~12 KB of color escapes per frame bought nothing.
        if let qr = s.qr {
            if qrCache.modules != qr.count {
                qrCache = (qr.count, TerminalQR.render(qr).split(separator: "\n").map(String.init))
            }
            let block = qrCache.block
            let qrCols = block.first.map(cells) ?? 0
            if rows >= block.count + 11 && cols >= qrCols {
                lines.append(contentsOf: block)
            }
        }
        lines.append("  \(B)\(s.code)\(R)   \(D)\(s.joinHost)\(R)")
        lines.append("")

        // Telemetry: the peak level first — proof the source is alive, one
        // cell tall — then every number the sync engine steers by.
        let db = s.peakDb > -119 ? String(format: "%.1f dBFS", s.peakDb) : "silent"
        let clock = s.offline ? "offline" : (s.synced ? String(format: "±%.1f ms", s.clockMs) : "syncing…")
        var tele = "  \(db) \(D)·\(R) clock \(clock) \(D)·\(R) buffer \(Int(s.bufferMs)) ms"
        if !s.cushionMs.isNaN { tele += " \(D)·\(R) cushion \(Int(s.cushionMs)) ms" }
        tele += String(format: " \(D)·\(R) timeline %+.1f ms", s.timelineErrMs)
        tele += String(format: " \(D)·\(R) %.0f kbit/s \(D)·\(R) %d pkts \(D)·\(R) underrun %d",
                       s.kbits, s.packets, s.starved)
        lines.append(tele)
        lines.append("")

        // Speakers.
        if s.members.isEmpty {
            lines.append("  \(D)Speakers — none yet. Point a camera at the code above.\(R)")
        } else {
            lines.append("  \(B)Speakers\(R)")
            for m in s.members.prefix(6) {
                var row = "   \(m.name)"
                row += "  \(D)rtt\(R) \(Int(m.rtt)) ms  \(D)±\(R)\(String(format: "%.1f", m.sync)) ms"
                if let fault = m.fault {
                    // A cushion of 45 minutes is not telemetry, it is a symptom.
                    // Name the disease instead of printing the number.
                    let what = fault == .stuck ? "audio stuck" : "audio broken"
                    row += "  \(B)⚠ \(what)\(R) \(D)\(fault.detail)\(R)"
                } else if let c = m.cushionMs {
                    row += "  \(D)cushion\(R) \(Int(c)) ms"
                }
                lines.append(row)
            }
        }
        lines.append("")

        // The picker borrows the log's rows; both are transient.
        let used = lines.count
        let bodyRows = max(0, rows - used - 1)
        if let picker = s.picker {
            lines.append("  \(B)CHOOSE SOURCE\(R)")
            lines.append("  \(D)a  everything this Mac plays\(R)")
            for (i, src) in picker.prefix(8).enumerated() {
                lines.append("  \(B)\(i + 1)\(R)  \(src.name)\(src.active ? "  \(D)playing\(R)" : "")")
            }
            lines.append("  \(D)esc  cancel\(R)")
        } else if bodyRows > 1 {
            lines.append("  \(B)Log\(R)")
            for (time, msg) in s.log.suffix(bodyRows - 1) {
                lines.append("  \(D)\(time)\(R)  \(msg)")
            }
        }

        // Footer, pinned to the last row.
        while lines.count < rows - 1 { lines.append("") }
        lines = Array(lines.prefix(rows - 1))
        let gain = "\(Int((s.gain * 100).rounded()))%"
        let keys = "\(B)q\(R)\(D) quit\(R)  \(B)m\(R)\(D) \(s.muted ? "unmute" : "mute")\(R)  \(B)±\(R)\(D) \(gain)\(R)  \(B)s\(R)\(D) source\(R)"
        let note = s.stopping ? "stopping — the source becomes audible again…"
                              : (s.muted ? "host muted" : "")
        lines.append(pad(keys, D + note + R, cols: cols))

        // One frame, one write. \r\n because the terminal is in raw mode.
        // Every row clipped: the terminal's auto-wrap is also disabled as a
        // belt, but the frame must be correct on its own.
        var frame = "\u{1b}[H"
        for line in lines {
            frame += clip(line, cols)
            frame += "\u{1b}[K\r\n"
        }
        frame.removeLast(2)
        frame += "\u{1b}[J"
        return frame
    }

    /* ---------------------------------------------------------- measuring */

    /// Visible terminal cells in a string, ANSI escape sequences excluded.
    static func cells(_ s: String) -> Int {
        var n = 0
        var esc = false, csi = false
        for u in s.unicodeScalars {
            if esc {
                if csi {
                    if (0x40...0x7e).contains(u.value) { esc = false }
                } else if u == "[" {
                    csi = true
                } else {
                    esc = false
                }
                continue
            }
            if u.value == 0x1b { esc = true; csi = false; continue }
            n += width(u)
        }
        return n
    }

    /// Truncate to `max` visible cells. Escapes pass through unmeasured; a
    /// reset is appended when anything was cut so styling cannot leak into
    /// the erase-to-end that follows.
    static func clip(_ s: String, _ max: Int) -> String {
        var out = String.UnicodeScalarView()
        var used = 0
        var esc = false, csi = false
        var cut = false
        for u in s.unicodeScalars {
            if esc {
                out.append(u)
                if csi {
                    if (0x40...0x7e).contains(u.value) { esc = false }
                } else if u == "[" {
                    csi = true
                } else {
                    esc = false
                }
                continue
            }
            if u.value == 0x1b {
                esc = true; csi = false
                out.append(u)
                continue
            }
            let w = width(u)
            if used + w > max { cut = true; break }
            used += w
            out.append(u)
        }
        return cut ? String(out) + R : String(out)
    }

    /**
     Terminal cells for one scalar: combining marks and joiners take none,
     CJK and emoji take two, everything else one. Not a full wcwidth — it
     does not need to be, because `clip` plus the disabled auto-wrap mean a
     misjudged edge case costs a slightly short line, never a scroll.
     */
    private static func width(_ u: UnicodeScalar) -> Int {
        switch u.value {
        case 0x0300...0x036F, 0x1AB0...0x1AFF, 0x20D0...0x20FF,
             0x200B...0x200F, 0xFE00...0xFE0F:
            return 0
        case 0x1100...0x115F, 0x2E80...0x9FFF, 0xA000...0xA4CF, 0xAC00...0xD7A3,
             0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
             0x1F300...0x1FAFF, 0x20000...0x3FFFD:
            return 2
        default:
            return 1
        }
    }

    /// Left text, right text, one row — widths measured, never hand-counted.
    /// The last column stays free so the cursor can never push past the edge.
    private static func pad(_ left: String, _ right: String, cols: Int) -> String {
        let gap = max(1, cols - cells(left) - cells(right) - 2)
        return " " + left + String(repeating: " ", count: gap) + right
    }

    private static func uptime(_ secs: Int) -> String {
        let h = secs / 3600, m = (secs % 3600) / 60, s = secs % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s)
                     : String(format: "%d:%02d", m, s)
    }
}
