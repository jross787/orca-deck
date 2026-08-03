import Combine
import AppKit
import Foundation

@MainActor
public final class OverlayController: ObservableObject {
    public private(set) var model = DraftSessionModel()
    @Published public var editorText: String = ""
    @Published public var nameText: String = "agent-task"
    @Published public var statusMessage: String = ""
    @Published public var statusIsError: Bool = false
    @Published public var uiState: DraftUiState = .empty
    @Published public var context: OverlayContextPayload = OverlayContextPayload()
    @Published public var canSubmit: Bool = false
    @Published public var nameManuallyEdited: Bool = false

    private let bridge: OverlayBridge
    private let clipboard: any ClipboardReading
    private let openURL: (URL) -> Void
    private var stateRequestCounter = 0
    private var correlationCounter = 0
    public private(set) var shouldTerminate = false
    public var onTerminate: (() -> Void)?

    public init(
        bridge: OverlayBridge = OverlayBridge(),
        clipboard: any ClipboardReading = AppKitClipboard(),
        openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }
    ) {
        self.bridge = bridge
        self.clipboard = clipboard
        self.openURL = openURL
        self.nameText = model.worktreeName
        publish()
    }

    public func handlePluginMessage(_ message: PluginToHelperMessage) {
        switch message {
        case let .context(_, context):
            model.applyContext(context)
            publish()
            emitState()
        case .focus:
            focusWindow()
            model.touch()
            publish()
            emitState()
        case let .outcome(requestId, kind, code, message):
            let effect = model.applyOutcome(requestId: requestId, kind: kind, code: code, message: message)
            syncEditorFromModel()
            publish()
            emitState()
            if effect == .successClearAndExit {
                emitExited()
                requestTerminate()
            }
        }
    }

    public func handleMalformedPluginLine() {
        bridge.diag("malformed_plugin_line")
        model.setStatus(message: "Protocol error", isError: true)
        publish()
    }

    public func onEditorChange(_ text: String) {
        editorText = text
        model.setDraft(text)
        nameText = model.worktreeName
        publish()
        emitState()
    }

    public func onNameChange(_ text: String) {
        nameText = text
        model.setWorktreeName(text, manual: true)
        publish()
        emitState()
    }

    public func importClipboard() {
        guard let text = clipboard.readString(), !text.isEmpty else {
            model.setStatus(message: "Clipboard empty", isError: true)
            publish()
            return
        }
        // Read-only import — never write/clear pasteboard.
        let next = editorText.isEmpty ? text : editorText + text
        onEditorChange(String(next.prefix(OverlayProtocol.maxDraftCharacters)))
        model.setStatus(message: "Clipboard imported", isError: false)
        publish()
    }

    public func dictate() {
        focusWindow()
        let mode = model.context.superwhisperMode
        let urls = SuperwhisperDeepLink.urls(mode: mode)
        for url in urls {
            openURL(url)
        }
        model.touch()
        model.setStatus(message: "Dictation triggered", isError: false)
        publish()
    }

    public func sendSelected() {
        guard model.canSubmit else { return }
        let requestId = nextCorrelationId(prefix: "send")
        model.beginSubmit(requestId: requestId)
        publish()
        do {
            try bridge.send(.sendSelected(requestId: requestId, draft: model.draft))
            emitState(requestId: requestId)
        } catch {
            _ = model.applyOutcome(
                requestId: requestId,
                kind: .failed,
                code: "encode_failed",
                message: "Could not encode send"
            )
            publish()
            emitState()
        }
    }

    public func launch(provider: LaunchProvider) {
        guard model.canSubmit else { return }
        let requestId = nextCorrelationId(prefix: "launch-\(provider.rawValue)")
        let name = model.worktreeName.isEmpty ? "agent-task" : model.worktreeName
        model.beginSubmit(requestId: requestId)
        publish()
        do {
            try bridge.send(
                .launchAgent(
                    requestId: requestId,
                    provider: provider,
                    draft: model.draft,
                    worktreeName: name
                )
            )
            emitState(requestId: requestId)
        } catch {
            _ = model.applyOutcome(
                requestId: requestId,
                kind: .failed,
                code: "encode_failed",
                message: "Could not encode launch"
            )
            publish()
            emitState()
        }
    }

    public func clear() {
        // Clear never touches clipboard or selected terminal.
        model.clearDraft()
        editorText = ""
        nameText = model.worktreeName
        publish()
        emitState()
    }

    public func cancel() {
        // Cancel never touches clipboard or selected terminal.
        let requestId = nextCorrelationId(prefix: "cancel")
        model.markCancelled()
        editorText = ""
        nameText = model.worktreeName
        publish()
        try? bridge.send(.cancelled(requestId: requestId))
        emitExited(requestId: requestId)
        requestTerminate()
    }

    public func checkInactivityAndExitIfNeeded(now: Date = Date()) {
        if model.shouldExitForInactivity(now: now) {
            let requestId = nextCorrelationId(prefix: "idle")
            model.markCancelled()
            publish()
            try? bridge.send(.exited(requestId: requestId))
            requestTerminate()
        }
    }

    public func focusWindow() {
        NSApp.activate(ignoringOtherApps: true)
        for window in NSApp.windows {
            window.makeKeyAndOrderFront(nil)
        }
    }

    private func publish() {
        statusMessage = model.statusMessage
        statusIsError = model.statusIsError
        uiState = model.uiState
        context = model.context
        canSubmit = model.canSubmit
        nameManuallyEdited = model.nameManuallyEdited
        if !model.nameManuallyEdited {
            nameText = model.worktreeName
        }
    }

    private func emitState(requestId: String? = nil) {
        let id = requestId ?? nextStateRequestId()
        try? bridge.send(model.stateMessage(requestId: id))
    }

    private func emitExited(requestId: String? = nil) {
        let id = requestId ?? nextCorrelationId(prefix: "exit")
        try? bridge.send(.exited(requestId: id))
    }

    private func syncEditorFromModel() {
        editorText = model.draft
        nameText = model.worktreeName
    }

    private func nextStateRequestId() -> String {
        stateRequestCounter += 1
        return "state-\(stateRequestCounter)"
    }

    private func nextCorrelationId(prefix: String) -> String {
        correlationCounter += 1
        return "\(prefix)-\(correlationCounter)-\(UUID().uuidString.prefix(8))"
    }

    private func requestTerminate() {
        shouldTerminate = true
        onTerminate?()
    }
}
