import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CANCEL_DRAFT_UUID,
  DRAFT_UUID,
  NEW_CLAUDE_UUID,
  NEW_CODEX_UUID,
  NEW_OMP_UUID,
  SAFE_CONTROL_UUIDS,
  SEND_DRAFT_UUID,
} from "../../plugin/src/actions/controls.js";
import { checkMutationPreconditions } from "../../plugin/src/commands/preconditions.js";
import { ConfigStore, resolveConfigPaths } from "../../plugin/src/config/store.js";
import { RedactedLogger } from "../../plugin/src/diagnostics/logger.js";
import {
  buildDraftSendArgs,
  buildWorktreeCreateArgs,
} from "../../plugin/src/draft/commands.js";
import {
  buildLaunchArgsForSession,
  buildOverlayContext,
  DraftCoordinator,
  resolveLaunchTarget,
} from "../../plugin/src/draft/coordinator.js";
import {
  decodeHelperMessage,
  decodePluginMessage,
  emptyDraftFaceState,
  encodeHelperMessage,
  encodePluginMessage,
  OVERLAY_LIMITS,
  OVERLAY_PROTOCOL_VERSION,
} from "../../plugin/src/draft/protocol.js";
import type { LogicalSession } from "../../plugin/src/orca/discovery.js";
import type { DiscoveryRefreshResult } from "../../plugin/src/orca/refresh.js";
import { OrcaCliError } from "../../plugin/src/orca/cli.js";
import type { RuntimeTerminalHandle } from "../../plugin/src/orca/schema.js";
import { renderControlSvg } from "../../plugin/src/rendering/session-svg.js";
import { MetadataStore } from "../../plugin/src/state/metadata-store.js";
import {
  confirmDraftCliOutcome,
  DashboardRuntime,
} from "../../plugin/src/state/runtime.js";
import type { OrcaCliResult } from "../../plugin/src/orca/cli.js";
import { toPersistedState } from "../../plugin/src/state/reducer.js";
import { assertNoHandlesInPersisted } from "../../plugin/src/state/types.js";

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
    repoId: "repo-1",
    displayName: "wt",
    ...partial,
  };
}

class FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  private stdoutPush: (chunk: string) => void;
  readonly written: string[] = [];

  constructor() {
    super();
    const self = this;
    this.stdin = new Writable({
      write(chunk, _enc, cb) {
        self.written.push(String(chunk));
        cb();
      },
    });
    let push!: (chunk: string) => void;
    this.stdout = new Readable({
      read() {},
    });
    // expose push
    push = (chunk: string) => {
      this.stdout.push(chunk);
    };
    this.stdoutPush = push;
    this.stderr = new Readable({ read() {} });
    this.stderr.push(null);
  }

  emitLine(obj: unknown) {
    this.stdoutPush(`${JSON.stringify(obj)}\n`);
  }

  kill(_sig?: string) {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}


function cliResult(partial: Partial<OrcaCliResult> & Pick<OrcaCliResult, "stdout" | "exitCode">): OrcaCliResult {
  return {
    argv: ["orca"],
    stderr: "",
    signal: null,
    durationMs: 1,
    timedOut: false,
    ...partial,
  };
}

