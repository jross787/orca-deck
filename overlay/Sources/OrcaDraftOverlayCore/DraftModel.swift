import Foundation

/// In-memory draft session. Never touches UserDefaults, files, or pasteboard writes.
public final class DraftSessionModel: @unchecked Sendable {
    public private(set) var draft: String = ""
    public private(set) var worktreeName: String = "agent-task"
    public private(set) var nameManuallyEdited: Bool = false
    public private(set) var uiState: DraftUiState = .empty
    public private(set) var context: OverlayContextPayload = OverlayContextPayload()
    public private(set) var statusMessage: String = ""
    public private(set) var statusIsError: Bool = false
    public private(set) var pendingRequestId: String? = nil
    public private(set) var automaticResubmitBlocked: Bool = false
    public private(set) var lastActivityAt: Date = Date()

    public init() {}

    public var draftCharacterCount: Int { draft.count }
    public var draftByteCount: Int { draft.utf8.count }
    public var hasPendingOutcome: Bool { pendingRequestId != nil }
    public var canSubmit: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && uiState != .submitting
            && !hasPendingOutcome
    }

    public func touch() {
        lastActivityAt = Date()
    }

    public func applyContext(_ ctx: OverlayContextPayload) {
        context = ctx
        touch()
    }

    public func setDraft(_ text: String) {
        let clipped = String(text.prefix(OverlayProtocol.maxDraftCharacters))
        draft = clipped
        if !nameManuallyEdited {
            worktreeName = WorktreeName.derive(from: clipped)
        }
        recomputeUiState()
        touch()
    }

    public func appendDraft(_ text: String) {
        setDraft(draft + text)
    }

    public func setWorktreeName(_ name: String, manual: Bool) {
        let clipped = String(name.prefix(OverlayProtocol.maxWorktreeNameCharacters))
        worktreeName = clipped.isEmpty ? "agent-task" : clipped
        if manual { nameManuallyEdited = true }
        touch()
    }

    public func clearDraft() {
        zeroize(&draft)
        draft = ""
        if !nameManuallyEdited {
            worktreeName = "agent-task"
        }
        statusMessage = ""
        statusIsError = false
        automaticResubmitBlocked = false
        recomputeUiState()
        touch()
    }

    public func beginSubmit(requestId: String) {
        pendingRequestId = requestId
        uiState = .submitting
        statusMessage = "Submitting…"
        statusIsError = false
        touch()
    }

    public func applyOutcome(
        requestId: String,
        kind: MutationOutcomeKind,
        code: String?,
        message: String?
    ) -> OutcomeEffect {
        guard pendingRequestId == requestId else {
            return .ignored
        }
        pendingRequestId = nil
        switch kind {
        case .success:
            zeroize(&draft)
            draft = ""
            nameManuallyEdited = false
            worktreeName = "agent-task"
            automaticResubmitBlocked = false
            statusMessage = message ?? "Sent"
            statusIsError = false
            uiState = .empty
            touch()
            return .successClearAndExit
        case .failed:
            statusMessage = message ?? code ?? "Failed"
            statusIsError = true
            automaticResubmitBlocked = false
            recomputeUiState()
            touch()
            return .preserve
        case .ambiguous:
            statusMessage = message ?? "Outcome unknown — Focus required"
            statusIsError = true
            automaticResubmitBlocked = true
            recomputeUiState()
            touch()
            return .preserve
        }
    }

    public func setStatus(message: String, isError: Bool) {
        statusMessage = message
        statusIsError = isError
        touch()
    }

    public func markCancelled() {
        pendingRequestId = nil
        zeroize(&draft)
        draft = ""
        nameManuallyEdited = false
        worktreeName = "agent-task"
        statusMessage = ""
        statusIsError = false
        automaticResubmitBlocked = false
        uiState = .empty
        touch()
    }

    public func shouldExitForInactivity(
        now: Date = Date(),
        timeout: TimeInterval = OverlayProtocol.defaultInactivitySeconds
    ) -> Bool {
        if hasPendingOutcome { return false }
        return now.timeIntervalSince(lastActivityAt) >= timeout
    }

    public func stateMessage(requestId: String) -> HelperToPluginMessage {
        .state(
            requestId: requestId,
            ui: uiState,
            draftCharacters: draftCharacterCount,
            draftBytes: draftByteCount
        )
    }

    private func recomputeUiState() {
        if pendingRequestId != nil {
            uiState = .submitting
            return
        }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        uiState = trimmed.isEmpty ? .empty : .ready
    }
}

public enum OutcomeEffect: Equatable {
    case successClearAndExit
    case preserve
    case ignored
}

public enum WorktreeName {
    /// Conservative editable slug from first meaningful draft words.
    public static func derive(from draft: String, maxLength: Int = 48) -> String {
        let lowered = draft.lowercased()
        var scalars: [Character] = []
        var lastHyphen = false
        for ch in lowered {
            if ch.isLetter || ch.isNumber {
                scalars.append(ch)
                lastHyphen = false
            } else if ch.isWhitespace || ch == "-" || ch == "_" || ch == "/" {
                if !scalars.isEmpty && !lastHyphen {
                    scalars.append("-")
                    lastHyphen = true
                }
            }
            if scalars.count >= maxLength { break }
        }
        while scalars.last == "-" { scalars.removeLast() }
        while scalars.first == "-" { scalars.removeFirst() }
        let slug = String(scalars.prefix(maxLength))
        return slug.isEmpty ? "agent-task" : slug
    }
}

/// Best-effort zeroize of a Swift String buffer by overwriting then releasing.
public func zeroize(_ value: inout String) {
    if value.isEmpty { return }
    let count = value.utf8.count
    value = String(repeating: "\u{0}", count: max(count, 1))
    value = ""
}

public protocol ClipboardReading: Sendable {
    func readString() -> String?
}

public enum SuperwhisperDeepLink {
    /// Official deep links only. Optional mode then record.
    public static func urls(mode: String?) -> [URL] {
        var out: [URL] = []
        if let mode, !mode.isEmpty {
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "&=?")
            let encoded = mode.addingPercentEncoding(withAllowedCharacters: allowed) ?? mode
            if let url = URL(string: "superwhisper://mode?key=\(encoded)") {
                out.append(url)
            }
        }
        if let record = URL(string: "superwhisper://record") {
            out.append(record)
        }
        return out
    }
}
