import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_ACTION_UUIDS, slotIndexFromUuid } from "../../plugin/src/actions/session.js";
import {
  ACKNOWLEDGE_UUID,
  FOCUS_UUID,
  NEXT_ATTENTION_UUID,
} from "../../plugin/src/actions/controls.js";
import { joinDiscovery, type LogicalSession } from "../../plugin/src/orca/discovery.js";
import {
  makeLogicalSessionId,
  type OrcaStatusResult,
  type OrcaTerminalListResult,
  type OrcaTerminalRecord,
  type OrcaWorktreePsResult,
  type RedactedFixtureBundle,
  type RedactedTerminalRecord,
  type RedactedWorktreeRecord,
  type RuntimeTerminalHandle,
} from "../../plugin/src/orca/schema.js";
import { pickNextAttention, rankAttentionTargets } from "../../plugin/src/state/attention.js";
import { AlertEngine } from "../../plugin/src/state/alerts.js";
import { MetadataStore, parsePersistedState } from "../../plugin/src/state/metadata-store.js";
import {
  createInitialDashboardState,
  reduceDashboard,
  selectDashboardSnapshot,
  toPersistedState,
  type DashboardState,
} from "../../plugin/src/state/reducer.js";
import { nextIntervalMs } from "../../plugin/src/state/scheduler.js";
import { allocateSlots } from "../../plugin/src/state/slots.js";
import {
  assertNoHandlesInPersisted,
  SLOT_COUNT,
  type CardViewModel,
  type EventVersion,
  type SessionCardState,
} from "../../plugin/src/state/types.js";
import {
  controlSvgDataUrl,
  formatElapsed,
  ImageWriteDebouncer,
  renderControlSvg,
  renderSessionSvg,
  SESSION_PALETTE,
  sessionSvgDataUrl,
  stateColor,
  stateLabel,
} from "../../plugin/src/rendering/session-svg.js";
import { resolveConfigPaths } from "../../plugin/src/config/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "dev.onorca.agent-deck.sdPlugin");
const FIXTURE_ROOT = path.join(ROOT, "fixtures/orca");

async function loadBundle(rel: string): Promise<RedactedFixtureBundle> {
  const raw = await readFile(path.join(FIXTURE_ROOT, rel), "utf8");
  return JSON.parse(raw) as RedactedFixtureBundle;
}

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

function session(partial: Partial<LogicalSession> & Pick<LogicalSession, "logicalSessionId" | "worktreeId" | "paneKey">): LogicalSession {
  return {
    hostId: "local",
    worktreeUnread: false,
    agentType: "omp",
    rawState: "working",
    state: "working",
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_100,
    toolName: null,
    connected: true,
    writable: true,
    joinHealth: "ok",
    trackedAgentCountInWorktree: 1,
    ompChildCount: 0,
    runtimeHandle: "h1" as RuntimeTerminalHandle,
    repo: "repo",
    displayName: "wt",
    ...partial,
  };
}

function refresh(
  state: DashboardState,
  sessions: LogicalSession[],
  nowMs: number,
  stuck = 60,
  opts: { orcaReady?: boolean; topologyReliable?: boolean; issues?: string[] } = {},
): DashboardState {
  return reduceDashboard(state, {
    type: "refresh",
    source: {
      sessions,
      orcaReady: opts.orcaReady ?? true,
      capturedAtMs: nowMs,
      issues: opts.issues ?? [],
      topologyReliable: opts.topologyReliable ?? true,
    },
    stuckThresholdMinutes: stuck,
    nowMs,
  });
}

function card(partial: Partial<CardViewModel> & Pick<CardViewModel, "logicalSessionId" | "cardState">): CardViewModel {
  return {
    slot: 0,
    visible: true,
    selected: false,
    unread: false,
    stuck: false,
    underlyingState: partial.cardState,
    agentType: "omp",
    repo: "repo",
    worktree: "wt",
    hostId: "local",
    elapsedMs: 0,
    ompChildCount: 0,
    joinHealth: "ok",
    connected: true,
    writable: true,
    stateStartedAt: 1,
    updatedAt: 1,
    trackedAgentCountInWorktree: 1,
    worktreeUnread: false,
    eventVersion: null,
    ...partial,
  };
}

