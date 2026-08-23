// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "downbeat",
    platforms: [.macOS(.v15)],
    targets: [
        // The terminal UI is a separate Node/Ink process that spawns this one;
        // `downbeat` itself is the front end, this is the engine behind it.
        .executableTarget(
            name: "downbeat-core",
            path: "Sources/downbeat",
            swiftSettings: [.unsafeFlags(["-Ounchecked"], .when(configuration: .release))]
        )
    ]
)
