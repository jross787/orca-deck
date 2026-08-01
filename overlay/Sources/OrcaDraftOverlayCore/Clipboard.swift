import AppKit
import Foundation

/// Read-only pasteboard access. Never mutates or clears NSPasteboard.general.
public enum SystemClipboardReader {
    public static func read() -> String? {
        let pb = NSPasteboard.general
        // Read only — do not clearContents / setString / writeObjects.
        return pb.string(forType: .string)
    }
}

public struct AppKitClipboard: ClipboardReading {
    public init() {}
    public func readString() -> String? {
        SystemClipboardReader.read()
    }
}