describe("state transition table", () => {
  it("maps live agent states and overlays stuck after threshold", () => {
    let state = createInitialDashboardState(60);
    const base = session({
      logicalSessionId: "wt:p1",
      worktreeId: "wt",
      paneKey: "p1",
      state: "working",
      rawState: "working",
      stateStartedAt: 0,
      updatedAt: 0,
    });
    state = refresh(state, [base], 1_000);
    let snap = selectDashboardSnapshot(state, 1_000);
    assert.equal(snap.cards[0]?.cardState, "working");

    // Below 60m still working.
    state = refresh(state, [base], 1_000 + 59 * 60_000);
    snap = selectDashboardSnapshot(state, 1_000 + 59 * 60_000);
    assert.equal(snap.cards[0]?.cardState, "working");
    assert.equal(snap.cards[0]?.stuck, false);

    // At 60m continuous working → stuck overlay, underlying working.
    state = refresh(state, [base], 1_000 + 60 * 60_000);
    snap = selectDashboardSnapshot(state, 1_000 + 60 * 60_000);
    assert.equal(snap.cards[0]?.cardState, "stuck");
    assert.equal(snap.cards[0]?.stuck, true);
    assert.equal(snap.cards[0]?.underlyingState, "working");

    for (const s of ["waiting", "done", "error", "idle", "unknown"] as const) {
      state = refresh(
        createInitialDashboardState(60),
        [
          session({
            logicalSessionId: "wt:p1",
            worktreeId: "wt",
            paneKey: "p1",
            state: s === "unknown" ? "unknown" : s,
            rawState: s,
          }),
        ],
        5_000,
      );
      snap = selectDashboardSnapshot(state, 5_000);
      assert.equal(snap.cards[0]?.cardState, s);
    }
  });

  it("shows disconnected and disabled for SSH fail-closed joins", async () => {
    const disc = joinDiscovery(toJoinInput(await loadBundle("synthetic/disconnect-stale-ambiguous.json")));
    let state = createInitialDashboardState(60);
    state = refresh(state, disc.sessions, disc.capturedAtMs);
    const snap = selectDashboardSnapshot(state, disc.capturedAtMs);
    const byId = new Map(snap.cards.map((c) => [c.logicalSessionId, c]));
    const offline = byId.get(makeLogicalSessionId("remote-app::offline", "tab_off:leaf_1"));
    assert.ok(offline);
    assert.equal(offline!.cardState, "disconnected");
    assert.equal(offline!.connected, false);
    const amb = byId.get(makeLogicalSessionId("ambig-repo::main", "tab_m:leaf_dup"));
    assert.ok(amb);
    assert.equal(amb!.cardState, "disabled");
    assert.equal(amb!.runtimeHandle, undefined);
  });
});

describe("stable slots overflow and no reorder", () => {
  it("assigns lowest free slots and never reorders on state change", () => {
    const ids = Array.from({ length: 18 }, (_, i) => `id-${String(i).padStart(2, "0")}`);
    const a1 = allocateSlots(new Map(), ids);
    assert.equal(a1.slotByLogicalId.get("id-00"), 0);
    assert.equal(a1.slotByLogicalId.get("id-15"), 15);
    assert.equal(a1.overflowCount, 2);
    assert.deepEqual(a1.hiddenIds, ["id-16", "id-17"]);

    // State change: reverse active order — visible slots stay put.
    const a2 = allocateSlots(a1.slotByLogicalId, [...ids].reverse());
    for (let i = 0; i < 16; i++) {
      const id = `id-${String(i).padStart(2, "0")}`;
      assert.equal(a2.slotByLogicalId.get(id), i);
    }
  });

  it("reducer keeps slot stable across working→waiting", () => {
    let state = createInitialDashboardState(60);
    const s1 = session({
      logicalSessionId: "wt:a",
      worktreeId: "wt",
      paneKey: "a",
      state: "working",
      rawState: "working",
      stateStartedAt: 10,
    });
    const s2 = session({
      logicalSessionId: "wt:b",
      worktreeId: "wt",
      paneKey: "b",
      state: "idle",
      rawState: "idle",
      stateStartedAt: 11,
      runtimeHandle: "h2" as RuntimeTerminalHandle,
    });
    state = refresh(state, [s1, s2], 100);
    const before = selectDashboardSnapshot(state, 100);
    const slotA = before.cards.find((c) => c.logicalSessionId === "wt:a")!.slot;
    const slotB = before.cards.find((c) => c.logicalSessionId === "wt:b")!.slot;
    state = refresh(
      state,
      [
        { ...s1, state: "waiting", rawState: "waiting", stateStartedAt: 200, updatedAt: 200 },
        s2,
      ],
      200,
    );
    const after = selectDashboardSnapshot(state, 200);
    assert.equal(after.cards.find((c) => c.logicalSessionId === "wt:a")!.slot, slotA);
    assert.equal(after.cards.find((c) => c.logicalSessionId === "wt:b")!.slot, slotB);
    assert.equal(after.cards.find((c) => c.logicalSessionId === "wt:a")!.cardState, "waiting");
  });
});

