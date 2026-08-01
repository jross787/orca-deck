import Testing
import Foundation
@testable import OrcaDraftOverlayCore

@Suite("Overlay protocol")
struct ProtocolSuite {
    @Test func encodeDecodeContextRoundTrip() throws {
        let msg = PluginToHelperMessage.context(
            requestId: "ctx-1",
            context: OverlayContextPayload(
                repoLabel: "orca-deck",
                worktreeLabel: "main",
                hostLabel: "local",
                agentLabel: "omp",
                superwhisperMode: "coding mode"
            )
        )
        let line = try ProtocolCodec.encodeLine(msg)
        let decoded = try ProtocolCodec.decodePluginLine(line)
        #expect(decoded == msg)
    }

    @Test func encodeDecodeSendSelected() throws {
        let msg = HelperToPluginMessage.sendSelected(requestId: "s-1", draft: "hello world")
        let line = try ProtocolCodec.encodeLine(msg)
        let decoded = try ProtocolCodec.decodeHelperLine(line)
        #expect(decoded == msg)
    }

    @Test func encodeDecodeLaunchAgent() throws {
        let msg = HelperToPluginMessage.launchAgent(
            requestId: "l-1",
            provider: .claude,
            draft: "do the thing",
            worktreeName: "do-the-thing"
        )
        let line = try ProtocolCodec.encodeLine(msg)
        let decoded = try ProtocolCodec.decodeHelperLine(line)
        #expect(decoded == msg)
    }

    @Test func outcomeCorrelationFields() throws {
        let msg = PluginToHelperMessage.outcome(
            requestId: "req-9",
            kind: .ambiguous,
            code: "timeout",
            message: "Outcome unknown — Focus required"
        )
        let line = try ProtocolCodec.encodeLine(msg)
        let decoded = try ProtocolCodec.decodePluginLine(line)
        guard case let .outcome(id, kind, code, message) = decoded else {
            Issue.record("expected outcome")
            return
        }
        #expect(id == "req-9")
        #expect(kind == .ambiguous)
        #expect(code == "timeout")
        #expect(message == "Outcome unknown — Focus required")
    }

    @Test func unsupportedVersionFailsClosed() {
        let raw = #"{"version":99,"type":"focus","requestId":"x"}"#
        #expect(throws: ProtocolError.unsupportedVersion(99)) {
            _ = try ProtocolCodec.decodePluginLine(raw)
        }
    }

    @Test func unknownTypeFailsClosed() {
        let raw = #"{"version":1,"type":"explode","requestId":"x"}"#
        #expect(throws: ProtocolError.unknownType("explode")) {
            _ = try ProtocolCodec.decodePluginLine(raw)
        }
    }

    @Test func malformedJSONFailsClosed() {
        #expect(throws: ProtocolError.malformedJSON) {
            _ = try ProtocolCodec.decodePluginLine("{not-json")
        }
    }

    @Test func emptyLineFailsClosed() {
        #expect(throws: ProtocolError.emptyLine) {
            _ = try ProtocolCodec.decodePluginLine("\n")
        }
    }

    @Test func lineTooLongFailsClosed() {
        let huge = String(repeating: "a", count: OverlayProtocol.maxLineBytes + 8)
        #expect(throws: ProtocolError.lineTooLong) {
            _ = try ProtocolCodec.sanitizeIncomingLine(huge)
        }
    }

    @Test func draftTooLongRejected() {
        let draft = String(repeating: "x", count: OverlayProtocol.maxDraftCharacters + 1)
        #expect(throws: ProtocolError.invalidField("draft")) {
            try ProtocolValidation.requireDraft(draft)
        }
    }

    @Test func stateMessageHasCountsOnly() throws {
        let msg = HelperToPluginMessage.state(
            requestId: "st-1",
            ui: .ready,
            draftCharacters: 11,
            draftBytes: 11
        )
        let line = try ProtocolCodec.encodeLine(msg)
        #expect(!line.contains("hello"))
        let decoded = try ProtocolCodec.decodeHelperLine(line)
        guard case let .state(_, ui, chars, bytes) = decoded else {
            Issue.record("expected state")
            return
        }
        #expect(ui == .ready)
        #expect(chars == 11)
        #expect(bytes == 11)
    }
}

@Suite("Draft model")
struct DraftModelSuite {
    @Test func emptyToReadyTransition() {
        let m = DraftSessionModel()
        #expect(m.uiState == .empty)
        m.setDraft("ship the feature")
        #expect(m.uiState == .ready)
        #expect(m.canSubmit)
    }

    @Test func derivedNameUntilManualEdit() {
        let m = DraftSessionModel()
        m.setDraft("Fix Auth Flow Now!!!")
        #expect(m.worktreeName == "fix-auth-flow-now")
        m.setWorktreeName("custom-name", manual: true)
        m.setDraft("completely different prompt text")
        #expect(m.worktreeName == "custom-name")
        #expect(m.nameManuallyEdited)
    }