describe("phase4 protocol", () => {
  it("encodes versioned plugin messages and decodes helper correlation", () => {
    const line = encodePluginMessage({
      version: OVERLAY_PROTOCOL_VERSION,
      type: "outcome",
      requestId: "r1",
      kind: "success",
    });
    assert.match(line, /\n$/);
    const decoded = decodePluginMessage(line);
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.value.type, "outcome");

    const helperLine = encodeHelperMessage({
      version: 1,
      type: "sendSelected",
      requestId: "s1",
      draft: "hello",
    });
    const h = decodeHelperMessage(helperLine);
    assert.equal(h.ok, true);
    if (!h.ok) return;
    assert.equal(h.value.type, "sendSelected");
    if (h.value.type === "sendSelected") assert.equal(h.value.draft, "hello");
  });

  it("fails closed on malformed, unknown type, bad version, and oversize", () => {
    assert.equal(decodeHelperMessage("").ok, false);
    assert.equal(decodeHelperMessage("{nope").ok, false);
    assert.equal(decodeHelperMessage(JSON.stringify({ version: 9, type: "state", requestId: "x" }) + "\n").ok, false);
    assert.equal(
      decodeHelperMessage(JSON.stringify({ version: 1, type: "nope", requestId: "x" }) + "\n").ok,
      false,
    );
    const huge = "x".repeat(OVERLAY_LIMITS.maxLineBytes + 10);
    assert.equal(decodeHelperMessage(huge).ok, false);
  });

  it("rejects empty draft and invalid provider", () => {
    assert.equal(
      decodeHelperMessage(
        JSON.stringify({ version: 1, type: "sendSelected", requestId: "a", draft: "" }) + "\n",
      ).ok,
      false,
    );
    assert.equal(
      decodeHelperMessage(
        JSON.stringify({
          version: 1,
          type: "launchAgent",
          requestId: "a",
          provider: "nope",
          draft: "x",
          worktreeName: "n",
        }) + "\n",
      ).ok,
      false,
    );
  });
});

describe("phase4 argv builders", () => {
  it("builds exact selected send argv without switch", () => {
    const args = buildDraftSendArgs("HANDLE", "draft text");
    assert.deepEqual(args, ["terminal", "send", "--terminal", "HANDLE", "--text", "draft text", "--enter"]);
    assert.ok(!args.includes("switch"));
    assert.ok(!args.includes("--activate"));
  });

  it("builds projectHostSetup launch argv with exact provider and no activate", () => {
    const args = buildWorktreeCreateArgs({
      target: { kind: "projectHostSetup", projectHostSetupId: "phs-1" },
      name: "agent-task",
      agent: "claude",
      prompt: "do it",
      parentWorktreeId: "wt-1",
    });
    assert.deepEqual(args, [
      "worktree",
      "create",
      "--project-host-setup",
      "phs-1",
      "--name",
      "agent-task",
      "--agent",
      "claude",
      "--prompt",
      "do it",
      "--setup",
      "inherit",
      "--parent-worktree",
      "worktree:wt-1",
    ]);
    assert.ok(!args.includes("--activate"));
  });

  it("builds repoId fallback launch argv", () => {
    const args = buildWorktreeCreateArgs({
      target: { kind: "repo", repoId: "repo-9" },
      name: "n",
      agent: "codex",
      prompt: "p",
      parentWorktreeId: "wt",
    });
    assert.equal(args[2], "--repo");
    assert.equal(args[3], "id:repo-9");
    assert.equal(args[7], "codex");
  });

  it("resolveLaunchTarget prefers projectHostSetupId then repoId", () => {
    const s = session({
      logicalSessionId: "a",
      worktreeId: "wt",
      paneKey: "p",
      projectHostSetupId: "phs",
      repoId: "r",
    });
    assert.deepEqual(resolveLaunchTarget(s), {
      kind: "projectHostSetup",
      projectHostSetupId: "phs",
    });
    const s2 = session({
      logicalSessionId: "a",
      worktreeId: "wt",
      paneKey: "p",
      repoId: "r",
    });
    assert.deepEqual(resolveLaunchTarget(s2), { kind: "repo", repoId: "r" });
    const s3 = session({ logicalSessionId: "a", worktreeId: "wt", paneKey: "p", repoId: undefined });
    assert.equal(resolveLaunchTarget(s3), null);
  });
});

