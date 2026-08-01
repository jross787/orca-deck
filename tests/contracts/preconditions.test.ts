import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCapabilityInspection,
  createStructuredReplyClient,
  evaluateStructuredReply,
  STRUCTURED_REPLY_RUNTIME_CAP,
  type CommandSpec,
} from "../../plugin/src/orca/capabilities.js";
import type { LogicalSession } from "../../plugin/src/orca/discovery.js";
import { checkMutationPreconditions } from "../../plugin/src/commands/preconditions.js";
import type { RuntimeTerminalHandle } from "../../plugin/src/orca/schema.js";

function session(over: Partial<LogicalSession> = {}): LogicalSession {
  return {
    logicalSessionId: "demo::main:tab:leaf",
    worktreeId: "demo::main",
    paneKey: "tab:leaf",
    hostId: "local",
    worktreeUnread: false,
    agentType: "omp",
    rawState: "waiting",
    state: "waiting",
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 2,
    toolName: null,
    runtimeHandle: "handle_ok" as RuntimeTerminalHandle,
    tabId: "tab",
    leafId: "leaf",
    connected: true,
    writable: true,
    joinHealth: "ok",
    trackedAgentCountInWorktree: 1,
    ompChildCount: 0,
    ...over,
  };
}

const blockedReply = evaluateStructuredReply({
  runtimeCapabilities: [STRUCTURED_REPLY_RUNTIME_CAP],
  publicCommands: ["status", "worktree ps", "terminal list", "terminal send", "terminal switch", "terminal close"],
});

describe("checkMutationPreconditions", () => {
  it("allows focus/send/interrupt/close only when join is healthy", () => {
    for (const kind of ["focus", "preset_send", "interrupt", "close"] as const) {
      assert.equal(checkMutationPreconditions({ session: session(), kind }).ok, true);
    }
  });

  it("blocks when orca is unavailable or session missing", () => {
    assert.equal(
      checkMutationPreconditions({ session: session(), kind: "focus", orcaReady: false }).ok,
      false,
    );
    assert.equal(checkMutationPreconditions({ session: undefined, kind: "focus" }).ok, false);
  });

  it("blocks ambiguous, disconnected, stale, missing, identity_lost", () => {
    const kinds = ["focus", "preset_send", "interrupt", "close"] as const;
    const bad: Array<Partial<LogicalSession>> = [
      { joinHealth: "ambiguous", runtimeHandle: undefined, connected: false, writable: false },
      { joinHealth: "disconnected", connected: false, writable: false },
      { joinHealth: "stale_handle", runtimeHandle: undefined, connected: false, writable: false },
      { joinHealth: "missing_terminal", runtimeHandle: undefined, connected: false, writable: false },
      { joinHealth: "identity_lost", runtimeHandle: undefined, connected: false, writable: false },
      { joinHealth: "not_writable", writable: false },
    ];
    for (const over of bad) {
      for (const kind of kinds) {
        const r = checkMutationPreconditions({ session: session(over), kind });
        assert.equal(r.ok, false, `expected block for ${JSON.stringify(over)} ${kind}`);
      }
    }
  });

  it("blocks structured_reply when public CLI contract missing", () => {
    assert.equal(blockedReply.usableViaPublicCli, false);
    assert.equal(blockedReply.status, "blocked_missing_public_cli");
    const r = checkMutationPreconditions({
      session: session(),
      kind: "structured_reply",
      structuredReply: blockedReply,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "structured_reply_unavailable");
  });
});

describe("structured reply capability", () => {
  it("reports blocking when runtime advertises cap without public query/reply", async () => {
    const commands: CommandSpec[] = [
      { command: "status", path: ["status"] },
      { command: "worktree ps", path: ["worktree", "ps"] },
      { command: "terminal list", path: ["terminal", "list"] },
      { command: "terminal send", path: ["terminal", "send"] },
      { command: "terminal switch", path: ["terminal", "switch"] },
      { command: "terminal close", path: ["terminal", "close"] },
      { command: "agent-context", path: ["agent-context"] },
    ];
    const inspection = buildCapabilityInspection({
      status: {
        runtime: {
          state: "ready",
          reachable: true,
          appVersion: "1.4.159",
          capabilities: [STRUCTURED_REPLY_RUNTIME_CAP],
        },
      },
      commands,
      inspectedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(inspection.structuredReply.usableViaPublicCli, false);
    assert.ok(inspection.blockers.some((b) => b.id === "structured_reply_public_cli_missing"));
    assert.equal(inspection.readOnlyDiscovery.worktreePs, true);
    assert.equal(inspection.mutationsAvailable.terminalSend, true);

    const client = createStructuredReplyClient(inspection);
    assert.equal(client.isAvailable(), false);
    await assert.rejects(
      () =>
        client.reply({
          terminalHandle: "h",
          optionId: "1",
          promptIdentity: "p",
          promptStartedAt: 1,
        }),
      /structured_reply_unavailable/,
    );
  });

  it("marks available only when both public commands exist", () => {
    const sr = evaluateStructuredReply({
      runtimeCapabilities: [STRUCTURED_REPLY_RUNTIME_CAP],
      publicCommands: ["terminal query", "terminal reply"],
    });
    assert.equal(sr.usableViaPublicCli, true);
    assert.equal(sr.status, "available");
  });
});
