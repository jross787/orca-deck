/**
 * One on-demand overlay helper session. Plugin is sole Orca authority.
 * Draft strings live only in correlated request memory — never config/metadata/logger.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RedactedLogger } from "../diagnostics/logger.js";
import type { LogicalSession } from "../orca/discovery.js";
import type { DeckConfig } from "../config/store.js";
import {
  buildDraftSendArgs,
  buildWorktreeCreateArgs,
  type LaunchTarget,
} from "./commands.js";
import {
  decodeHelperMessage,
  emptyDraftFaceState,
  encodePluginMessage,
  type DraftFaceState,
  type DraftUiState,
  type HelperToPluginMessage,
  type LaunchProvider,
  type MutationOutcomeKind,
  type OverlayContextPayload,
  type PluginToHelperMessage,
} from "./protocol.js";

export type DraftMutationOutcome =
  | { kind: "success" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "ambiguous"; code: string; message: string };

export type DraftSendExecutor = (input: {
  logicalSessionId: string;
  draft: string;
  requestId: string;
}) => Promise<DraftMutationOutcome>;

export type DraftLaunchExecutor = (input: {
  logicalSessionId: string;
  provider: LaunchProvider;
  draft: string;
  worktreeName: string;
  requestId: string;
}) => Promise<DraftMutationOutcome>;

export type DraftContextResolver = () => {
  logicalSessionId: string | null;
  context: OverlayContextPayload;
};

export type DraftCoordinatorDeps = {
  logger: RedactedLogger;
  /** Absolute path to orca-draft-overlay binary. */
  helperPath?: string;
  spawnHelper?: (helperPath: string) => ChildProcessWithoutNullStreams;
  sendExecutor: DraftSendExecutor;
  launchExecutor: DraftLaunchExecutor;
  resolveContext: DraftContextResolver;
  onFaceChange?: (face: DraftFaceState) => void;
  nowMs?: () => number;
};

type PendingKind = "sendSelected" | "launchAgent";

type PendingRequest = {
  requestId: string;
  kind: PendingKind;
  logicalSessionId: string;
  /** Held only for the in-flight correlated request; dropped on settle. */
  draft: string;
  provider?: LaunchProvider;
  worktreeName?: string;
  startedAtMs: number;
};

function defaultHelperPath(): string {
  // plugin.js lives at sdPlugin/bin/plugin.js → helper beside it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In source/tests, fall back to bundle path from repo root resolution by env/override.
  const bundleGuess = path.resolve(here, "../../dev.onorca.agent-deck.sdPlugin/bin/orca-draft-overlay");
  const besidePlugin = path.resolve(here, "orca-draft-overlay");
  return process.env.ORCA_DRAFT_OVERLAY_PATH ?? besidePlugin;
}

function defaultSpawn(helperPath: string): ChildProcessWithoutNullStreams {
  return spawn(helperPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: { ...process.env, // no draft content injected
    },
  });
}

export class DraftCoordinator {
  private readonly deps: DraftCoordinatorDeps;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private face: DraftFaceState = emptyDraftFaceState();
  private pending: PendingRequest | null = null;
  private sessionLogicalId: string | null = null;
  private starting = false;
  private requestSeq = 0;

  constructor(deps: DraftCoordinatorDeps) {
    this.deps = deps;
  }

  getFace(): DraftFaceState {
    return { ...this.face };
  }

  /** True when helper process is live. */
  isOpen(): boolean {
    return this.child != null && !this.child.killed;
  }

  /**
   * Start helper or focus existing. Passes display-only selected context.
   * At most one helper process.
   */
  async openOrFocus(): Promise<void> {
    const resolved = this.deps.resolveContext();
    this.sessionLogicalId = resolved.logicalSessionId;
    if (this.isOpen()) {
      await this.write({
        version: 1,
        type: "context",
        requestId: this.nextId("ctx"),
        context: resolved.context,
      });
      await this.write({
        version: 1,
        type: "focus",
        requestId: this.nextId("focus"),
      });
      return;
    }
    if (this.starting) return;
    this.starting = true;
    try {
      await this.spawnAndBind();
      await this.write({
        version: 1,
        type: "context",
        requestId: this.nextId("ctx"),
        context: resolved.context,
      });
    } finally {
      this.starting = false;
    }
  }

  /** Deck key: ask helper to send (helper owns draft). No-op if closed. */
  async requestSendFromDeck(): Promise<void> {
    // Deck cannot inject draft; focus helper so user hits Send there,
    // or if already ready the helper is authoritative. Focus only.
    if (!this.isOpen()) {
      await this.openOrFocus();
      return;
    }
    await this.write({
      version: 1,
      type: "focus",
      requestId: this.nextId("focus"),
    });
  }