describe("phase4 coordinator", () => {
  it("spawns one helper, repeat open focuses, EOF cleans up", async () => {
    const children: FakeChild[] = [];
    const logger = new RedactedLogger({ sink: async () => undefined });
    const mutations: string[][] = [];
    const coord = new DraftCoordinator({
      logger,
      helperPath: "/tmp/fake-overlay",
      spawnHelper: () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcessWithoutNullStreams;
      },
      resolveContext: () => ({
        logicalSessionId: "sid",
        context: { repoLabel: "r", hostLabel: "local" },
      }),
      sendExecutor: async () => ({ kind: "success" }),
      launchExecutor: async () => ({ kind: "success" }),
    });

    await coord.openOrFocus();
    assert.equal(children.length, 1);
    assert.equal(coord.isOpen(), true);
    await coord.openOrFocus();
    assert.equal(children.length, 1);
    // second open wrote focus
    assert.ok(children[0]!.written.some((w) => w.includes('"type":"focus"')));

    children[0]!.emit("exit", 0, null);
    assert.equal(coord.getFace().open, false);
    assert.equal(mutations.length, 0);
    coord.stop();
  });

  it("sendSelected executes once with exact argv semantics via executor", async () => {
    const child = new FakeChild();
    const calls: { draft: string; id: string }[] = [];
    const logger = new RedactedLogger({ sink: async () => undefined });
    const coord = new DraftCoordinator({
      logger,
      helperPath: "/x",
      spawnHelper: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveContext: () => ({
        logicalSessionId: "L1",
        context: {},
      }),
      sendExecutor: async (input) => {
        calls.push({ draft: input.draft, id: input.logicalSessionId });
        return { kind: "success" };
      },
      launchExecutor: async () => ({ kind: "failed", code: "x", message: "x" }),
    });
    await coord.openOrFocus();
    await coord.handleHelperMessageForTests({
      version: 1,
      type: "sendSelected",
      requestId: "req-send",
      draft: "SECRET_PROMPT",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.draft, "SECRET_PROMPT");
    assert.equal(calls[0]!.id, "L1");
    // outcome written without draft body
    assert.ok(child.written.some((w) => w.includes('"kind":"success"')));
    assert.ok(!child.written.some((w) => w.includes("SECRET_PROMPT") && w.includes("outcome")));
    coord.stop();
  });

  it("failed outcome preserves face ready; ambiguous marks face", async () => {
    const child = new FakeChild();
    const logger = new RedactedLogger({ sink: async () => undefined });
    let mode: "failed" | "ambiguous" = "failed";
    const coord = new DraftCoordinator({
      logger,
      helperPath: "/x",
      spawnHelper: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveContext: () => ({ logicalSessionId: "L1", context: {} }),
      sendExecutor: async () =>
        mode === "failed"
          ? { kind: "failed", code: "no_session", message: "No session" }
          : { kind: "ambiguous", code: "timeout", message: "Outcome unknown — Focus required" },
      launchExecutor: async () => ({ kind: "success" }),
    });
    await coord.openOrFocus();
    await coord.handleHelperMessageForTests({
      version: 1,
      type: "sendSelected",
      requestId: "r-fail",
      draft: "keep",
    });
    assert.equal(coord.getFace().ambiguous, false);
    assert.equal(coord.getFace().ui, "ready");

    mode = "ambiguous";
    await coord.handleHelperMessageForTests({
      version: 1,
      type: "sendSelected",
      requestId: "r-amb",
      draft: "keep",
    });
    assert.equal(coord.getFace().ambiguous, true);
    assert.ok(child.written.some((w) => w.includes("ambiguous")));
    coord.stop();
  });

  it("launchAgent uses executor once; cancel/exit teardown without mutation", async () => {
    const child = new FakeChild();
    const launches: string[] = [];
    const logger = new RedactedLogger({ sink: async () => undefined });
    const coord = new DraftCoordinator({
      logger,
      helperPath: "/x",
      spawnHelper: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveContext: () => ({ logicalSessionId: "L1", context: {} }),
      sendExecutor: async () => ({ kind: "success" }),
      launchExecutor: async (input) => {
        launches.push(input.provider);
        return { kind: "success" };
      },
    });
    await coord.openOrFocus();
    await coord.handleHelperMessageForTests({
      version: 1,
      type: "launchAgent",
      requestId: "l1",
      provider: "omp",
      draft: "p",
      worktreeName: "n",
    });
    assert.deepEqual(launches, ["omp"]);
    await coord.requestCancelFromDeck();
    assert.equal(coord.isOpen(), false);
    coord.stop();
  });

  it("malformed helper line never mutates", async () => {
    const child = new FakeChild();
    let sends = 0;
    const logger = new RedactedLogger({ sink: async () => undefined });
    const coord = new DraftCoordinator({
      logger,
      helperPath: "/x",
      spawnHelper: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveContext: () => ({ logicalSessionId: "L1", context: {} }),
      sendExecutor: async () => {
        sends += 1;
        return { kind: "success" };
      },
      launchExecutor: async () => ({ kind: "success" }),
    });
    await coord.openOrFocus();
    await coord.handleHelperLineForTests("{bad");
    assert.equal(sends, 0);
    coord.stop();
  });
});

