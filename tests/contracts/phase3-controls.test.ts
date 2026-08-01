import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACKNOWLEDGE_UUID,
  DRAFT_PLACEHOLDER_UUID,
  FOCUS_UUID,
  INTERRUPT_CLOSE_UUID,
  NEXT_ATTENTION_UUID,
  PRESET_1_UUID,
  PRESET_2_UUID,
  PRESET_3_UUID,
  PRESET_4_UUID,
  RETRY_UUID,
  SAFE_CONTROL_UUIDS,
  STRUCTURED_REPLY_UUID,
} from "../../plugin/src/actions/controls.js";
import { SESSION_ACTION_UUIDS } from "../../plugin/src/actions/session.js";
import {
  agentTypeToPresetKey,
  buildCloseArgs,
  buildInterruptArgs,
  buildPresetSendArgs,
  resolvePresetText,
} from "../../plugin/src/commands/presets.js";
import { checkMutationPreconditions } from "../../plugin/src/commands/preconditions.js";
import { evaluateRetrySupport } from "../../plugin/src/commands/retry.js";
import { ConfigStore, DEFAULT_PRESETS, resolveConfigPaths } from "../../plugin/src/config/store.js";
import { RedactedLogger } from "../../plugin/src/diagnostics/logger.js";
import type { LogicalSession } from "../../plugin/src/orca/discovery.js";
import type { RuntimeTerminalHandle } from "../../plugin/src/orca/schema.js";
import {
  controlSvgDataUrl,
  ImageWriteDebouncer,
  renderControlSvg,
} from "../../plugin/src/rendering/session-svg.js";
import { AlertEngine } from "../../plugin/src/state/alerts.js";
import { MetadataStore } from "../../plugin/src/state/metadata-store.js";
import {
  createInitialDashboardState,
  reduceDashboard,
  selectDashboardSnapshot,
} from "../../plugin/src/state/reducer.js";
import { DashboardRuntime, type TimerHandle } from "../../plugin/src/state/runtime.js";
import { SLOT_COUNT } from "../../plugin/src/state/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "dev.onorca.agent-deck.sdPlugin");