  async requestCancelFromDeck(): Promise<void> {
    if (!this.isOpen()) return;
    // Closing stdin ends helper; helper cancel path preferred via focus.
    // We tear down without mutation.
    this.teardown("deck_cancel");
  }

  /** Test/helper: inject a decoded helper message as if from stdout. */
  async handleHelperMessageForTests(message: HelperToPluginMessage): Promise<void> {
    await this.onHelperMessage(message);
  }

  /** Test/helper: simulate raw stdout line. */
  async handleHelperLineForTests(line: string): Promise<void> {
    await this.onHelperLine(line);
  }

  stop(): void {
    this.teardown("stop");
  }

  private async spawnAndBind(): Promise<void> {
    const helperPath = this.deps.helperPath ?? defaultHelperPath();
    const spawnFn = this.deps.spawnHelper ?? defaultSpawn;
    const child = spawnFn(helperPath);
    this.child = child;
    this.face = {
      ...emptyDraftFaceState(),
      open: true,
      ui: "empty",
    };
    this.emitFace();

    this.readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => {
      void this.onHelperLine(line);
    });

    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8").trim();
      // stderr diagnostics from helper are metadata-only by contract.
      if (text) {
        this.deps.logger.info("overlay_stderr", { code: text.slice(0, 120) });
      }
    });

    const clear = () => {
      if (this.child === child) this.teardown("child_exit");
    };
    child.on("exit", clear);
    child.on("error", (err) => {
      this.deps.logger.error("overlay_spawn_failed", {
        code: err instanceof Error ? err.name : "error",
      });
      if (this.child === child) this.teardown("spawn_error");
    });
  }

  private async onHelperLine(line: string): Promise<void> {
    const decoded = decodeHelperMessage(line.endsWith("\n") ? line : `${line}\n`);
    if (!decoded.ok) {
      this.deps.logger.warn("overlay_protocol_error", {
        issue: decoded.issue,
      });
      // Fail closed: do not execute mutations on malformed lines.
      return;
    }
    // Consume raw message here — draft never escapes this coordinator.
    await this.onHelperMessage(decoded.value);
  }

  private async onHelperMessage(message: HelperToPluginMessage): Promise<void> {
    switch (message.type) {
      case "state":
        this.face = {
          ...this.face,
          open: true,
          ui: message.ui,
          draftCharacters: message.draftCharacters,
          draftBytes: message.draftBytes,
        };
        this.emitFace();
        return;
      case "cancelled":
      case "exited":
        this.pending = null;
        this.teardown(message.type);
        return;
      case "sendSelected":
        await this.executeSend(message.requestId, message.draft);
        return;
      case "launchAgent":
        await this.executeLaunch(
          message.requestId,
          message.provider,
          message.draft,
          message.worktreeName,
        );
        return;
      default:
        return;
    }
  }

  private async executeSend(requestId: string, draft: string): Promise<void> {
    if (this.pending) {
      // Exactly one correlated in-flight mutation.
      await this.sendOutcome(requestId, "failed", "busy", "Draft request already in flight");
      return;
    }
    const logicalSessionId = this.sessionLogicalId;
    if (!logicalSessionId) {
      await this.sendOutcome(requestId, "failed", "no_session", "No logical session selected");
      return;
    }
    this.pending = {
      requestId,
      kind: "sendSelected",
      logicalSessionId,
      draft,
      startedAtMs: this.now(),
    };
    this.face = {
      ...this.face,
      ui: "submitting",
      pendingRequestId: requestId,
      ambiguous: false,
    };
    this.emitFace();

    let outcome: DraftMutationOutcome;
    try {
      outcome = await this.deps.sendExecutor({
        logicalSessionId,
        draft,
        requestId,
      });
    } catch {
      outcome = {
        kind: "ambiguous",
        code: "exception",
        message: "Outcome unknown — Focus required",
      };
    }
    // Drop draft from pending memory on settle.
    if (this.pending?.requestId === requestId) this.pending = null;
    await this.applyExecutorOutcome(requestId, outcome);
  }

  private async executeLaunch(
    requestId: string,
    provider: LaunchProvider,
    draft: string,
    worktreeName: string,
  ): Promise<void> {
    if (this.pending) {
      await this.sendOutcome(requestId, "failed", "busy", "Draft request already in flight");
      return;
    }
    const logicalSessionId = this.sessionLogicalId;
    if (!logicalSessionId) {
      await this.sendOutcome(requestId, "failed", "no_session", "No logical session selected");
      return;
    }
    this.pending = {
      requestId,
      kind: "launchAgent",
      logicalSessionId,
      draft,
      provider,
      worktreeName,
      startedAtMs: this.now(),
    };
    this.face = {
      ...this.face,
      ui: "submitting",
      pendingRequestId: requestId,
      ambiguous: false,
    };
    this.emitFace();

    let outcome: DraftMutationOutcome;
    try {
      outcome = await this.deps.launchExecutor({
        logicalSessionId,
        provider,
        draft,
        worktreeName,
        requestId,
      });
    } catch {
      outcome = {
        kind: "ambiguous",
        code: "exception",
        message: "Outcome unknown — Focus required",
      };
    }
    if (this.pending?.requestId === requestId) this.pending = null;
    await this.applyExecutorOutcome(requestId, outcome);
  }

  private async applyExecutorOutcome(
    requestId: string,
    outcome: DraftMutationOutcome,
  ): Promise<void> {
    if (outcome.kind === "success") {
      this.face = {
        ...this.face,
        ui: "empty",
        draftCharacters: 0,
        draftBytes: 0,
        pendingRequestId: null,
        ambiguous: false,
        lastCode: undefined,
      };
      this.emitFace();
      await this.sendOutcome(requestId, "success");
      // Helper clears + exits on success; local face closes on exited.
      return;
    }
    if (outcome.kind === "failed") {
      this.face = {
        ...this.face,
        ui: "ready",
        pendingRequestId: null,
        ambiguous: false,
        lastCode: outcome.code,
      };
      this.emitFace();
      await this.sendOutcome(requestId, "failed", outcome.code, outcome.message);
      return;
    }
    this.face = {
      ...this.face,
      ui: "ready",
      pendingRequestId: null,
      ambiguous: true,
      lastCode: outcome.code,
    };
    this.emitFace();
    await this.sendOutcome(
      requestId,
      "ambiguous",
      outcome.code,
      outcome.message || "Outcome unknown — Focus required",
    );
  }

  private async sendOutcome(
    requestId: string,
    kind: MutationOutcomeKind,
    code?: string,
    message?: string,
  ): Promise<void> {
    const msg: PluginToHelperMessage = {
      version: 1,
      type: "outcome",
      requestId,
      kind,
      code,
      message,
    };
    await this.write(msg);
    this.deps.logger.info(
      "draft_outcome",
      { kind, code: code ?? null },
      { ids: { requestId } },
    );
  }

  private async write(message: PluginToHelperMessage): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    const line = encodePluginMessage(message);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      this.deps.logger.warn("overlay_stdin_write_failed", { type: message.type });
    }
  }

  private teardown(reason: string): void {
    const child = this.child;
    this.child = null;
    if (this.readline) {
      this.readline.removeAllListeners();
      this.readline.close();
      this.readline = null;
    }
    if (child && !child.killed) {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    // Pending draft memory is dropped — never persisted.
    this.pending = null;
    this.face = emptyDraftFaceState();
    this.emitFace();
    this.deps.logger.info("overlay_teardown", { reason });
  }

  private emitFace(): void {
    this.deps.onFaceChange?.(this.getFace());
  }

  private nextId(prefix: string): string {
    this.requestSeq += 1;
    return `${prefix}-${this.requestSeq}-${this.now().toString(36)}`;
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }
}