describe("phase4 runtime send/launch", () => {
  async function makeRuntime(opts: {
    tmp: string;
    liveHandle: () => string;
    sessions?: () => LogicalSession[];
    mutations: string[][];
    failCode?: string;
    /** Full CLI results for draft path confirmation tests. */
    draftResults?: OrcaCliResult[];
  }) {
    const paths = resolveConfigPaths(opts.tmp);
    const configStore = new ConfigStore({ paths, watch: false });
    await configStore.load();
    const logger = new RedactedLogger({
      logPath: path.join(opts.tmp, "p.log"),
      sink: async () => undefined,
    });
    const events: unknown[] = [];
    const origInfo = logger.info.bind(logger);
    logger.info = (msg, fields, extra) => {
      events.push({ msg, fields, extra });
      origInfo(msg, fields, extra);
    };
    const runtime = new DashboardRuntime({
      configStore,
      logger,
      metadataStore: new MetadataStore({ paths }),
      refresh: async (): Promise<DiscoveryRefreshResult> => ({
        ok: true,
        durationMs: 1,
        snapshot: {
          capturedAtMs: Date.now(),
          orcaReady: true,
          sessions: (opts.sessions?.() ?? [
            session({
              logicalSessionId: "wt:p",
              worktreeId: "wt",
              paneKey: "p",
              runtimeHandle: opts.liveHandle() as RuntimeTerminalHandle,
              repoId: "repo-1",
              projectHostSetupId: "phs-1",
            }),
          ]) as LogicalSession[],
          ignoredShellCount: 0,
          ambiguousCount: 0,
          issues: [],
          capabilities: [],
        },
      }),
      runMutation: async (args) => {
        // Preset/interrupt path only — draft uses runDraftCli.
        if (opts.failCode) {
          throw new OrcaCliError(opts.failCode as "timeout", "fail", {
            argv: [...args],
            timedOut: opts.failCode === "timeout",
          });
        }
        opts.mutations.push([...args]);
      },
      runDraftCli: async (args) => {
        if (opts.failCode === "timeout") {
          throw new OrcaCliError("timeout", "fail", {
            argv: [...args],
            timedOut: true,
          });
        }
        opts.mutations.push([...args]);
        if (opts.draftResults && opts.draftResults.length > 0) {
          return opts.draftResults.shift()!;
        }
        return cliResult({
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, result: {} }),
        });
      },
      spawnDraftHelper: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
      draftHelperPath: "/tmp/fake",
    });
    await runtime.whenReady();
    await runtime.refresh();
    await runtime.selectSession("wt:p");
    return { runtime, logger, events };
  }

  it("draft send uses fresh handle exactly once and never switch", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-"));
    try {
      let handle = "H-old";
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => handle,
        mutations,
      });
      handle = "H-fresh";
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "sendSelected",
        requestId: "s1",
        draft: "PROMPT_BODY",
      });
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0], [
        "terminal",
        "send",
        "--terminal",
        "H-fresh",
        "--text",
        "PROMPT_BODY",
        "--enter",
      ]);
      assert.ok(!mutations[0]!.includes("switch"));
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("timeout send is ambiguous and does not duplicate", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        failCode: "timeout",
      });
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "sendSelected",
        requestId: "s-t",
        draft: "x",
      });
      assert.equal(mutations.length, 0); // thrown before push
      assert.equal(coord.getFace().ambiguous, true);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("launch uses projectHostSetup exact argv; missing target fails without mutation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        sessions: () => [
          session({
            logicalSessionId: "wt:p",
            worktreeId: "wt-parent",
            paneKey: "p",
            projectHostSetupId: "phs-9",
            repoId: "repo-9",
          }),
        ],
      });
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "launchAgent",
        requestId: "L",
        provider: "claude",
        draft: "launch prompt",
        worktreeName: "my-task",
      });
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0], [
        "worktree",
        "create",
        "--project-host-setup",
        "phs-9",
        "--name",
        "my-task",
        "--agent",
        "claude",
        "--prompt",
        "launch prompt",
        "--setup",
        "inherit",
        "--parent-worktree",
        "worktree:wt-parent",
      ]);
      assert.ok(!mutations[0]!.includes("--activate"));

      // missing target
      mutations.length = 0;
      const { runtime: rt2 } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        sessions: () => [
          session({
            logicalSessionId: "wt:p",
            worktreeId: "wt",
            paneKey: "p",
            repoId: undefined,
            projectHostSetupId: undefined,
          }),
        ],
      });
      const c2 = rt2.getDraftCoordinatorForTests();
      await c2.openOrFocus();
      await c2.handleHelperMessageForTests({
        version: 1,
        type: "launchAgent",
        requestId: "L2",
        provider: "omp",
        draft: "x",
        worktreeName: "n",
      });
      assert.equal(mutations.length, 0);
      rt2.stop();
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("draft never reaches metadata or logger fields", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-"));
    try {
      const mutations: string[][] = [];
      const lines: string[] = [];
      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      const logger = new RedactedLogger({
        logPath: path.join(tmp, "p.log"),
        sink: async (line) => {
          lines.push(line);
        },
      });
      const runtime = new DashboardRuntime({
        configStore,
        logger,
        metadataStore: new MetadataStore({ paths }),
        refresh: async (): Promise<DiscoveryRefreshResult> => ({
          ok: true,
          durationMs: 1,
          snapshot: {
            capturedAtMs: Date.now(),
            orcaReady: true,
            sessions: [
              session({
                logicalSessionId: "wt:p",
                worktreeId: "wt",
                paneKey: "p",
                repoId: "r1",
              }),
            ],
            ignoredShellCount: 0,
            ambiguousCount: 0,
            issues: [],
            capabilities: [],
          },
        }),
        runMutation: async (args) => {
          mutations.push([...args]);
        },
        runDraftCli: async (args) => {
          mutations.push([...args]);
          return cliResult({
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, result: {} }),
          });
        },
        spawnDraftHelper: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
        draftHelperPath: "/tmp/fake",
      });
      await runtime.whenReady();
      await runtime.refresh();
      await runtime.selectSession("wt:p");
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "sendSelected",
        requestId: "s",
        draft: "TOP_SECRET_DRAFT_BODY",
      });
      const persisted = toPersistedState(runtime.getStateForTests());
      assertNoHandlesInPersisted(persisted);
      const ser = JSON.stringify(persisted);
      assert.ok(!ser.includes("TOP_SECRET_DRAFT_BODY"));
      assert.ok(!lines.some((l) => l.includes("TOP_SECRET_DRAFT_BODY")));
      const face = runtime.getSnapshot().control;
      assert.equal("draft" in (face as object) || face.draftOpen !== undefined, true);
      // face has counts/flags only
      assert.equal((face as { draft?: string }).draft, undefined);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("cancel draft sends no Orca mutation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({ tmp, liveHandle: () => "H", mutations });
      await runtime.openDraftOverlay();
      await runtime.cancelDraftOverlay();
      assert.equal(mutations.length, 0);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("send nonzero-with-stdout JSON preserves draft (failed, not success)", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-nz-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        draftResults: [
          cliResult({
            exitCode: 3,
            stdout: JSON.stringify({ ok: true, result: { sent: false } }),
          }),
        ],
      });
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "sendSelected",
        requestId: "nz-send",
        draft: "KEEP_DRAFT_BODY",
      });
      assert.equal(mutations.length, 1);
      assert.equal(coord.getFace().ui, "ready");
      assert.equal(coord.getFace().ambiguous, false);
      assert.equal(coord.getFace().lastCode, "non_zero_exit");
      // success would tear down helper on exited; failed keeps open face ready
      assert.equal(coord.isOpen(), true);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("send ok:false exit0 preserves draft as failed", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-okf-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        draftResults: [
          cliResult({
            exitCode: 0,
            stdout: JSON.stringify({ ok: false, error: "blocked" }),
          }),
        ],
      });
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "sendSelected",
        requestId: "okf-send",
        draft: "KEEP_ME",
      });
      assert.equal(mutations.length, 1);
      assert.equal(coord.getFace().ui, "ready");
      assert.equal(coord.getFace().lastCode, "envelope_not_ok");
      assert.equal(coord.isOpen(), true);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("launch nonzero any JSON shape fails and preserves; ok:false fails", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p4-lnz-"));
    try {
      const mutations: string[][] = [];
      const { runtime } = await makeRuntime({
        tmp,
        liveHandle: () => "H1",
        mutations,
        draftResults: [
          cliResult({
            exitCode: 1,
            stdout: JSON.stringify({ ok: false, error: "exists" }),
          }),
          cliResult({
            exitCode: 0,
            stdout: JSON.stringify({ ok: false, error: "denied" }),
          }),
        ],
      });
      const coord = runtime.getDraftCoordinatorForTests();
      await coord.openOrFocus();
      await coord.handleHelperMessageForTests({
        version: 1,
        type: "launchAgent",
        requestId: "lnz",
        provider: "omp",
        draft: "launch-keep",
        worktreeName: "n1",
      });
      assert.equal(mutations.length, 1);
      assert.equal(coord.getFace().lastCode, "non_zero_exit");
      assert.equal(coord.getFace().ui, "ready");

      await coord.handleHelperMessageForTests({
        version: 1,
        type: "launchAgent",
        requestId: "lokf",
        provider: "claude",
        draft: "launch-keep-2",
        worktreeName: "n2",
      });
      assert.equal(mutations.length, 2);
      assert.equal(coord.getFace().lastCode, "envelope_not_ok");
      assert.equal(coord.getFace().ui, "ready");
      assert.equal(coord.isOpen(), true);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});


