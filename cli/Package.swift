// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "downbeat",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "downbeat",
            path: "Sources/downbeat",
            swiftSettings: [.unsafeFlags(["-Ounchecked"], .when(configuration: .release))]
        )
    ]
)