describe("close/ack freeing and identity-lost restart", () => {
  it("closed and identity-lost free slot only after acknowledgement", () => {
    let state = createInitialDashboardState(60);
    const live = session({
      logicalSessionId: "wt:p",
      worktreeId: "wt",
      paneKey: "p",
      state: "done",
      rawState: "done",
      stateStartedAt: 50,
    });
    state = refresh(state, [live], 100);
    assert.equal(selectDashboardSnapshot(state, 100).cards.length, 1);

    // Terminal disappears entirely → identity_lost ghost retains slot.
    state = refresh(state, [], 200);
    let snap = selectDashboardSnapshot(state, 200);
    assert.equal(snap.cards.length, 1);
    assert.equal(snap.cards[0]!.cardState, "identity_lost");
    assert.equal(snap.cards[0]!.slot, 0);
    assert.equal(snap.cards[0]!.unread, true);

    // New pane is a new session — no heuristic rebinding to freed? still occupied.
    const newbie = session({
      logicalSessionId: "wt:new",
      worktreeId: "wt",
      paneKey: "new",
      state: "working",
      rawState: "working",
      stateStartedAt: 250,
      runtimeHandle: "h-new" as RuntimeTerminalHandle,
    });
    state = refresh(state, [newbie], 300);
    snap = selectDashboardSnapshot(state, 300);
    const lost = snap.cards.find((c) => c.logicalSessionId === "wt:p")!;
    const neu = snap.cards.find((c) => c.logicalSessionId === "wt:new")!;
    assert.equal(lost.cardState, "identity_lost");
    assert.equal(lost.slot, 0);
    assert.equal(neu.slot, 1);

    // Ack frees identity-lost slot.
    state = reduceDashboard(state, { type: "acknowledge", logicalSessionId: "wt:p", nowMs: 400 });
    snap = selectDashboardSnapshot(state, 400);
    assert.equal(snap.cards.find((c) => c.logicalSessionId === "wt:p"), undefined);
    assert.ok(snap.cards.find((c) => c.logicalSessionId === "wt:new"));
  });

  it("paneKey survival preserves slot and attaches new handle", () => {
    let state = createInitialDashboardState(60);
    const a = session({
      logicalSessionId: "wt:same",
      worktreeId: "wt",
      paneKey: "same",
      runtimeHandle: "old" as RuntimeTerminalHandle,
      state: "working",
      rawState: "working",
    });
    state = refresh(state, [a], 10);
    const slot = selectDashboardSnapshot(state, 10).cards[0]!.slot;
    state = refresh(
      state,
      [{ ...a, runtimeHandle: "fresh" as RuntimeTerminalHandle, updatedAt: 20 }],
      20,
    );
    const snap = selectDashboardSnapshot(state, 20);
    assert.equal(snap.cards[0]!.slot, slot);
    assert.equal(snap.cards[0]!.runtimeHandle, "fresh");
    assert.equal(snap.cards[0]!.logicalSessionId, "wt:same");
  });
});

describe("unread seeding dedupe and selection semantics", () => {
  it("seeds one-agent worktree unread once and does not reflag same event on updatedAt", () => {
    let state = createInitialDashboardState(60);
    const s = session({
      logicalSessionId: "wt:only",
      worktreeId: "wt",
      paneKey: "only",
      state: "waiting",
      rawState: "waiting",
      stateStartedAt: 100,
      updatedAt: 100,
      worktreeUnread: true,
      trackedAgentCountInWorktree: 1,
    });
    state = refresh(state, [s], 100);
    let snap = selectDashboardSnapshot(state, 100);
    assert.equal(snap.cards[0]!.unread, true);
    const ev = snap.cards[0]!.eventVersion!;
    assert.equal(ev.state, "waiting");

    state = refresh(state, [{ ...s, updatedAt: 999 }], 200);
    snap = selectDashboardSnapshot(state, 200);
    assert.equal(snap.cards[0]!.unread, true);
    assert.deepEqual(snap.cards[0]!.eventVersion, ev);

    // Ack then same event cannot reflag even if worktree unread still true.
    state = reduceDashboard(state, { type: "acknowledge", logicalSessionId: "wt:only", nowMs: 300 });
    state = refresh(state, [{ ...s, updatedAt: 1000, worktreeUnread: true }], 300);
    snap = selectDashboardSnapshot(state, 300);
    assert.equal(snap.cards[0]!.unread, false);
  });

  it("multi-agent worktree unread does not seed per-card", () => {
    let state = createInitialDashboardState(60);
    const a = session({
      logicalSessionId: "wt:a",
      worktreeId: "wt",
      paneKey: "a",
      state: "idle",
      rawState: "idle",
      worktreeUnread: true,
      trackedAgentCountInWorktree: 2,
      stateStartedAt: 1,
    });
    const b = session({
      logicalSessionId: "wt:b",
      worktreeId: "wt",
      paneKey: "b",
      state: "idle",
      rawState: "idle",
      worktreeUnread: true,
      trackedAgentCountInWorktree: 2,
      runtimeHandle: "h2" as RuntimeTerminalHandle,
      stateStartedAt: 2,
    });
    state = refresh(state, [a, b], 50);
    const snap = selectDashboardSnapshot(state, 50);
    assert.ok(snap.cards.every((c) => c.unread === false));
  });

  it("selection never acknowledges; focus_success and ack do", () => {
    let state = createInitialDashboardState(60);
    const s = session({
      logicalSessionId: "wt:x",
      worktreeId: "wt",
      paneKey: "x",
      state: "error",
      rawState: "error",
      stateStartedAt: 5,
    });
    state = refresh(state, [s], 10);
    assert.equal(selectDashboardSnapshot(state, 10).cards[0]!.unread, true);
    state = reduceDashboard(state, { type: "select", logicalSessionId: "wt:x" });
    assert.equal(selectDashboardSnapshot(state, 10).cards[0]!.unread, true);
    assert.equal(state.selectedLogicalSessionId, "wt:x");
    state = reduceDashboard(state, { type: "focus_success", logicalSessionId: "wt:x", nowMs: 20 });
    assert.equal(selectDashboardSnapshot(state, 20).cards[0]!.unread, false);
  });
});