function session(
  partial: Partial<LogicalSession> & Pick<LogicalSession, "logicalSessionId" | "worktreeId" | "paneKey">,
): LogicalSession {
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

type MutationCall = { args: string[] };

async function makeRuntime(opts: {
  tmp: string;
  liveHandle: () => string;
  sessions?: () => LogicalSession[];
  mutations: MutationCall[];
  holdMs?: number;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  nowMs?: () => number;
  logger?: RedactedLogger;
}) {
  const paths = resolveConfigPaths(opts.tmp);
  const configStore = new ConfigStore({ paths, watch: false });
  await configStore.load();
  if (opts.holdMs != null) {
    await configStore.patch({ holdToCloseMs: opts.holdMs });
  }
  const logger =
    opts.logger ??
    new RedactedLogger({ logPath: path.join(opts.tmp, "p.log"), sink: async () => undefined });
  const runtime = new DashboardRuntime({
    configStore,
    logger,
    metadataStore: new MetadataStore({ paths }),
    alertEngine: new AlertEngine({ enabled: false, platform: "linux" }),
    nowMs: opts.nowMs,
    schedule: opts.schedule,
    refresh: async () => ({
      ok: true,
      durationMs: 1,
      snapshot: {
        capturedAtMs: opts.nowMs?.() ?? Date.now(),
        orcaReady: true,
        capabilities: [],
        ignoredShellCount: 0,
        ambiguousCount: 0,
        issues: [],
        sessions: opts.sessions
          ? opts.sessions()
          : [
              session({
                logicalSessionId: "wt:s1",
                worktreeId: "wt",
                paneKey: "s1",
                state: "working",
                rawState: "working",
                agentType: "claude",
                runtimeHandle: opts.liveHandle() as RuntimeTerminalHandle,
              }),
            ],
      },
    }),
    runMutation: async (args) => {
      opts.mutations.push({ args: [...args] });
    },
    runFocus: async () => {
      opts.mutations.push({ args: ["terminal", "switch", "--FOCUS-SHOULD-NOT-RUN"] });
    },
  });
  await runtime.whenReady();
  await runtime.refresh();
  await runtime.selectSession("wt:s1");
  return { runtime, configStore, logger };
}

describe("preset provider index and exact argv", () => {
  it("resolves provider key and builds exact send argv without switch", () => {
    assert.equal(agentTypeToPresetKey("claude"), "claude");
    assert.equal(agentTypeToPresetKey("OMP"), "omp");
    assert.equal(agentTypeToPresetKey("other"), "unknown");
    const cfg = {
      presets: {
        omp: [...DEFAULT_PRESETS] as [string, string, string, string],
        claude: ["C0", "C1", "C2", "C3"] as [string, string, string, string],
        codex: [...DEFAULT_PRESETS] as [string, string, string, string],
        unknown: [...DEFAULT_PRESETS] as [string, string, string, string],
      },
    };
    assert.deepEqual(resolvePresetText(cfg, "claude", 2), { key: "claude", index: 2, text: "C2" });
    assert.deepEqual(buildPresetSendArgs("HANDLE", "C2"), [
      "terminal",
      "send",
      "--terminal",
      "HANDLE",
      "--text",
      "C2",
      "--enter",
    ]);
    assert.deepEqual(buildInterruptArgs("H"), ["terminal", "send", "--terminal", "H", "--interrupt"]);
    assert.deepEqual(buildCloseArgs("H"), ["terminal", "close", "--terminal", "H"]);
  });

  it("sends once to refreshed selected handle only; never switch; no duplicate", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3-"));
    try {
      let liveHandle = "handle-v1";
      const mutations: MutationCall[] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => liveHandle,
        mutations,
      });
      liveHandle = "handle-v2";
      await runtime.sendPreset(0, "key-preset");
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0]!.args, [
        "terminal",
        "send",
        "--terminal",
        "handle-v2",
        "--text",
        DEFAULT_PRESETS[0],
        "--enter",
      ]);
      assert.equal(mutations.some((m) => m.args.includes("switch")), false);
      await runtime.sendPreset(1, "key-preset");
      assert.equal(mutations.length, 2);
      assert.equal(mutations[1]!.args[5], DEFAULT_PRESETS[1]);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("blocks stale/ambiguous/disconnected/read-only without mutation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3b-"));
    try {
      const mutations: MutationCall[] = [];
      const blocked: Array<LogicalSession["joinHealth"]> = [
        "ambiguous",
        "disconnected",
        "not_writable",
        "stale_handle",
        "missing_terminal",
      ];
      for (const reason of blocked) {
        mutations.length = 0;
        const { runtime } = await makeRuntime({
          tmp,
          liveHandle: () => "h",
          mutations,
          sessions: () => [
            session({
              logicalSessionId: "wt:s1",
              worktreeId: "wt",
              paneKey: "s1",
              joinHealth: reason,
              connected: reason !== "disconnected",
              writable: reason !== "not_writable",
              runtimeHandle:
                reason === "missing_terminal" || reason === "stale_handle"
                  ? undefined
                  : ("h" as RuntimeTerminalHandle),
            }),
          ],
        });
        await runtime.sendPreset(0);
        assert.equal(mutations.length, 0, reason);
        runtime.stop();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("blocks empty preset text", () => {
    const gate = checkMutationPreconditions({
      session: session({ logicalSessionId: "wt:s1", worktreeId: "wt", paneKey: "s1" }),
      kind: "preset_send",
      orcaReady: true,
      presetText: "",
    });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, "empty_preset");
  });
});

