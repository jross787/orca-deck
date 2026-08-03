// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OrcaDraftOverlay",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "orca-draft-overlay", targets: ["orca-draft-overlay"]),
        .library(name: "OrcaDraftOverlayCore", targets: ["OrcaDraftOverlayCore"]),
    ],
    targets: [
        .target(
            name: "OrcaDraftOverlayCore",
            path: "Sources/OrcaDraftOverlayCore"
        ),
        .executableTarget(
            name: "orca-draft-overlay",
            dependencies: ["OrcaDraftOverlayCore"],
            path: "Sources/OrcaDraftOverlayApp"
        ),
        .testTarget(
            name: "OrcaDraftOverlayTests",
            dependencies: ["OrcaDraftOverlayCore"],
            path: "Tests/OrcaDraftOverlayTests"
        ),
    ]
)