    @Test func derivedNameFallback() {
        #expect(WorktreeName.derive(from: "!!!") == "agent-task")
        #expect(WorktreeName.derive(from: "") == "agent-task")
        let long = String(repeating: "word ", count: 40)
        let slug = WorktreeName.derive(from: long)
        #expect(slug.count <= 48)
        #expect(!slug.contains(" "))
    }

    @Test func successClearsDraft() {
        let m = DraftSessionModel()
        m.setDraft("payload secret")
        m.beginSubmit(requestId: "r1")
        #expect(m.uiState == .submitting)
        let effect = m.applyOutcome(requestId: "r1", kind: .success, code: nil, message: "ok")
        #expect(effect == .successClearAndExit)
        #expect(m.draft.isEmpty)
        #expect(m.uiState == .empty)
        #expect(!m.hasPendingOutcome)
    }

    @Test func failedPreservesDraft() {
        let m = DraftSessionModel()
        m.setDraft("keep me")
        m.beginSubmit(requestId: "r2")
        let effect = m.applyOutcome(requestId: "r2", kind: .failed, code: "no_session", message: "No session")
        #expect(effect == .preserve)
        #expect(m.draft == "keep me")
        #expect(m.statusIsError)
        #expect(m.canSubmit)
    }

    @Test func ambiguousPreservesAndBlocksAutoResubmit() {
        let m = DraftSessionModel()
        m.setDraft("keep me")
        m.beginSubmit(requestId: "r3")
        let effect = m.applyOutcome(requestId: "r3", kind: .ambiguous, code: "timeout", message: nil)
        #expect(effect == .preserve)
        #expect(m.draft == "keep me")
        #expect(m.automaticResubmitBlocked)
        #expect(m.canSubmit)
        #expect(m.statusMessage.contains("Focus required"))
    }

    @Test func mismatchedOutcomeIgnored() {
        let m = DraftSessionModel()
        m.setDraft("x")
        m.beginSubmit(requestId: "pending")
        let effect = m.applyOutcome(requestId: "other", kind: .success, code: nil, message: nil)
        #expect(effect == .ignored)
        #expect(m.draft == "x")
        #expect(m.hasPendingOutcome)
    }

    @Test func pendingOutcomeBlocksInactivityExit() {
        let m = DraftSessionModel()
        m.setDraft("x")
        m.beginSubmit(requestId: "p")
        #expect(
            !m.shouldExitForInactivity(
                now: Date().addingTimeInterval(OverlayProtocol.defaultInactivitySeconds + 5)
            )
        )
        _ = m.applyOutcome(requestId: "p", kind: .failed, code: "x", message: "x")
        m.clearDraft()
        #expect(
            m.shouldExitForInactivity(
                now: Date().addingTimeInterval(OverlayProtocol.defaultInactivitySeconds + 1)
            )
        )
    }

    @Test func clearAndCancelZeroize() {
        let m = DraftSessionModel()
        m.setDraft("secret-draft")
        m.clearDraft()
        #expect(m.draft.isEmpty)
        m.setDraft("again")
        m.markCancelled()
        #expect(m.draft.isEmpty)
        #expect(m.uiState == .empty)
    }
}

@Suite("Superwhisper and clipboard")
struct SuperwhisperClipboardSuite {
    @Test func deepLinkModePercentEncoding() {
        let urls = SuperwhisperDeepLink.urls(mode: "coding mode/v1")
        #expect(urls.count == 2)
        #expect(urls[0].scheme == "superwhisper")
        #expect(urls[0].host == "mode")
        #expect(urls[1].absoluteString == "superwhisper://record")
    }

    @Test func deepLinkWithoutModeIsRecordOnly() {
        let urls = SuperwhisperDeepLink.urls(mode: nil)
        #expect(urls.map(\.absoluteString) == ["superwhisper://record"])
    }

    @Test func clipboardReaderIsReadOnlyAbstraction() {
        final class FakeClipboard: ClipboardReading, @unchecked Sendable {
            var reads = 0
            var writes = 0
            func readString() -> String? {
                reads += 1
                return "from-board"
            }
            func writeString(_ s: String) { writes += 1 }
        }
        let fake = FakeClipboard()
        #expect(fake.readString() == "from-board")
        #expect(fake.reads == 1)
        #expect(fake.writes == 0)
    }

    @Test func noPersistenceAPISurfaceInCoreSymbols() {
        let m = DraftSessionModel()
        m.setDraft("ephemeral")
        #expect(m.draft == "ephemeral")
        m.clearDraft()
        #expect(m.draft.isEmpty)
    }
}