describe("phase4 draft CLI confirmation", () => {
  it("confirmDraftCliOutcome requires exit 0 and not ok:false", () => {
    assert.equal(
      confirmDraftCliOutcome(
        cliResult({ exitCode: 0, stdout: JSON.stringify({ ok: true }) }),
        "x",
      ).kind,
      "success",
    );
    assert.equal(
      confirmDraftCliOutcome(
        cliResult({ exitCode: 0, stdout: JSON.stringify({ result: {} }) }),
        "x",
      ).kind,
      "success",
    );
    const nz = confirmDraftCliOutcome(
      cliResult({
        exitCode: 2,
        stdout: JSON.stringify({ ok: true, result: { ignored: true } }),
      }),
      "Send failed",
    );
    assert.equal(nz.kind, "failed");
    assert.equal(nz.kind === "failed" && nz.code, "non_zero_exit");

    const badOk = confirmDraftCliOutcome(
      cliResult({ exitCode: 0, stdout: JSON.stringify({ ok: false, error: "nope" }) }),
      "Send failed",
    );
    assert.equal(badOk.kind, "failed");
    assert.equal(badOk.kind === "failed" && badOk.code, "envelope_not_ok");

    const empty = confirmDraftCliOutcome(cliResult({ exitCode: 0, stdout: "  " }), "x");
    assert.equal(empty.kind, "ambiguous");

    const badJson = confirmDraftCliOutcome(cliResult({ exitCode: 0, stdout: "{nope" }), "x");
    assert.equal(badJson.kind, "ambiguous");

    const timed = confirmDraftCliOutcome(
      cliResult({ exitCode: null, stdout: "", timedOut: true }),
      "x",
    );
    assert.equal(timed.kind, "ambiguous");
    assert.equal(timed.kind === "ambiguous" && timed.code, "timeout");
  });
});

