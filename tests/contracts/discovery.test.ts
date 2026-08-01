import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canMutateSession,
  joinDiscovery,
  markStaleHandle,
  reconcileAfterStaleHandle,
  type LogicalSession,
} from "../../plugin/src/orca/discovery.js";
import {
  makeLogicalSessionId,
  normalizeAgentState,
  paneKeyFromTerminal,
  type OrcaStatusResult,
  type OrcaTerminalListResult,
  type OrcaTerminalRecord,
  type OrcaWorktreePsResult,
  type RedactedFixtureBundle,
  type RedactedTerminalRecord,
  type RedactedWorktreeRecord,
} from "../../plugin/src/orca/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../fixtures/orca");

async function loadBundle(rel: string): Promise<RedactedFixtureBundle> {
  const raw = await readFile(path.join(FIXTURE_ROOT, rel), "utf8");
  return JSON.parse(raw) as RedactedFixtureBundle;
}

/** Lift redacted fixture shapes into join inputs with placeholder handles. */
function toJoinInput(bundle: RedactedFixtureBundle) {
  const worktrees = (bundle.worktreePs.result?.worktrees ?? []).map((wt: RedactedWorktreeRecord) => ({
    ...wt,
    agents: wt.agents.map((a) => ({
      paneKey: a.paneKey,
      parentPaneKey: a.parentPaneKey,
      state: a.state,
      agentType: a.agentType,
      toolName: a.toolName,
      interrupted: a.interrupted,
      stateStartedAt: a.stateStartedAt,
      updatedAt: a.updatedAt,
    })),
  }));

  const terminals: OrcaTerminalRecord[] = (bundle.terminalList.result?.terminals ?? []).map(
    (t: RedactedTerminalRecord, i) => ({
      handle: t.handlePlaceholder || `fixture_handle_${i}`,
      incarnationId: t.incarnationId,
      orphaned: t.orphaned,
      worktreeId: t.worktreeId,
      tabId: t.tabId,
      leafId: t.leafId,
      connected: t.connected,
      writable: t.writable,
      lastOutputAt: t.lastOutputAt,
    }),
  );

  const status = bundle.status?.result as OrcaStatusResult | undefined;
  return {
    status,
    worktreePs: { worktrees } as OrcaWorktreePsResult,
    terminalList: { terminals } as OrcaTerminalListResult,
    nowMs: 1_754_000_000_000,
  };
}

function byId(sessions: LogicalSession[]): Map<string, LogicalSession> {
  return new Map(sessions.map((s) => [s.logicalSessionId, s]));
}

describe("joinDiscovery fixtures", () => {
  it("joins local OMP states via paneKey ↔ tabId:leafId", async () => {
    const snap = joinDiscovery(toJoinInput(await loadBundle("synthetic/local-omp-states.json")));
    assert.equal(snap.orcaReady, true);
    assert.equal(snap.sessions.length, 4);
    assert.equal(snap.ambiguousCount, 0);
    for (const s of snap.sessions) {
      assert.equal(s.joinHealth, "ok");
      assert.equal(s.hostId, "local");
      assert.equal(s.agentType, "omp");
      assert.ok(s.runtimeHandle);
      assert.equal(s.paneKey, paneKeyFromTerminal(s.tabId!, s.leafId!));
      assert.equal(s.logicalSessionId, makeLogicalSessionId(s.worktreeId, s.paneKey));
      assert.equal(canMutateSession(s).allowed, true);
    }
    const states = new Set(snap.sessions.map((s) => s.state));
    assert.deepEqual([...states].sort(), ["done", "error", "waiting", "working"]);
  });

  it("joins Claude and Codex provider states", async () => {
    const snap = joinDiscovery(toJoinInput(await loadBundle("synthetic/local-claude-codex-states.json")));
    assert.equal(snap.sessions.length, 6);
    const types = new Set(snap.sessions.map((s) => s.agentType));
    assert.ok(types.has("claude"));
    assert.ok(types.has("codex"));
    assert.ok(snap.sessions.every((s) => s.joinHealth === "ok"));
  });

  it("handles SSH multi-agent and ignores shells without agents", async () => {
    const snap = joinDiscovery(toJoinInput(await loadBundle("synthetic/ssh-multi-agent.json")));
    assert.equal(snap.sessions.length, 2);
    assert.equal(snap.ignoredShellCount, 1);
    assert.ok(snap.sessions.every((s) => s.hostId === "host_ssh_1"));
    assert.ok(snap.sessions.every((s) => s.trackedAgentCountInWorktree === 2));
    assert.ok(snap.sessions.every((s) => s.joinHealth === "ok"));
  });

  it("fail-closes disconnected, missing terminal, and ambiguous joins", async () => {
    const snap = joinDiscovery(toJoinInput(await loadBundle("synthetic/disconnect-stale-ambiguous.json")));
    const map = byId(snap.sessions);
    assert.equal(snap.ambiguousCount, 1);

    const disconnected = map.get(makeLogicalSessionId("remote-app::offline", "tab_off:leaf_1"));
    assert.ok(disconnected);
    assert.equal(disconnected!.joinHealth, "disconnected");
    assert.equal(canMutateSession(disconnected!).allowed, false);
    assert.equal(canMutateSession(disconnected!).reason, "disconnected");

    const missing = map.get(makeLogicalSessionId("stale-repo::main", "tab_s:leaf_gone"));
    assert.ok(missing);
    assert.equal(missing!.joinHealth, "missing_terminal");
    assert.equal(canMutateSession(missing!).allowed, false);

    const ambiguous = map.get(makeLogicalSessionId("ambig-repo::main", "tab_m:leaf_dup"));
    assert.ok(ambiguous);
    assert.equal(ambiguous!.joinHealth, "ambiguous");
    assert.equal(ambiguous!.ambiguousHandleCount, 2);
    assert.equal(canMutateSession(ambiguous!).allowed, false);
    assert.equal(canMutateSession(ambiguous!).reason, "ambiguous");
    assert.equal(ambiguous!.runtimeHandle, undefined);
  });

  it("maps unknown agent state to unknown and still joins", async () => {
    const snap = joinDiscovery(toJoinInput(await loadBundle("synthetic/unknown-fields-states.json")));
    assert.equal(snap.sessions.length, 1);
    const s = snap.sessions[0]!;
    assert.equal(s.rawState, "compiling_widgets");
    assert.equal(s.state, "unknown");
    assert.equal(normalizeAgentState(s.rawState), "unknown");
    assert.equal(s.joinHealth, "ok");
  });
});

describe("stale handle recovery", () => {
  it("marks stale handles non-mutable and reconciles survivors by logical id", async () => {
    const before = joinDiscovery(toJoinInput(await loadBundle("synthetic/local-omp-states.json")));
    const target = before.sessions[0]!;
    const stale = markStaleHandle(target);
    assert.equal(stale.joinHealth, "stale_handle");
    assert.equal(stale.runtimeHandle, undefined);
    assert.equal(canMutateSession(stale).allowed, false);

    const afterMissing = joinDiscovery(toJoinInput(await loadBundle("synthetic/disconnect-stale-ambiguous.json")));
    const recon = reconcileAfterStaleHandle({
      previousSessionIds: before.sessions.map((s) => s.logicalSessionId),
      next: afterMissing,
    });
    assert.ok(recon.identityLostIds.includes(target.logicalSessionId));
    assert.ok(recon.newSessionIds.length >= 1);
  });
});
