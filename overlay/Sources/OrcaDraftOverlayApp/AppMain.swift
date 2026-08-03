import AppKit
import Foundation
import OrcaDraftOverlayCore
import SwiftUI

/// On-demand draft overlay helper. One process, stdio NDJSON, no Orca CLI calls.
@main
enum OrcaDraftOverlayMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let bridge = OverlayBridge()
        let controller = OverlayController(bridge: bridge)
        let delegate = AppDelegate(controller: controller, bridge: bridge)
        app.delegate = delegate
        controller.onTerminate = {
            DispatchQueue.main.async {
                app.terminate(nil)
            }
        }

        // Stdin reader on a background thread; messages hop to MainActor.
        let reader = StdinLineReader()
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = reader.readLine() {
                if line.utf8.count > OverlayProtocol.maxLineBytes {
                    bridge.diag("line_too_long")
                    Task { @MainActor in
                        controller.handleMalformedPluginLine()
                    }
                    continue
                }
                do {
                    let message = try ProtocolCodec.decodePluginLine(line)
                    Task { @MainActor in
                        controller.handlePluginMessage(message)
                    }
                } catch {
                    bridge.diag("malformed_json")
                    Task { @MainActor in
                        controller.handleMalformedPluginLine()
                    }
                }
            }
            // EOF from plugin — lose draft and exit.
            bridge.diag("stdin_eof")
            Task { @MainActor in
                controller.cancel()
            }
        }

        // Inactivity watchdog — never exits while an outcome is pending.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { @MainActor in
                controller.checkInactivityAndExitIfNeeded()
            }
        }

        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller: OverlayController
    private let bridge: OverlayBridge
    private var window: NSWindow?

    init(controller: OverlayController, bridge: OverlayBridge) {
        self.controller = controller
        self.bridge = bridge
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = OverlayView(controller: controller)
        let hosting = NSHostingController(rootView: root)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Orca Draft"
        window.contentViewController = hosting
        window.center()
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.04, green: 0.05, blue: 0.06, alpha: 1)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        bridge.diag("ready")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge.close()
    }
}
