import Foundation
import CoreImage
import CoreGraphics
import Vision

/**
 A QR code drawn straight into the terminal, so joining is "point camera at the
 laptop" instead of "type six characters".

 Two details decide whether a phone can actually read it. Colors are written
 explicitly with ANSI escapes rather than relying on the terminal's theme -- on
 a dark background an unstyled code is inverted, which many scanners refuse.
 And each character carries two rows via a half-block, because a QR drawn one
 terminal row per module comes out twice as tall as it is wide.
 */
enum TerminalQR {
    /// `true` means a dark module.
    static func modules(for text: String) -> [[Bool]]? {
        guard let data = text.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }

        let width = Int(output.extent.width)
        let height = Int(output.extent.height)
        guard width > 0, height > 0 else { return nil }

        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let cg = context.createCGImage(output, from: output.extent) else { return nil }

        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let bitmap = CGContext(data: &pixels, width: width, height: height,
                                     bitsPerComponent: 8, bytesPerRow: width,
                                     space: CGColorSpaceCreateDeviceGray(),
                                     bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        bitmap.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

        // CGContext has its origin at the bottom left while the generator's
        // output is top-down, so rows come back flipped. A mirrored QR is not
        // reliably scannable, hence the explicit un-flip.
        var rows: [[Bool]] = []
        for y in stride(from: height - 1, through: 0, by: -1) {
            var row: [Bool] = []
            row.reserveCapacity(width)
            for x in 0..<width { row.append(pixels[y * width + x] < 128) }
            rows.append(row)
        }
        return rows
    }

    static func render(_ modules: [[Bool]], quiet: Int = 3, indent: String = "  ") -> String {
        guard let first = modules.first else { return "" }
        let width = first.count + quiet * 2
        var padded: [[Bool]] = []
        let blank = [Bool](repeating: false, count: width)
        for _ in 0..<quiet { padded.append(blank) }
        for row in modules { padded.append([Bool](repeating: false, count: quiet) + row + [Bool](repeating: false, count: quiet)) }
        for _ in 0..<quiet { padded.append(blank) }
        if padded.count % 2 == 1 { padded.append(blank) }

        let dark = 232, light = 255
        var out = ""
        for y in stride(from: 0, to: padded.count, by: 2) {
            out += indent
            for x in 0..<width {
                let top = padded[y][x] ? dark : light
                let bottom = padded[y + 1][x] ? dark : light
                out += "\u{1b}[38;5;\(top)m\u{1b}[48;5;\(bottom)m\u{2580}"
            }
            out += "\u{1b}[0m\n"
        }
        return out
    }

    /**
     Render the modules back to an image and ask Vision to read them.

     Printing something that merely looks like a QR code is not the same as
     printing one a phone can scan, and the difference is invisible by eye.
     */
    static func decodes(_ modules: [[Bool]], to expected: String) -> String? {
        let quiet = 4, scale = 8
        let size = (modules.count + quiet * 2) * scale
        var pixels = [UInt8](repeating: 255, count: size * size)
        for (y, row) in modules.enumerated() {
            for (x, on) in row.enumerated() where on {
                for dy in 0..<scale {
                    for dx in 0..<scale {
                        let py = (y + quiet) * scale + dy
                        let px = (x + quiet) * scale + dx
                        pixels[py * size + px] = 0
                    }
                }
            }
        }
        guard let context = CGContext(data: &pixels, width: size, height: size,
                                      bitsPerComponent: 8, bytesPerRow: size,
                                      space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let image = context.makeImage() else { return nil }

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let found = (request.results ?? []).compactMap(\.payloadStringValue)
        _ = expected
        return found.first
    }
}