describe("preset text never enters logs or diagnostics", () => {
  it("logger events omit preset body and argv text", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3log-"));
    try {
      const lines: string[] = [];
      const logger = new RedactedLogger({
        logPath: path.join(tmp, "p.log"),
        sink: async (line) => {
          lines.push(line);
        },
      });
      const mutations: MutationCall[] = [];
      const secret = "SECRET_PRESET_BODY_NEVER_LOG";
      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      await configStore.patch({
        presets: {
          omp: [secret, "b", "c", "d"],
          claude: [secret, "b", "c", "d"],
          codex: [secret, "b", "c", "d"],
          unknown: [secret, "b", "c", "d"],
        },
      });
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
                logicalSessionId: "wt:s1",
                worktreeId: "wt",
                paneKey: "s1",
                agentType: "omp",
                runtimeHandle: "h" as RuntimeTerminalHandle,
              }),
            ],
          },
        }),
        runMutation: async (args) => {
          mutations.push({ args: [...args] });
        },
      });
      await runtime.whenReady();
      await runtime.refresh();
      await runtime.selectSession("wt:s1");
      await runtime.sendPreset(0);
      assert.equal(mutations.length, 1);
      assert.ok(mutations[0]!.args.includes(secret));
      const blob = JSON.stringify(logger.events) + lines.join("\n");
      assert.equal(blob.includes(secret), false);
      assert.equal(blob.includes("--text"), false);
      assert.ok(logger.events.some((e) => e.msg === "preset_sent"));
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("retry disabled without public operation", () => {
  it("evaluateRetrySupport and runtime send nothing", async () => {
    const r = evaluateRetrySupport({
      session: session({ logicalSessionId: "a", worktreeId: "w", paneKey: "p", state: "error" }),
      publicRetryCommands: [],
    });
    assert.equal(r.supported, false);
    if (!r.supported) assert.equal(r.code, "no_public_operation");

    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3r-"));
    try {
      const mutations: MutationCall[] = [];
      const { runtime } = await makeRuntime({ tmp, liveHandle: () => "h", mutations });
      await runtime.retrySelected("retry-key");
      assert.equal(mutations.length, 0);
      const snap = runtime.getSnapshot();
      assert.equal(snap.control.retryEnabled, false);
      assert.match(snap.control.retryDetail, /FOCUS REQUIRED/);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("interrupt short release vs hold close", () => {
  it("short release sends one interrupt and never closes", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3i-"));
    try {
      const mutations: MutationCall[] = [];
      const pending: Array<{ fn: () => void | Promise<void>; ms: number }> = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "h-int",
        mutations,
        holdMs: 1500,
        schedule: (fn, ms) => {
          pending.push({ fn, ms });
          return {
            clear: () => {
              const i = pending.findIndex((p) => p.fn === fn);
              if (i >= 0) pending.splice(i, 1);
            },
          };
        },
      });
      runtime.beginInterruptHold("int-key");
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.ms, 1500);
      await runtime.endInterruptHold("int-key");
      assert.equal(pending.length, 0);
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0]!.args, [
        "terminal",
        "send",
        "--terminal",
        "h-int",
        "--interrupt",
      ]);
      assert.equal(mutations.some((m) => m.args[1] === "close"), false);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("threshold hold closes once and key-up sends no interrupt", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3c-"));
    try {
      let liveHandle = "h-close-1";
      const mutations: MutationCall[] = [];
      let fire: (() => void | Promise<void>) | null = null;
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => liveHandle,
        mutations,
        holdMs: 1500,
        schedule: (fn) => {
          fire = fn;
          return {
            clear: () => {
              fire = null;
            },
          };
        },
      });
      runtime.beginInterruptHold("int-key");
      liveHandle = "h-close-2";
      assert.ok(fire);
      await Promise.resolve((fire as () => void | Promise<void>)());
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0]!.args, ["terminal", "close", "--terminal", "h-close-2"]);
      await runtime.endInterruptHold("int-key");
      assert.equal(mutations.length, 1);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("threshold continuation does not clobber a re-begun gesture B", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3race-"));
    try {
      const mutations: MutationCall[] = [];
      let fireA: (() => void | Promise<void>) | null = null;
      let fireB: (() => void | Promise<void>) | null = null;
      let scheduleCount = 0;
      let gateRefresh = false;
      let releaseRefresh: (() => void) | undefined;
      let resolveEntered: (() => void) | undefined;

      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      await configStore.patch({ holdToCloseMs: 1500 });
      const logger = new RedactedLogger({
        logPath: path.join(tmp, "p.log"),
        sink: async () => undefined,
      });

      const runtime = new DashboardRuntime({
        configStore,
        logger,
        metadataStore: new MetadataStore({ paths }),
        alertEngine: new AlertEngine({ enabled: false, platform: "linux" }),
        schedule: (fn) => {
          scheduleCount += 1;
          if (scheduleCount === 1) fireA = fn;
          else fireB = fn;
          return {
            clear: () => {
              if (fireA === fn) fireA = null;
              if (fireB === fn) fireB = null;
            },
          };
        },
        refresh: async () => {
          if (gateRefresh) {
            const hold = new Promise<void>((resolve) => {
              releaseRefresh = resolve;
            });
            resolveEntered?.();
            await hold;
          }
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
                  logicalSessionId: "wt:s1",
                  worktreeId: "wt",
                  paneKey: "s1",
                  runtimeHandle: "h-race" as RuntimeTerminalHandle,
                }),
              ],
            },
          };
        },
        runMutation: async (args) => {
          mutations.push({ args: [...args] });
        },
      });
      await runtime.whenReady();
      await runtime.refresh();
      await runtime.selectSession("wt:s1");

      runtime.beginInterruptHold("key-a");
      assert.ok(fireA);

      // Hang A's threshold inside refresh so B can start mid-continuation.
      // (Shared refresh coalescing means B cannot refresh until A releases.)
      gateRefresh = true;
      const gateEntered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      const aDone = Promise.resolve((fireA as () => void | Promise<void>)());
      await gateEntered;

      // Rapid re-press while A is still continuing past paint/refresh.
      runtime.beginInterruptHold("key-b");
      assert.ok(fireB, "gesture B must keep its timer");

      // Let A finish; token-scoped clear must not wipe B.
      gateRefresh = false;
      releaseRefresh?.();
      await aDone;
      assert.equal(
        mutations.filter((m) => m.args[1] === "close").length,
        1,
        "A threshold still closes exactly once",
      );

      // B short-release must still interrupt after A's continuation.
      await runtime.endInterruptHold("key-b");
      assert.equal(
        mutations.some(
          (m) =>
            m.args[0] === "terminal" &&
            m.args[1] === "send" &&
            m.args.includes("--interrupt") &&
            m.args.includes("h-race"),
        ),
        true,
        "B short-release must send interrupt",
      );
      assert.equal(mutations.filter((m) => m.args.includes("--interrupt")).length, 1);
      assert.equal(mutations.filter((m) => m.args[1] === "close").length, 1);

      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("willDisappear cancels hold; release targets key-down logical id after rejoin", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3w-"));
    try {
      const mutations: MutationCall[] = [];
      let fire: (() => void) | null = null;
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "h-a",
        mutations,
        sessions: () => [
          session({
            logicalSessionId: "wt:s1",
            worktreeId: "wt",
            paneKey: "s1",
            runtimeHandle: "h-a" as RuntimeTerminalHandle,
          }),
          session({
            logicalSessionId: "wt:s2",
            worktreeId: "wt",
            paneKey: "s2",
            runtimeHandle: "h-b" as RuntimeTerminalHandle,
          }),
        ],
        holdMs: 2000,
        schedule: (fn) => {
          fire = fn;
          return {
            clear: () => {
              fire = null;
            },
          };
        },
      });
      runtime.beginInterruptHold("int-key");
      runtime.cancelInterruptHold("int-key");
      assert.equal(mutations.length, 0);
      assert.equal(fire, null);

      await runtime.selectSession("wt:s1");
      runtime.beginInterruptHold("int-key");
      await runtime.selectSession("wt:s2");
      await runtime.endInterruptHold("int-key");
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0]!.args, [
        "terminal",
        "send",
        "--terminal",
        "h-a",
        "--interrupt",
      ]);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("hot-reloads holdToCloseMs from config", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3h-"));
    try {
      const mutations: MutationCall[] = [];
      const scheduled: number[] = [];
      const { runtime, configStore } = await makeRuntime({
        tmp,
        liveHandle: () => "h",
        mutations,
        holdMs: 1500,
        schedule: (_fn, ms) => {
          scheduled.push(ms);
          return { clear: () => undefined };
        },
      });
      runtime.beginInterruptHold("k");
      runtime.cancelInterruptHold("k");
      await configStore.patch({ holdToCloseMs: 2500 });
      runtime.beginInterruptHold("k");
      runtime.cancelInterruptHold("k");
      assert.deepEqual(scheduled, [1500, 2500]);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("initiating key feedback and control SVG", () => {
  it("flashes only initiating target and paints labeled faces with debounce", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3f-"));
    try {
      const mutations: MutationCall[] = [];
      const { runtime } = await makeRuntime({ tmp, liveHandle: () => "h", mutations });
      const ok: string[] = [];
      const alert: string[] = [];
      runtime.registerControlTarget("preset-1", {
        id: "p1-a",
        setImage: async () => undefined,
        showOk: async () => {
          ok.push("p1-a");
        },
        showAlert: async () => {
          alert.push("p1-a");
        },
      });
      runtime.registerControlTarget("preset-1", {
        id: "p1-b",
        setImage: async () => undefined,
        showOk: async () => {
          ok.push("p1-b");
        },
        showAlert: async () => {
          alert.push("p1-b");
        },
      });
      await runtime.sendPreset(0, "p1-a");
      assert.deepEqual(ok, ["p1-a"]);
      assert.equal(alert.length, 0);

      const face = renderControlSvg(
        "preset-1",
        {
          overflowCount: 0,
          focusHighlighted: false,
          focusEnabled: true,
          ackEnabled: false,
          nextTargetId: null,
          selectedLogicalSessionId: "wt:s1",
          orcaReady: true,
          presetsEnabled: true,
          presetKey: "claude",
          interruptEnabled: true,
          retryEnabled: false,
          retryDetail: "FOCUS REQUIRED",
          structuredReplyEnabled: false,
          structuredReplyDetail: "REPLY UNAVAILABLE",
          mutationEnabled: true,
        },
        {},
      );
      assert.match(face, /FINISH/);
      assert.match(face, /claude/);
      const intFace = renderControlSvg(
        "interrupt-close",
        {
          overflowCount: 0,
          focusHighlighted: false,
          focusEnabled: true,
          ackEnabled: false,
          nextTargetId: null,
          selectedLogicalSessionId: "x",
          orcaReady: true,
          interruptEnabled: true,
        },
        { progress: 0.5 },
      );
      assert.match(intFace, /INT\/K/);
      assert.match(intFace, /hold 50%/);
      const retryFace = renderControlSvg(
        "retry",
        {
          overflowCount: 0,
          focusHighlighted: false,
          focusEnabled: false,
          ackEnabled: false,
          nextTargetId: null,
          selectedLogicalSessionId: null,
          orcaReady: true,
          retryEnabled: false,
          retryDetail: "FOCUS REQUIRED",
        },
        {},
      );
      assert.match(retryFace, /RETRY/);
      assert.match(retryFace, /FOCUS REQUIRED/);
      const sr = renderControlSvg(
        "structured-reply",
        {
          overflowCount: 0,
          focusHighlighted: false,
          focusEnabled: false,
          ackEnabled: false,
          nextTargetId: null,
          selectedLogicalSessionId: null,
          orcaReady: true,
          structuredReplyDetail: "REPLY UNAVAILABLE",
        },
        {},
      );
      assert.match(sr, /REPLY/);
      assert.match(sr, /REPLY UNAVAILABLE/);
      const deb = new ImageWriteDebouncer();
      const url = controlSvgDataUrl("preset-4", {
        overflowCount: 0,
        focusHighlighted: false,
        focusEnabled: true,
        ackEnabled: false,
        nextTargetId: null,
        selectedLogicalSessionId: "x",
        orcaReady: true,
        presetsEnabled: true,
        presetKey: "omp",
      });
      assert.equal(deb.shouldWrite("x", url), true);
      assert.equal(deb.shouldWrite("x", url), false);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("structured reply fail-closed", () => {
  it("sends nothing and keeps surface disabled", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "orca-deck-p3s-"));
    try {
      const mutations: MutationCall[] = [];
      const { runtime } = await makeRuntime({ tmp, liveHandle: () => "h", mutations });
      await runtime.structuredReplySelected("sr");
      assert.equal(mutations.length, 0);
      const snap = runtime.getSnapshot();
      assert.equal(snap.control.structuredReplyEnabled, false);
      assert.equal(snap.control.structuredReplyDetail, "REPLY UNAVAILABLE");
      const gate = checkMutationPreconditions({
        session: session({ logicalSessionId: "a", worktreeId: "w", paneKey: "p" }),
        kind: "structured_reply",
        orcaReady: true,
        structuredReply: {
          runtimeAdvertisesQueryReplyInput: true,
          publicCliHasTerminalQuery: false,
          publicCliHasTerminalReply: false,
          usableViaPublicCli: false,
          status: "blocked_missing_public_cli",
          detail: "blocked",
          futurePublicContract: {
            proposedCommands: ["terminal query", "terminal reply"],
            requiredFlags: [],
            notes: [],
          },
        },
      });
      assert.equal(gate.ok, false);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("control snapshot gates", () => {
  it("exposes mutation/preset/interrupt gates from selected fresh session", () => {
    let state = createInitialDashboardState(60);
    const s = session({
      logicalSessionId: "wt:s1",
      worktreeId: "wt",
      paneKey: "s1",
      agentType: "codex",
      state: "waiting",
      rawState: "waiting",
    });
    state = reduceDashboard(state, {
      type: "refresh",
      source: {
        sessions: [s],
        orcaReady: true,
        capturedAtMs: 10,
        topologyReliable: true,
        issues: [],
      },
      stuckThresholdMinutes: 60,
      nowMs: 10,
    });
    state = reduceDashboard(state, { type: "select", logicalSessionId: "wt:s1" });
    const snap = selectDashboardSnapshot(state, 10);
    assert.equal(snap.control.mutationEnabled, true);
    assert.equal(snap.control.presetsEnabled, true);
    assert.equal(snap.control.interruptEnabled, true);
    assert.equal(snap.control.presetKey, "codex");
    assert.equal(snap.control.retryEnabled, false);
    assert.equal(snap.control.structuredReplyEnabled, false);
  });
});

describe("manifest Phase 3 layout and assets", () => {
  it("registers stable UUIDs layout assets and Node24 keypad schema", async () => {
    const manifest = JSON.parse(await readFile(path.join(BUNDLE, "manifest.json"), "utf8")) as {
      Version: string;
      Actions: Array<{
        UUID: string;
        Icon: string;
        States: Array<{ Image: string }>;
        Controllers: string[];
      }>;
      Nodejs: { Version: string };
      OS: Array<{ Platform: string }>;
      Profiles?: unknown;
    };
    assert.equal("Profiles" in manifest, false);
    assert.equal(manifest.Nodejs.Version, "24");
    assert.ok(manifest.OS.some((o) => o.Platform === "mac"));
    const uuids = manifest.Actions.map((a) => a.UUID);
    for (const u of SESSION_ACTION_UUIDS) assert.ok(uuids.includes(u), u);
    assert.ok(uuids.includes(NEXT_ATTENTION_UUID));
    assert.ok(uuids.includes(FOCUS_UUID));
    assert.ok(uuids.includes(ACKNOWLEDGE_UUID));
    assert.ok(uuids.includes(INTERRUPT_CLOSE_UUID));
    assert.ok(uuids.includes(PRESET_1_UUID));
    assert.ok(uuids.includes(PRESET_2_UUID));
    assert.ok(uuids.includes(PRESET_3_UUID));
    assert.ok(uuids.includes(PRESET_4_UUID));
    assert.ok(uuids.includes(RETRY_UUID));
    assert.ok(uuids.includes(STRUCTURED_REPLY_UUID));
    assert.ok(uuids.includes(DRAFT_PLACEHOLDER_UUID));
    assert.equal(SESSION_ACTION_UUIDS.length, SLOT_COUNT);
    assert.equal(SAFE_CONTROL_UUIDS.length, 8);
    const iAck = uuids.indexOf(ACKNOWLEDGE_UUID);
    assert.equal(uuids[iAck + 1], INTERRUPT_CLOSE_UUID);
    assert.equal(uuids[iAck + 2], PRESET_1_UUID);
    assert.equal(uuids[iAck + 3], PRESET_2_UUID);
    assert.equal(uuids[iAck + 4], PRESET_3_UUID);
    assert.equal(uuids[iAck + 5], DRAFT_PLACEHOLDER_UUID);
    assert.equal(uuids[iAck + 6], PRESET_4_UUID);
    assert.equal(uuids[iAck + 7], RETRY_UUID);
    assert.equal(uuids[iAck + 8], STRUCTURED_REPLY_UUID);
    for (const a of manifest.Actions) {
      assert.deepEqual(a.Controllers, ["Keypad"]);
      assert.equal(a.Icon.endsWith(".png"), false);
      assert.equal(a.States[0]?.Image.endsWith(".png"), false);
    }
    for (const rel of [
      "imgs/actions/interrupt-close/icon.png",
      "imgs/actions/interrupt-close/key.png",
      "imgs/actions/preset-1/key.png",
      "imgs/actions/preset-2/key.png",
      "imgs/actions/preset-3/key.png",
      "imgs/actions/preset-4/key.png",
      "imgs/actions/retry/key.png",
      "imgs/actions/structured-reply/key.png",
      "imgs/actions/draft-placeholder/key.png",
    ]) {
      const buf = await readFile(path.join(BUNDLE, rel));
      assert.ok(buf.byteLength > 0, rel);
    }
  });
});