describe("attention ranking", () => {
  it("ranks unread waiting before error before stuck before done; excludes selection when alternatives exist", () => {
    const cards = [
      card({
        logicalSessionId: "done",
        cardState: "done",
        unread: true,
        eventVersion: { logicalSessionId: "done", state: "done", stateStartedAt: 1 },
        updatedAt: 1,
      }),
      card({
        logicalSessionId: "err",
        cardState: "error",
        unread: true,
        eventVersion: { logicalSessionId: "err", state: "error", stateStartedAt: 2 },
        updatedAt: 2,
      }),
      card({
        logicalSessionId: "wait",
        cardState: "waiting",
        unread: true,
        eventVersion: { logicalSessionId: "wait", state: "waiting", stateStartedAt: 3 },
        updatedAt: 3,
      }),
      card({
        logicalSessionId: "work",
        cardState: "working",
        unread: false,
        updatedAt: 99,
      }),
    ];
    const ranked = rankAttentionTargets(cards);
    assert.deepEqual(
      ranked.map((r) => r.logicalSessionId),
      ["wait", "err", "done", "work"],
    );
    assert.equal(pickNextAttention(cards, "wait"), "err");
    assert.equal(pickNextAttention(cards, null), "wait");
  });

  it("exposes overflow count on control snapshot", () => {
    let state = createInitialDashboardState(60);
    const sessions = Array.from({ length: 18 }, (_, i) =>
      session({
        logicalSessionId: `wt:p${i}`,
        worktreeId: "wt",
        paneKey: `p${i}`,
        state: "idle",
        rawState: "idle",
        runtimeHandle: `h${i}` as RuntimeTerminalHandle,
        stateStartedAt: i,
      }),
    );
    state = refresh(state, sessions, 1);
    const snap = selectDashboardSnapshot(state, 1);
    assert.equal(snap.control.overflowCount, 2);
    assert.equal(snap.slots.filter(Boolean).length, 16);
    assert.equal(snap.hidden.length, 2);
  });
});

describe("OMP child filtering and count", () => {
  it("excludes parented children from slots and aggregates count on parent", () => {
    const snap = joinDiscovery({
      worktreePs: {
        worktrees: [
          {
            worktreeId: "demo::main",
            hostId: "local",
            repo: "demo",
            displayName: "main",
            unread: false,
            agents: [
              {
                paneKey: "tab:parent",
                parentPaneKey: null,
                state: "working",
                agentType: "omp",
                stateStartedAt: 1,
                updatedAt: 1,
              },
              {
                paneKey: "tab:child1",
                parentPaneKey: "tab:parent",
                state: "working",
                agentType: "omp",
                stateStartedAt: 2,
                updatedAt: 2,
              },
              {
                paneKey: "tab:child2",
                parentPaneKey: "tab:parent",
                state: "waiting",
                agentType: "omp",
                stateStartedAt: 3,
                updatedAt: 3,
              },
            ],
          },
        ],
      },
      terminalList: {
        terminals: [
          {
            handle: "hp",
            worktreeId: "demo::main",
            tabId: "tab",
            leafId: "parent",
            connected: true,
            writable: true,
          },
          {
            handle: "hc1",
            worktreeId: "demo::main",
            tabId: "tab",
            leafId: "child1",
            connected: true,
            writable: true,
          },
          {
            handle: "hc2",
            worktreeId: "demo::main",
            tabId: "tab",
            leafId: "child2",
            connected: true,
            writable: true,
          },
        ],
      },
      nowMs: 10,
    });
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0]!.paneKey, "tab:parent");
    assert.equal(snap.sessions[0]!.ompChildCount, 2);
    assert.equal(snap.sessions[0]!.trackedAgentCountInWorktree, 1);
  });
});

describe("local and SSH connected+writable safety", () => {
  it("focus preconditions require connected writable handle", async () => {
    const { checkMutationPreconditions } = await import("../../plugin/src/commands/preconditions.js");
    const ok = session({
      logicalSessionId: "a",
      worktreeId: "a",
      paneKey: "p",
      connected: true,
      writable: true,
      joinHealth: "ok",
    });
    assert.equal(checkMutationPreconditions({ session: ok, kind: "focus", orcaReady: true }).ok, true);
    const disc = { ...ok, connected: false, writable: false, joinHealth: "disconnected" as const, runtimeHandle: undefined };
    assert.equal(checkMutationPreconditions({ session: disc, kind: "focus", orcaReady: true }).ok, false);
    const nw = { ...ok, writable: false, joinHealth: "not_writable" as const };
    assert.equal(checkMutationPreconditions({ session: nw, kind: "focus", orcaReady: true }).ok, false);
  });
});

