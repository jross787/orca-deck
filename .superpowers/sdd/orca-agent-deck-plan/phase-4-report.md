# Phase 4 report — Draft overlay, Superwhisper, agent launch

## Status
**implemented and verified**

## One-line summary
On-demand SwiftUI `orca-draft-overlay` helper speaks private versioned stdio NDJSON with a single plugin `DraftCoordinator`; selected send and new-agent launch run exactly once through public Orca argv with draft text never leaving correlated request memory.

## Changed files

### Swift overlay (`overlay/`)
- `Package.swift` — macOS 14+, Swift 6; library `OrcaDraftOverlayCore` + executable `orca-draft-overlay`
- `Sources/OrcaDraftOverlayCore/Protocol.swift` — versioned NDJSON encode/decode, max lengths, fail-closed
- `Sources/OrcaDraftOverlayCore/DraftModel.swift` — in-memory draft/name lifecycle, success clear, failed/ambiguous preserve, inactivity gate while pending
- `Sources/OrcaDraftOverlayCore/Clipboard.swift` — read-only `NSPasteboard.general` import
- `Sources/OrcaDraftOverlayCore/Bridge.swift` — stdout protocol / stderr metadata diagnostics
- `Sources/OrcaDraftOverlayCore/Controller.swift` — UI↔protocol orchestration (send/launch/clear/cancel/dictate)
- `Sources/OrcaDraftOverlayCore/OverlayView.swift` — dark always-on-top editor + controls
- `Sources/OrcaDraftOverlayApp/AppMain.swift` — NSApp accessory window, stdin reader, inactivity timer
- `Tests/OrcaDraftOverlayTests/*` — protocol, model, deep-link, clipboard abstraction tests

### Plugin draft module
- `plugin/src/draft/protocol.ts` — TS mirror of private protocol; fail-closed decode
- `plugin/src/draft/commands.ts` — exact `terminal send` + `worktree create` argv builders (no `--activate`)
- `plugin/src/draft/coordinator.ts` — one helper process; request correlation; consume draft stdout; metadata-only face
- `plugin/src/draft/index.ts` — barrel

### Schema / discovery / preconditions / CLI
- `plugin/src/orca/schema.ts` — `projectId`, `projectHostSetupId` on worktree records + redacted type
- `plugin/src/orca/redact.ts` — carry project identity when safe
- `plugin/src/orca/discovery.ts` — `repoId` / `projectId` / `projectHostSetupId` on `LogicalSession` (memory only)
- `plugin/src/commands/preconditions.ts` — `draft_send` kind + nonempty text gate
- `plugin/src/orca/cli.ts` — `worktreeCreate` mutation command constant

### Runtime / render / actions
- `plugin/src/state/types.ts` — draft face metadata on `ControlViewModel` (no draft string)
- `plugin/src/state/reducer.ts` — default draft face fields
- `plugin/src/state/runtime.ts` — owns `DraftCoordinator`; fresh-handle send; exact launch; face overlay; stop tears down helper
- `plugin/src/rendering/session-svg.ts` — EMPTY/READY/SENDING/AMBIGUOUS draft faces; send/cancel/new-agent faces
- `plugin/src/actions/controls.ts` — Draft, Send Draft, Cancel Draft, New OMP/Claude/Codex stable UUIDs
- `plugin/src/plugin.ts` — registration via existing `createSafeControlActions`

### Bundle / build
- `dev.onorca.agent-deck.sdPlugin/manifest.json` — v0.4.0.0; draft + send/cancel/new-* actions; extensionless icons
- `dev.onorca.agent-deck.sdPlugin/imgs/actions/{draft,send-draft,cancel-draft,new-omp,new-claude,new-codex}/*`
- `package.json` — `build:overlay`, `test:overlay`; `build` runs overlay release copy then Rollup

### Tests / report
- `tests/contracts/phase4-draft.test.ts` — protocol, argv, coordinator, runtime send/launch, privacy, faces, manifest
- `tests/contracts/phase3-controls.test.ts` — draft UUID/asset path + SAFE_CONTROL count
- `.superpowers/sdd/orca-agent-deck-plan/phase-4-report.md` — this file