describe("phase4 faces and manifest", () => {
  it("disables new-agent until draft ready; shows EMPTY/READY/SENDING/AMBIGUOUS", () => {
    const base = {
      selectedLogicalSessionId: null,
      nextTargetId: null,
      overflowCount: 0,
      focusHighlighted: false,
      focusEnabled: false,
      ackEnabled: false,
      orcaReady: true,
      draftOpen: true,
      draftUi: "empty" as const,
      draftCharacters: 0,
      draftReady: false,
      draftAmbiguous: false,
      draftDetail: "EMPTY",
      newAgentEnabled: false,
    };
    assert.match(renderControlSvg("draft", base), /EMPTY/);
    assert.match(renderControlSvg("new-omp", base), /need draft/);
    const ready = {
      ...base,
      draftUi: "ready" as const,
      draftCharacters: 3,
      draftReady: true,
      draftDetail: "READY",
      newAgentEnabled: true,
    };
    assert.match(renderControlSvg("draft", ready), /READY/);
    assert.match(renderControlSvg("new-claude", ready), /launch/);
    assert.match(
      renderControlSvg("draft", { ...ready, draftUi: "submitting", draftDetail: "SENDING", draftReady: false }),
      /SENDING/,
    );
    assert.match(
      renderControlSvg("draft", { ...ready, draftAmbiguous: true, draftDetail: "AMBIGUOUS" }),
      /AMBIGUOUS/,
    );
  });

  it("manifest has draft action UUIDs and assets", async () => {
    const manifest = JSON.parse(await readFile(path.join(BUNDLE, "manifest.json"), "utf8")) as {
      Version: string;
      Actions: Array<{ UUID: string; Icon: string; States: Array<{ Image: string }> }>;
    };
    assert.equal(manifest.Version.startsWith("0.4"), true);
    const uuids = new Set(manifest.Actions.map((a) => a.UUID));
    for (const u of [
      DRAFT_UUID,
      SEND_DRAFT_UUID,
      CANCEL_DRAFT_UUID,
      NEW_OMP_UUID,
      NEW_CLAUDE_UUID,
      NEW_CODEX_UUID,
    ]) {
      assert.ok(uuids.has(u), u);
    }
    for (const u of SAFE_CONTROL_UUIDS) assert.ok(uuids.has(u), u);
    for (const dir of ["draft", "send-draft", "cancel-draft", "new-omp", "new-claude", "new-codex"]) {
      await readFile(path.join(BUNDLE, "imgs/actions", dir, "key.png"));
      await readFile(path.join(BUNDLE, "imgs/actions", dir, "icon.png"));
    }
  });

  it("overlay context is display-only labels", () => {
    const ctx = buildOverlayContext(
      session({
        logicalSessionId: "a",
        worktreeId: "wt",
        paneKey: "p",
        repo: "orca-deck",
        displayName: "main",
        hostId: "local",
        agentType: "omp",
      }),
      { superwhisper: { mode: "coding" } },
    );
    assert.equal(ctx.repoLabel, "orca-deck");
    assert.equal(ctx.superwhisperMode, "coding");
    assert.equal((ctx as { runtimeHandle?: string }).runtimeHandle, undefined);
  });

  it("draft_send precondition requires nonempty text and mutable session", () => {
    const ok = checkMutationPreconditions({
      session: session({ logicalSessionId: "a", worktreeId: "w", paneKey: "p" }),
      kind: "draft_send",
      orcaReady: true,
      presetText: "hi",
    });
    assert.equal(ok.ok, true);
    const empty = checkMutationPreconditions({
      session: session({ logicalSessionId: "a", worktreeId: "w", paneKey: "p" }),
      kind: "draft_send",
      orcaReady: true,
      presetText: "",
    });
    assert.equal(empty.ok, false);
  });

  it("empty draft face helper", () => {
    assert.deepEqual(emptyDraftFaceState().ui, "empty");
  });

  it("buildLaunchArgsForSession wires parent worktree", () => {
    const args = buildLaunchArgsForSession(
      session({
        logicalSessionId: "a",
        worktreeId: "WTID",
        paneKey: "p",
        repoId: "RID",
      }),
      "omp",
      "prompt",
      "name",
    );
    assert.ok(args);
    assert.ok(args!.includes("worktree:WTID"));
    assert.ok(args!.includes("id:RID"));
  });
});
