import Foundation

/// Stdio NDJSON transport. stdout = protocol only; stderr = metadata diagnostics (never draft).
public final class OverlayBridge: @unchecked Sendable {
    private let output: FileHandle
    private let errorOutput: FileHandle
    private let lock = NSLock()
    private var closed = false

    public init(output: FileHandle = .standardOutput, errorOutput: FileHandle = .standardError) {
        self.output = output
        self.errorOutput = errorOutput
    }

    public func send(_ message: HelperToPluginMessage) throws {
        let line = try ProtocolCodec.encodeLine(message)
        lock.lock()
        defer { lock.unlock() }
        if closed { return }
        if let data = line.data(using: .utf8) {
            output.write(data)
        }
    }

    public func diag(_ code: String) {
        // Metadata only — never include draft/clipboard/prompt content.
        let safe = code.replacingOccurrences(of: "\n", with: " ")
        let line = "overlay: \(safe)\n"
        if let data = line.data(using: .utf8) {
            errorOutput.write(data)
        }
    }

    public func close() {
        lock.lock()
        closed = true
        lock.unlock()
    }
}

public final class StdinLineReader: @unchecked Sendable {
    private let input: FileHandle

    public init(input: FileHandle = .standardInput) {
        self.input = input
    }

    /// Blocking read of one NDJSON line. nil = EOF.
    public func readLine() -> String? {
        var buffer = Data()
        while true {
            let chunk = input.readData(ofLength: 1)
            if chunk.isEmpty {
                if buffer.isEmpty { return nil }
                return String(data: buffer, encoding: .utf8)
            }
            if chunk[0] == 0x0A { // \n
                return String(data: buffer, encoding: .utf8).map { $0 + "\n" } ?? "\n"
            }
            buffer.append(chunk)
            if buffer.count > OverlayProtocol.maxLineBytes {
                while true {
                    let c = input.readData(ofLength: 1)
                    if c.isEmpty || c[0] == 0x0A { break }
                }
                return String(repeating: "x", count: OverlayProtocol.maxLineBytes + 1)
            }
        }
    }
}