/** Display-only context from a live session + config. No handles/paths/secrets/prompt. */
export function buildOverlayContext(
  session: LogicalSession | null | undefined,
  config: Pick<DeckConfig, "superwhisper">,
): OverlayContextPayload {
  return {
    repoLabel: session?.repo ? truncateLabel(session.repo) : undefined,
    worktreeLabel: session?.displayName ? truncateLabel(session.displayName) : undefined,
    hostLabel: session?.hostId ? truncateLabel(session.hostId) : undefined,
    agentLabel: session?.agentType ? truncateLabel(String(session.agentType)) : undefined,
    superwhisperMode: config.superwhisper?.mode
      ? truncateLabel(config.superwhisper.mode)
      : undefined,
  };
}

function truncateLabel(value: string, max = 256): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function resolveLaunchTarget(session: LogicalSession): LaunchTarget | null {
  if (session.projectHostSetupId) {
    return { kind: "projectHostSetup", projectHostSetupId: session.projectHostSetupId };
  }
  if (session.repoId) {
    return { kind: "repo", repoId: session.repoId };
  }
  return null;
}

export function buildSendArgsForSession(handle: string, draft: string): string[] {
  return buildDraftSendArgs(handle, draft);
}

export function buildLaunchArgsForSession(
  session: LogicalSession,
  provider: LaunchProvider,
  draft: string,
  worktreeName: string,
): string[] | null {
  const target = resolveLaunchTarget(session);
  if (!target) return null;
  return buildWorktreeCreateArgs({
    target,
    name: worktreeName,
    agent: provider,
    prompt: draft,
    parentWorktreeId: session.worktreeId,
  });
}

export type { DraftUiState, LaunchProvider, DraftFaceState };