## Data flow
1. Draft key → `DashboardRuntime.openDraftOverlay()` → coordinator spawns **at most one** helper (`spawn` argv array, no shell) or focuses existing via `focus` NDJSON.
2. Plugin sends display-only `context` (repo/worktree/host/agent labels + optional Superwhisper mode). **No handles, paths, secrets, or prompt.**
3. User types / Import Clipboard (read-only pasteboard) / Dictate (`superwhisper://mode?key=…` then `superwhisper://record` only).
4. Helper emits `state` (counts + ui only) and explicit `sendSelected` / `launchAgent` with `requestId` + draft (+ name/provider).
5. Coordinator holds draft only for that correlated in-flight request:
   - **Send:** refresh/rejoin selected logical id → Phase 3 mutation preconditions → exactly one  
     `terminal send --terminal <freshHandle> --text <draft> --enter` — **never** `terminal switch`/focus.
   - **Launch:** require `projectHostSetupId` else `repoId`; exactly one  
     `worktree create --project-host-setup <id>|--repo id:<repoId> --name <name> --agent <omp|claude|codex> --prompt <draft> --setup inherit --parent-worktree worktree:<selectedWorktreeId>` — **never** `--activate`.
6. Outcome `success|failed|ambiguous` (metadata message/code only) returns to helper. Success clears + exits; failed/ambiguous **preserve draft**; ambiguous disables automatic resubmit and surfaces Focus-required. **No blind retry.**
7. Cancel/clear/EOF drop draft memory; cancel/clear never touch clipboard or selected terminal and never call Orca.
8. Logger/config/metadata/reducer see **counts/flags/codes only** — never draft bodies. Raw helper stdout objects stop at the coordinator.

## Protocol (private, versioned)
- Every message: `version:1` + opaque `requestId`
- Plugin→helper: `context` | `focus` | `outcome`
- Helper→plugin: `state` | `sendSelected` | `launchAgent` | `cancelled` | `exited`
- Max line/draft/name enforced; malformed/unknown/unsupported version **fail closed** (no mutation)

## Tests added (not run here)
### TypeScript — `tests/contracts/phase4-draft.test.ts`
- protocol decode/version/correlation/max lengths/malformed fail-close
- one helper process, repeat focus, exit cleanup
- draft never in metadata/logger
- selected send fresh-handle exact argv once, no switch; failed vs ambiguous
- launch exact argv for projectHostSetupId and repoId fallback; no activate; missing target no mutation
- controls disabled until ready; EMPTY/READY/SENDING/AMBIGUOUS SVGs; manifest UUIDs/assets
- cancel sends no Orca mutation

### Swift — `swift test --package-path overlay`
- protocol encode/decode + correlation + fail-closed
- draft transitions, derived-name/edit preservation, success clear, failure/ambiguous preserve, pending blocks inactivity exit
- clipboard abstraction read-only; Superwhisper URL percent-encoding; no persistence APIs in core model

## External blockers
- **Code signing / notarization** of `orca-draft-overlay` is out of scope for this personal milestone (local unsigned helper). External distribution must sign/notarize separately.
- **Hardware / Stream Deck device** interaction and live Superwhisper paste-into-overlay UX require physical verification on the user’s Mac.
- Phase 5 usage keys intentionally untouched.
- Structured reply / full Phase 3 option mapping remains blocked by missing public typed prompt contract (unchanged).

## Verifier commands (for a later session; not run here)
```bash
cd /Users/frank/orca/orca-deck/.worktrees/orca-agent-deck-build
swift test --package-path overlay
npm run typecheck
npm run test:contracts
npm run build
npm run validate:plugin
# optional interactive:
# dev.onorca.agent-deck.sdPlugin/bin/orca-draft-overlay
```

## Concerns
- Helper path defaults beside `plugin.js` in the bundle (`bin/orca-draft-overlay`); override with `ORCA_DRAFT_OVERLAY_PATH` for tests.
- Deck Send/New-agent keys focus the helper rather than injecting draft from the deck (helper remains sole draft memory). Mutation still executes once per correlated helper request.
- `worktree ps` on installed Orca may omit `projectHostSetupId` even when `worktree list` includes it; launch then falls back to `repoId` when present, else fails closed preserving draft.
- Inactivity exit is conservative and **never** fires while an outcome is pending.

## Verification (this session)

Protocol fix: `ProtocolCodec.decodePluginLine` / `decodeHelperLine` now `try sanitizeIncomingLine`.

Swift tests use Apple Swift Testing (`import Testing`) so `swift test --package-path overlay` works under Command Line Tools (no XCTest.framework).

```text
swift test --package-path overlay   # 24 pass / 0 fail
npm run typecheck                   # pass
npm run test:contracts              # 119 pass / 0 fail
npm run build                       # overlay release → bin/orca-draft-overlay + rollup plugin.js
npm run validate:plugin             # Validation successful
```
