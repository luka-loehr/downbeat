// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "downbeat",
    platforms: [.macOS(.v15)],
    targets: [
        // One native binary: capture, Opus, transport, local playback and the
        // terminal dashboard. No runtime, no helper processes.
        .executableTarget(
            name: "downbeat",
            path: "Sources/downbeat",
            swiftSettings: [.unsafeFlags(["-Ounchecked"], .when(configuration: .release))]
        )
    ]
)
