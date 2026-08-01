import Foundation

/// Private versioned NDJSON bridge between the Stream Deck plugin and the overlay helper.
/// stdout is protocol-only. Draft/clipboard/prompt content never appears on stderr diagnostics.
public enum OverlayProtocol {
    public static let version = 1
    public static let maxLineBytes = 256 * 1024
    public static let maxDraftCharacters = 32_768
    public static let maxWorktreeNameCharacters = 64
    public static let maxLabelCharacters = 256
    public static let maxRequestIdCharacters = 128
    public static let defaultInactivitySeconds: TimeInterval = 15 * 60
}

public enum DraftUiState: String, Codable, Sendable, Equatable {
    case empty
    case editing
    case ready
    case submitting
}

public enum LaunchProvider: String, Codable, Sendable, Equatable {
    case omp
    case claude
    case codex
}

public enum MutationOutcomeKind: String, Codable, Sendable, Equatable {
    case success
    case failed
    case ambiguous
}

public struct OverlayContextPayload: Codable, Sendable, Equatable {
    public var repoLabel: String?
    public var worktreeLabel: String?
    public var hostLabel: String?
    public var agentLabel: String?
    public var superwhisperMode: String?

    public init(
        repoLabel: String? = nil,
        worktreeLabel: String? = nil,
        hostLabel: String? = nil,
        agentLabel: String? = nil,
        superwhisperMode: String? = nil
    ) {
        self.repoLabel = repoLabel
        self.worktreeLabel = worktreeLabel
        self.hostLabel = hostLabel
        self.agentLabel = agentLabel
        self.superwhisperMode = superwhisperMode
    }
}

public enum PluginToHelperMessage: Codable, Sendable, Equatable {
    case context(requestId: String, context: OverlayContextPayload)
    case focus(requestId: String)
    case outcome(requestId: String, kind: MutationOutcomeKind, code: String?, message: String?)