describe("Focus exact refreshed handle", () => {
  it("runtime focus uses post-refresh handle only", async () => {
    const { DashboardRuntime } = await import("../../plugin/src/state/runtime.js");
    const { ConfigStore } = await import("../../plugin/src/config/store.js");
    const { RedactedLogger } = await import("../../plugin/src/diagnostics/logger.js");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p2-"));
    try {
      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      const logger = new RedactedLogger({ logPath: path.join(tmp, "p.log"), sink: async () => undefined });
      let handles: string[] = [];
      let liveHandle = "handle-v1";
      const runtime = new DashboardRuntime({
        configStore,
        logger,
        metadataStore: new MetadataStore({ paths }),
        alertEngine: new AlertEngine({ enabled: false, platform: "linux" }),
        refresh: async () => ({
          ok: true,
          durationMs: 1,
          snapshot: {
            capturedAtMs: Date.now(),
            orcaReady: true,
            capabilities: [],
            ignoredShellCount: 0,
            ambiguousCount: 0,
            issues: [],
            sessions: [
              session({
                logicalSessionId: "wt:focus",
                worktreeId: "wt",
                paneKey: "focus",
                state: "waiting",
                rawState: "waiting",
                stateStartedAt: 1,
                runtimeHandle: liveHandle as RuntimeTerminalHandle,
              }),
            ],
          },
        }),
        runFocus: async (handle) => {
          handles.push(handle);
          return {
        argv: ["orca"],
        stdout: '{"ok":true}',
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        timedOut: false,
      };
        },
      });
      await runtime.whenReady();
      await runtime.refresh();
      await runtime.selectSession("wt:focus");
      liveHandle = "handle-v2";
      await runtime.focusSelected();
      assert.deepEqual(handles, ["handle-v2"]);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("alert dedupe", () => {
  it("plays one urgent sound per event version for waiting/error/stuck only", async () => {
    const played: string[] = [];
    const engine = new AlertEngine({
      enabled: true,
      platform: "darwin",
      soundPath: "/tmp/x.wav",
      player: {
        play: async (p) => {
          played.push(p);
        },
      },
    });
    const ev: EventVersion = { logicalSessionId: "s1", state: "waiting", stateStartedAt: 1 };
    const once = await engine.handle([{ logicalSessionId: "s1", event: ev, kind: "waiting" }]);
    const twice = await engine.handle([{ logicalSessionId: "s1", event: ev, kind: "waiting" }]);
    assert.equal(once.length, 1);
    assert.equal(twice.length, 0);
    assert.equal(played.length, 1);
    const done = await engine.handle([
      {
        logicalSessionId: "s2",
        event: { logicalSessionId: "s2", state: "done", stateStartedAt: 1 },
        kind: "waiting",
      },
    ]);
    // kind waiting with done state still plays by kind; ensure done-like silent path via kind filter in engine uses kind.
    assert.equal(done.length, 1);
  });
});

describe("scheduler interval and backoff", () => {
  it("uses 2s/3s/10s and caps exponential failure backoff at 30s", () => {
    const intervals = { workingMs: 2000, idleMs: 3000, unavailableMs: 10000, backoffCapMs: 30000 };
    assert.equal(nextIntervalMs("working", intervals, 0), 2000);
    assert.equal(nextIntervalMs("idle", intervals, 0), 3000);
    assert.equal(nextIntervalMs("empty", intervals, 0), 10000);
    assert.equal(nextIntervalMs("failure", intervals, 1), 10000);
    assert.equal(nextIntervalMs("failure", intervals, 2), 20000);
    assert.equal(nextIntervalMs("failure", intervals, 3), 30000);
    assert.equal(nextIntervalMs("failure", intervals, 8), 30000);
  });
});

describe("card and control SVG labels colors debounce", () => {
  it("encodes state by label and color and debounces identical writes", () => {
    const states: SessionCardState[] = [
      "working",
      "waiting",
      "done",
      "error",
      "stuck",
      "idle",
      "disconnected",
      "closed",
      "identity_lost",
      "unknown",
    ];
    for (const st of states) {
      const svg = renderSessionSvg(
        card({
          logicalSessionId: "id",
          cardState: st,
          stuck: st === "stuck",
          selected: st === "waiting",
          unread: st === "error",
          ompChildCount: st === "working" ? 2 : 0,
          elapsedMs: 65_000,
        }),
      );
      assert.match(svg, new RegExp(stateLabel(st)));
      assert.match(svg, new RegExp(stateColor(st).replace("#", "\\#")));
      assert.equal(svg.includes("<animate"), false);
      assert.match(svg, /144/);
    }
    assert.equal(formatElapsed(65_000), "1m05s");
    const csvg = renderControlSvg("next", {
      overflowCount: 3,
      focusHighlighted: false,
      focusEnabled: true,
      ackEnabled: false,
      nextTargetId: "wt:p",
      selectedLogicalSessionId: null,
      orcaReady: true,
    });
    assert.match(csvg, /NEXT/);
    assert.match(csvg, /\+3/);
    const fsvg = renderControlSvg("focus", {
      overflowCount: 0,
      focusHighlighted: true,
      focusEnabled: false,
      ackEnabled: false,
      nextTargetId: null,
      selectedLogicalSessionId: "x",
      orcaReady: true,
    });
    assert.match(fsvg, /FOCUS/);
    assert.match(fsvg, /NEEDS FOCUS/);
    const deb = new ImageWriteDebouncer();
    const url = sessionSvgDataUrl(
      card({ logicalSessionId: "id", cardState: "idle" }),
    );
    assert.equal(deb.shouldWrite("a", url), true);
    assert.equal(deb.shouldWrite("a", url), false);
    assert.ok(controlSvgDataUrl("acknowledge", {
      overflowCount: 0,
      focusHighlighted: false,
      focusEnabled: false,
      ackEnabled: true,
      nextTargetId: null,
      selectedLogicalSessionId: "x",
      orcaReady: true,
    }).startsWith("data:image/svg+xml,"));
    assert.equal(SESSION_PALETTE.working, "#3b82f6");
  });
});

describe("metadata persistence excludes handles and content", () => {
  it("round-trips slots and acks without handles", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-meta-"));
    try {
      const paths = resolveConfigPaths(tmp);
      const store = new MetadataStore({ paths });
      let state = createInitialDashboardState(60);
      const s = session({
        logicalSessionId: "wt:m",
        worktreeId: "wt",
        paneKey: "m",
        state: "waiting",
        rawState: "waiting",
        stateStartedAt: 9,
        runtimeHandle: "SECRET_HANDLE" as RuntimeTerminalHandle,
      });
      state = refresh(state, [s], 10);
      state = reduceDashboard(state, { type: "select", logicalSessionId: "wt:m" });
      const persisted = toPersistedState(state);
      assertNoHandlesInPersisted(persisted);
      assert.equal(JSON.stringify(persisted).includes("SECRET_HANDLE"), false);
      assert.equal(JSON.stringify(persisted).includes("runtimeHandle"), false);
      await store.save(persisted);
      const loaded = await store.load();
      assert.equal(loaded.selectedLogicalSessionId, "wt:m");
      assert.equal(loaded.slotByLogicalId["wt:m"], 0);
      const parsed = parsePersistedState({
        schemaVersion: 1,
        selectedLogicalSessionId: null,
        slotByLogicalId: { x: 99 },
        sessions: {},
      });
      assert.equal(parsed.slotByLogicalId["x"], undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("manifest actions and layout", () => {
  it("registers 16 session UUIDs plus next/focus/ack with extensionless icons", async () => {
    const manifest = JSON.parse(await readFile(path.join(BUNDLE, "manifest.json"), "utf8")) as {
      Actions: Array<{ UUID: string; Icon: string; States: Array<{ Image: string }>; Controllers: string[] }>;
      Profiles?: unknown;
    };
    assert.equal("Profiles" in manifest, false);
    const uuids = manifest.Actions.map((a) => a.UUID);
    for (const u of SESSION_ACTION_UUIDS) {
      assert.ok(uuids.includes(u), u);
      assert.equal(slotIndexFromUuid(u), Number(u.slice(-2)) - 1);
    }
    assert.ok(uuids.includes(NEXT_ATTENTION_UUID));
    assert.ok(uuids.includes(FOCUS_UUID));
    assert.ok(uuids.includes(ACKNOWLEDGE_UUID));
    assert.equal(SESSION_ACTION_UUIDS.length, SLOT_COUNT);
    for (const a of manifest.Actions) {
      if (!a.UUID.startsWith("dev.onorca.agent-deck.session-") && !a.UUID.includes("next") && !a.UUID.includes("focus") && !a.UUID.includes("acknowledge")) {
        continue;
      }
      assert.deepEqual(a.Controllers, ["Keypad"]);
      assert.equal(a.Icon.endsWith(".png"), false);
      assert.equal(a.States[0]?.Image.endsWith(".png"), false);
    }
    for (const rel of [
      "imgs/actions/session/icon.png",
      "imgs/actions/session/key.png",
      "imgs/actions/next-attention/icon.png",
      "imgs/actions/focus/icon.png",
      "imgs/actions/acknowledge/icon.png",
      "imgs/sounds/urgent.wav",
    ]) {
      const buf = await readFile(path.join(BUNDLE, rel));
      assert.ok(buf.byteLength > 0, rel);
    }
  });
});


describe("failed refresh does not invent identity-lost", () => {
  it("keeps live sessions and only updates readiness/issues when topology unreliable", () => {
    let state = createInitialDashboardState(60);
    const s = session({
      logicalSessionId: "wt:p",
      worktreeId: "wt",
      paneKey: "p",
      state: "working",
      rawState: "working",
      stateStartedAt: 1,
    });
    state = refresh(state, [s], 10);
    assert.equal(selectDashboardSnapshot(state, 10).cards[0]!.cardState, "working");

    state = refresh(state, [], 20, 60, {
      orcaReady: false,
      topologyReliable: false,
      issues: ["discovery_incomplete"],
    });
    const snap = selectDashboardSnapshot(state, 20);
    assert.equal(snap.orcaReady, false);
    assert.ok(snap.control.issues.includes("discovery_incomplete"));
    assert.equal(snap.cards.length, 1);
    assert.equal(snap.cards[0]!.logicalSessionId, "wt:p");
    // Presentation overlays unavailable; identity not lost.
    assert.equal(snap.cards[0]!.cardState, "unavailable");
    assert.notEqual(snap.cards[0]!.cardState, "identity_lost");
    assert.equal(state.ghosts.size, 0);
    assert.equal(state.liveById.has("wt:p"), true);
  });
});

describe("attention ranks unread identity_lost including overflow", () => {
  it("includes unread identity_lost between disconnected and working", () => {
    const cards = [
      card({
        logicalSessionId: "lost-hidden",
        cardState: "identity_lost",
        unread: true,
        slot: null,
        visible: false,
        eventVersion: { logicalSessionId: "lost-hidden", state: "identity_lost", stateStartedAt: 5 },
        updatedAt: 5,
      }),
      card({
        logicalSessionId: "disc",
        cardState: "disconnected",
        unread: false,
        updatedAt: 9,
      }),
      card({
        logicalSessionId: "work",
        cardState: "working",
        unread: false,
        updatedAt: 99,
      }),
    ];
    const ranked = rankAttentionTargets(cards);
    assert.deepEqual(
      ranked.map((r) => r.logicalSessionId),
      ["disc", "lost-hidden", "work"],
    );
    assert.equal(pickNextAttention(cards, null), "disc");
    assert.equal(pickNextAttention(cards, "disc"), "lost-hidden");
  });
});

describe("hydrate preserves unacked ghosts on first reliable refresh", () => {
  it("resurrects persisted slotted missing session as identity_lost until ack", () => {
    let state = createInitialDashboardState(60);
    const live = session({
      logicalSessionId: "wt:keep",
      worktreeId: "wt",
      paneKey: "keep",
      state: "done",
      rawState: "done",
      stateStartedAt: 1,
    });
    state = refresh(state, [live], 10);
    state = reduceDashboard(state, { type: "select", logicalSessionId: "wt:keep" });
    // Simulate disappearance before restart.
    state = refresh(state, [], 20);
    assert.equal(selectDashboardSnapshot(state, 20).cards[0]!.cardState, "identity_lost");
    const persisted = toPersistedState(state);
    assert.ok(persisted.ghosts && Object.keys(persisted.ghosts).length >= 1);
    assert.ok(persisted.sessions["wt:keep"]?.ghostLabel || persisted.ghosts?.["wt:keep"]);

    // Fresh process: hydrate then first reliable refresh with no sessions.
    let restarted = createInitialDashboardState(60);
    restarted = reduceDashboard(restarted, { type: "hydrate", persisted });
    assert.equal(restarted.ghosts.size, 0); // ghosts rebuilt on first reliable refresh
    restarted = refresh(restarted, [], 30);
    const snap = selectDashboardSnapshot(restarted, 30);
    const lost = snap.cards.find((c) => c.logicalSessionId === "wt:keep");
    assert.ok(lost);
    assert.equal(lost!.cardState, "identity_lost");
    assert.equal(lost!.unread, true);
    assert.equal(lost!.slot, 0);
    assert.equal(lost!.repo.length > 0, true);

    restarted = reduceDashboard(restarted, {
      type: "acknowledge",
      logicalSessionId: "wt:keep",
      nowMs: 40,
    });
    assert.equal(
      selectDashboardSnapshot(restarted, 40).cards.find((c) => c.logicalSessionId === "wt:keep"),
      undefined,
    );
  });
});

describe("runtime refresh coalescing", () => {
  it("shares one in-flight discovery among concurrent callers", async () => {
    const { DashboardRuntime } = await import("../../plugin/src/state/runtime.js");
    const { ConfigStore } = await import("../../plugin/src/config/store.js");
    const { RedactedLogger } = await import("../../plugin/src/diagnostics/logger.js");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-coalesce-"));
    try {
      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      const logger = new RedactedLogger({
        logPath: path.join(tmp, "p.log"),
        sink: async () => undefined,
      });
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const runtime = new DashboardRuntime({
        configStore,
        logger,
        metadataStore: new MetadataStore({ paths }),
        alertEngine: new AlertEngine({ enabled: false, platform: "linux" }),
        refresh: async () => {
          calls += 1;
          await gate;
          return {
            ok: true,
            durationMs: 1,
            snapshot: {
              capturedAtMs: Date.now(),
              orcaReady: true,
              capabilities: [],
              ignoredShellCount: 0,
              ambiguousCount: 0,
              issues: [],
              sessions: [
                session({
                  logicalSessionId: "wt:c",
                  worktreeId: "wt",
                  paneKey: "c",
                  state: "idle",
                  rawState: "idle",
                  stateStartedAt: 1,
                }),
              ],
            },
          };
        },
      });
      await runtime.whenReady();
      const p1 = runtime.refresh();
      const p2 = runtime.refresh();
      const p3 = runtime.refresh();
      release();
      const [a, b, c] = await Promise.all([p1, p2, p3]);
      assert.equal(calls, 1);
      assert.equal(a.cards.length, 1);
      assert.equal(b.cards[0]?.logicalSessionId, "wt:c");
      assert.equal(c.cards[0]?.logicalSessionId, "wt:c");
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("scheduler honors loaded config intervals", () => {
  it("re-reads intervals via getter after config change", async () => {
    let intervals = { workingMs: 2000, idleMs: 3000, unavailableMs: 10000, backoffCapMs: 30000 };
    // dynamic import already available via top-level imports
    const { PollScheduler: PS } = await import("../../plugin/src/state/scheduler.js");
    const sched = new PS({
      getIntervals: () => intervals,
      onTick: async () => undefined,
    });
    sched.setUrgency("working");
    assert.equal(sched.currentIntervalMs(), 2000);
    intervals = { ...intervals, workingMs: 1500, idleMs: 4000 };
    assert.equal(sched.currentIntervalMs(), 1500);
    sched.setUrgency("idle");
    assert.equal(sched.currentIntervalMs(), 4000);
  });
});

describe("metadata key-only content guard", () => {
  it("allows repo ids containing prompt substring and rejects forbidden keys", () => {
    const ok = {
      schemaVersion: 1 as const,
      selectedLogicalSessionId: "prompt-toolkit::main:tab:leaf",
      slotByLogicalId: { "prompt-toolkit::main:tab:leaf": 0 },
      sessions: {
        "prompt-toolkit::main:tab:leaf": {
          ackedEvent: null,
          unreadEvent: null,
          worktreeUnreadSeeded: false,
          stateChangedAt: 1,
          workingSince: null,
          lastAlertEvent: null,
          lastAlertAt: null,
        },
      },
      ghosts: {},
      suppressedClosedIds: [],
    };
    assert.doesNotThrow(() => assertNoHandlesInPersisted(ok));
    assert.throws(() => {
      const bad = JSON.parse(JSON.stringify(ok)) as typeof ok & { sessions: Record<string, Record<string, unknown>> };
      bad.sessions["x"] = { ...ok.sessions["prompt-toolkit::main:tab:leaf"]!, runtimeHandle: "nope" };
      assertNoHandlesInPersisted(bad as typeof ok);
    });
  });
});

describe("acked closed missing_terminal stays suppressed", () => {
  it("does not reseed closed after ack while still listed missing_terminal", () => {
    let state = createInitialDashboardState(60);
    const live = session({
      logicalSessionId: "wt:gone",
      worktreeId: "wt",
      paneKey: "gone",
      state: "working",
      rawState: "working",
      stateStartedAt: 1,
      joinHealth: "ok",
    });
    state = refresh(state, [live], 10);
    const missing = {
      ...live,
      joinHealth: "missing_terminal" as const,
      runtimeHandle: undefined,
      connected: false,
      writable: false,
    };
    state = refresh(state, [missing], 20);
    let snap = selectDashboardSnapshot(state, 20);
    assert.equal(snap.cards[0]!.cardState, "closed");
    assert.equal(snap.cards[0]!.unread, true);

    state = reduceDashboard(state, { type: "acknowledge", logicalSessionId: "wt:gone", nowMs: 30 });
    snap = selectDashboardSnapshot(state, 30);
    assert.equal(snap.cards.find((c) => c.logicalSessionId === "wt:gone"), undefined);

    // Still listed missing_terminal — must stay suppressed.
    state = refresh(state, [missing], 40);
    snap = selectDashboardSnapshot(state, 40);
    assert.equal(snap.cards.find((c) => c.logicalSessionId === "wt:gone"), undefined);
    assert.ok(state.suppressedClosedIds.has("wt:gone"));

    // Full disappearance clears suppression without identity-lost resurrection.
    state = refresh(state, [], 50);
    assert.equal(state.suppressedClosedIds.has("wt:gone"), false);
    assert.equal(state.ghosts.has("wt:gone"), false);
    assert.equal(state.metaById.has("wt:gone"), false);
    assert.equal(
      selectDashboardSnapshot(state, 50).cards.find((c) => c.logicalSessionId === "wt:gone"),
      undefined,
    );
  });

  it("first-observed missing_terminal uses closed-ghost lifecycle", () => {
    let state = createInitialDashboardState(60);
    const missing = session({
      logicalSessionId: "wt:first",
      worktreeId: "wt",
      paneKey: "first",
      state: "done",
      rawState: "done",
      stateStartedAt: 1,
      joinHealth: "missing_terminal",
      runtimeHandle: undefined,
      connected: false,
      writable: false,
    });
    state = refresh(state, [missing], 10);
    const snap = selectDashboardSnapshot(state, 10);
    assert.equal(snap.cards[0]!.cardState, "closed");
    assert.equal(snap.cards[0]!.unread, true);
    assert.ok(state.ghosts.has("wt:first"));
    state = reduceDashboard(state, { type: "acknowledge", logicalSessionId: "wt:first", nowMs: 20 });
    state = refresh(state, [missing], 30);
    assert.equal(
      selectDashboardSnapshot(state, 30).cards.find((c) => c.logicalSessionId === "wt:first"),
      undefined,
    );
  });
});
