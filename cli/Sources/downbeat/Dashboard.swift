import Foundation

/**
 The host dashboard, drawn as whole frames at 5 Hz.

 Monochrome on purpose — bold, dim and inverse read correctly on light and
 dark terminals, and the QR keeps real black on real white, which a scanner
 needs. The layout is a single column that gives rows to the QR first, then
 the meter, speakers, telemetry and log, and drops from the bottom when the
 terminal is small.
 */
struct MemberInfo: Sendable {
    let name: String
    let role: String
    let rtt: Double
    let sync: Double
    let cushionMs: Double?
    let playoutMs: Double?
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
    var levelsDb: [Double] = []
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
    private static let glyphs: [Character] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

    static func render(_ s: DashboardState) -> String {
        let (cols, rows) = Terminal.size()
        var lines: [String] = []

        // Header.
        let devices = s.members.count == 1 ? "1 SPEAKER" : "\(s.members.count) SPEAKERS"
        let right = "\(s.phase)   \(devices)   \(uptime(s.uptimeSec))"
        lines.append(pad("\(B)DOWNBEAT\(R)  \(D)\(s.source)\(R)",
                         visible: 10 + s.source.count,
                         right: (s.phaseBad ? B : "") + right + R,
                         rightVisible: right.count, cols: cols))
        lines.append(D + String(repeating: "─", count: max(0, cols)) + R)

        // Join: the QR when it fits, always the code and address.
        if let qr = s.qr {
            let qrRows = (qr.count + 1) / 2 + 2
            if rows >= qrRows + 12 && cols >= qr.count + 4 {
                lines.append(contentsOf: TerminalQR.render(qr).split(separator: "\n").map(String.init))
            }
        }
        lines.append("  \(B)\(s.code)\(R)   \(D)\(s.joinHost)\(R)")
        lines.append("")

        // Level meter: one row of peaks, newest on the right.
        let meterWidth = max(8, cols - 22)
        var meter = ""
        let recent = s.levelsDb.suffix(meterWidth)
        for _ in 0..<(meterWidth - recent.count) { meter.append(" ") }
        for db in recent {
            let t = max(0.0, min(1.0, (db + 60) / 60))
            meter.append(glyphs[Int((t * 8).rounded())])
        }
        let db = s.peakDb > -119 ? String(format: "%6.1f dBFS", s.peakDb) : "  -inf dBFS"
        lines.append("  \(meter)  \(D)\(db)\(R)")
        lines.append("")

        // Telemetry: every number the sync engine steers by.
        let clock = s.offline ? "offline" : (s.synced ? String(format: "±%.1f ms", s.clockMs) : "syncing…")
        var tele = "  clock \(clock) \(D)·\(R) buffer \(Int(s.bufferMs)) ms"
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
                if let c = m.cushionMs { row += "  \(D)cushion\(R) \(Int(c)) ms" }
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
        lines.append(pad(keys, visible: 24 + gain.count, right: D + note + R,
                         rightVisible: note.count, cols: cols))

        // One frame, one write. \r\n because the terminal is in raw mode.
        var frame = "\u{1b}[H"
        for line in lines {
            frame += line
            frame += "\u{1b}[K\r\n"
        }
        frame.removeLast(2)
        frame += "\u{1b}[J"
        return frame
    }

    private static func pad(_ left: String, visible: Int, right: String,
                            rightVisible: Int, cols: Int) -> String {
        let gap = max(1, cols - visible - rightVisible - 1)
        return " " + left + String(repeating: " ", count: gap) + right
    }

    private static func uptime(_ secs: Int) -> String {
        let h = secs / 3600, m = (secs % 3600) / 60, s = secs % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s)
                     : String(format: "%d:%02d", m, s)
    }
}