    private enum CodingKeys: String, CodingKey {
        case version
        case type
        case requestId
        case context
        case kind
        case code
        case message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(Int.self, forKey: .version)
        guard version == OverlayProtocol.version else {
            throw ProtocolError.unsupportedVersion(version)
        }
        let type = try c.decode(String.self, forKey: .type)
        let requestId = try c.decode(String.self, forKey: .requestId)
        try ProtocolValidation.requireRequestId(requestId)
        switch type {
        case "context":
            let ctx = try c.decode(OverlayContextPayload.self, forKey: .context)
            try ProtocolValidation.requireContext(ctx)
            self = .context(requestId: requestId, context: ctx)
        case "focus":
            self = .focus(requestId: requestId)
        case "outcome":
            let kind = try c.decode(MutationOutcomeKind.self, forKey: .kind)
            let code = try c.decodeIfPresent(String.self, forKey: .code)
            let message = try c.decodeIfPresent(String.self, forKey: .message)
            if let code { try ProtocolValidation.requireShort(code, max: 64, field: "code") }
            if let message { try ProtocolValidation.requireShort(message, max: 256, field: "message") }
            self = .outcome(requestId: requestId, kind: kind, code: code, message: message)
        default:
            throw ProtocolError.unknownType(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(OverlayProtocol.version, forKey: .version)
        switch self {
        case let .context(requestId, context):
            try c.encode("context", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(context, forKey: .context)
        case let .focus(requestId):
            try c.encode("focus", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        case let .outcome(requestId, kind, code, message):
            try c.encode("outcome", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(kind, forKey: .kind)
            try c.encodeIfPresent(code, forKey: .code)
            try c.encodeIfPresent(message, forKey: .message)
        }
    }
}

public enum HelperToPluginMessage: Codable, Sendable, Equatable {
    case state(requestId: String, ui: DraftUiState, draftCharacters: Int, draftBytes: Int)
    case sendSelected(requestId: String, draft: String)
    case launchAgent(requestId: String, provider: LaunchProvider, draft: String, worktreeName: String)
    case cancelled(requestId: String)
    case exited(requestId: String)

    private enum CodingKeys: String, CodingKey {
        case version
        case type
        case requestId
        case ui
        case draftCharacters
        case draftBytes
        case draft
        case provider
        case worktreeName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(Int.self, forKey: .version)
        guard version == OverlayProtocol.version else {
            throw ProtocolError.unsupportedVersion(version)
        }
        let type = try c.decode(String.self, forKey: .type)
        let requestId = try c.decode(String.self, forKey: .requestId)
        try ProtocolValidation.requireRequestId(requestId)
        switch type {
        case "state":
            let ui = try c.decode(DraftUiState.self, forKey: .ui)
            let chars = try c.decode(Int.self, forKey: .draftCharacters)
            let bytes = try c.decode(Int.self, forKey: .draftBytes)
            guard chars >= 0, bytes >= 0, chars <= OverlayProtocol.maxDraftCharacters else {
                throw ProtocolError.invalidField("draftCharacters")
            }
            self = .state(requestId: requestId, ui: ui, draftCharacters: chars, draftBytes: bytes)
        case "sendSelected":
            let draft = try c.decode(String.self, forKey: .draft)
            try ProtocolValidation.requireDraft(draft)
            self = .sendSelected(requestId: requestId, draft: draft)
        case "launchAgent":
            let provider = try c.decode(LaunchProvider.self, forKey: .provider)
            let draft = try c.decode(String.self, forKey: .draft)
            let name = try c.decode(String.self, forKey: .worktreeName)
            try ProtocolValidation.requireDraft(draft)
            try ProtocolValidation.requireWorktreeName(name)
            self = .launchAgent(requestId: requestId, provider: provider, draft: draft, worktreeName: name)
        case "cancelled":
            self = .cancelled(requestId: requestId)
        case "exited":
            self = .exited(requestId: requestId)
        default:
            throw ProtocolError.unknownType(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(OverlayProtocol.version, forKey: .version)
        switch self {
        case let .state(requestId, ui, draftCharacters, draftBytes):
            try c.encode("state", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(ui, forKey: .ui)
            try c.encode(draftCharacters, forKey: .draftCharacters)
            try c.encode(draftBytes, forKey: .draftBytes)
        case let .sendSelected(requestId, draft):
            try c.encode("sendSelected", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(draft, forKey: .draft)
        case let .launchAgent(requestId, provider, draft, worktreeName):
            try c.encode("launchAgent", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(provider, forKey: .provider)
            try c.encode(draft, forKey: .draft)
            try c.encode(worktreeName, forKey: .worktreeName)
        case let .cancelled(requestId):
            try c.encode("cancelled", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        case let .exited(requestId):
            try c.encode("exited", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
        }
    }
}

public enum ProtocolError: Error, Equatable, CustomStringConvertible {
    case unsupportedVersion(Int)
    case unknownType(String)
    case invalidField(String)
    case lineTooLong
    case emptyLine
    case malformedJSON

    public var description: String {
        switch self {
        case let .unsupportedVersion(v): return "unsupported_version:\(v)"
        case let .unknownType(t): return "unknown_type:\(t)"
        case let .invalidField(f): return "invalid_field:\(f)"
        case .lineTooLong: return "line_too_long"
        case .emptyLine: return "empty_line"
        case .malformedJSON: return "malformed_json"
        }
    }
}

public enum ProtocolValidation {
    public static func requireRequestId(_ value: String) throws {
        try requireShort(value, max: OverlayProtocol.maxRequestIdCharacters, field: "requestId")
        if value.isEmpty { throw ProtocolError.invalidField("requestId") }
    }

    public static func requireDraft(_ value: String) throws {
        if value.isEmpty { throw ProtocolError.invalidField("draft") }
        if value.count > OverlayProtocol.maxDraftCharacters {
            throw ProtocolError.invalidField("draft")
        }
        if value.utf8.count > OverlayProtocol.maxLineBytes / 2 {
            throw ProtocolError.invalidField("draft")
        }
    }

    public static func requireWorktreeName(_ value: String) throws {
        if value.isEmpty { throw ProtocolError.invalidField("worktreeName") }
        if value.count > OverlayProtocol.maxWorktreeNameCharacters {
            throw ProtocolError.invalidField("worktreeName")
        }
    }

    public static func requireShort(_ value: String, max: Int, field: String) throws {
        if value.count > max { throw ProtocolError.invalidField(field) }
        if value.contains("\n") || value.contains("\0") {
            throw ProtocolError.invalidField(field)
        }
    }

    public static func requireContext(_ ctx: OverlayContextPayload) throws {
        if let v = ctx.repoLabel { try requireShort(v, max: OverlayProtocol.maxLabelCharacters, field: "repoLabel") }
        if let v = ctx.worktreeLabel { try requireShort(v, max: OverlayProtocol.maxLabelCharacters, field: "worktreeLabel") }
        if let v = ctx.hostLabel { try requireShort(v, max: OverlayProtocol.maxLabelCharacters, field: "hostLabel") }
        if let v = ctx.agentLabel { try requireShort(v, max: OverlayProtocol.maxLabelCharacters, field: "agentLabel") }
        if let v = ctx.superwhisperMode { try requireShort(v, max: OverlayProtocol.maxLabelCharacters, field: "superwhisperMode") }
    }
}

public enum ProtocolCodec {
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private static let decoder = JSONDecoder()

    public static func encodeLine<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        guard data.count <= OverlayProtocol.maxLineBytes else { throw ProtocolError.lineTooLong }
        guard var line = String(data: data, encoding: .utf8) else { throw ProtocolError.malformedJSON }
        if line.contains("\n") { throw ProtocolError.malformedJSON }
        line.append("\n")
        return line
    }

    public static func decodePluginLine(_ line: String) throws -> PluginToHelperMessage {
        let trimmed = try sanitizeIncomingLine(line)
        let data = Data(trimmed.utf8)
        do {
            return try decoder.decode(PluginToHelperMessage.self, from: data)
        } catch let err as ProtocolError {
            throw err
        } catch {
            throw ProtocolError.malformedJSON
        }
    }

    public static func decodeHelperLine(_ line: String) throws -> HelperToPluginMessage {
        let trimmed = try sanitizeIncomingLine(line)
        let data = Data(trimmed.utf8)
        do {
            return try decoder.decode(HelperToPluginMessage.self, from: data)
        } catch let err as ProtocolError {
            throw err
        } catch {
            throw ProtocolError.malformedJSON
        }
    }

    public static func sanitizeIncomingLine(_ line: String) throws -> String {
        var s = line
        if s.hasSuffix("\n") { s.removeLast() }
        if s.hasSuffix("\r") { s.removeLast() }
        if s.isEmpty { throw ProtocolError.emptyLine }
        if s.utf8.count > OverlayProtocol.maxLineBytes { throw ProtocolError.lineTooLong }
        return s
    }
}
