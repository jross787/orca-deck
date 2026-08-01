/**
 * One shared dashboard runtime: discovery refresh, reducer, metadata, alerts, paint fan-out.
 * All session/control actions consume this store — no per-key polling.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConfigStore } from "../config/store.js";
import { checkMutationPreconditions } from "../commands/preconditions.js";
import {
  buildCloseArgs,
  buildInterruptArgs,
  buildPresetSendArgs,
  resolvePresetText,
  type PresetIndex,
} from "../commands/presets.js";
import { evaluateRetrySupport } from "../commands/retry.js";
import type { RedactedLogger } from "../diagnostics/logger.js";
import {
  buildLaunchArgsForSession,
  buildOverlayContext,
  DraftCoordinator,
  type DraftFaceState,
  type DraftMutationOutcome,
  type LaunchProvider,
} from "../draft/coordinator.js";
import {
  MUTATION_COMMANDS,
  OrcaCliError,
  runOrca,
  runOrcaJson,
  type OrcaCliOptions,
} from "../orca/cli.js";
import type { LogicalSession } from "../orca/discovery.js";
import { refreshDiscovery, type DiscoveryRefreshOptions } from "../orca/refresh.js";
import {
  controlSvgDataUrl,
  emptySlotSvgDataUrl,
  sessionSvgDataUrl,
  ImageWriteDebouncer,
  type BasicControlKind,
  type SafeControlKind,
} from "../rendering/session-svg.js";
import { AlertEngine } from "./alerts.js";
import { MetadataStore } from "./metadata-store.js";
import {
  createInitialDashboardState,
  reduceDashboard,
  selectDashboardSnapshot,
  toPersistedState,
  type DashboardState,
} from "./reducer.js";
import { PollScheduler, type SchedulerIntervals } from "./scheduler.js";
import type { CardViewModel, ControlViewModel, DashboardSnapshot } from "./types.js";
import { SLOT_COUNT } from "./types.js";

export type PaintTarget = {
  id: string;
  setImage: (image: string, opts?: { target?: number }) => Promise<void> | void;
  setTitle?: (title: string) => Promise<void> | void;
  showOk?: () => Promise<void> | void;
  showAlert?: () => Promise<void> | void;
};

export type MutationRunner = (
  args: readonly string[],
  cli: OrcaCliOptions,
) => Promise<void>;

export type TimerHandle = { clear: () => void };

export type DashboardRuntimeDeps = {
  configStore: ConfigStore;
  logger: RedactedLogger;
  metadataStore?: MetadataStore;
  alertEngine?: AlertEngine;
  /** Injected discovery for tests. */
  refresh?: typeof refreshDiscovery;
  /** Injected focus runner for tests. */
  runFocus?: (handle: string, cli: OrcaCliOptions) => Promise<void>;
  /** Injected mutation runner (preset/interrupt/close/draft) for tests. */
  runMutation?: MutationRunner;
  /** Optional absolute path to orca-draft-overlay helper. */
  draftHelperPath?: string;
  /** Injected helper spawner for tests. */
  spawnDraftHelper?: (helperPath: string) => ChildProcessWithoutNullStreams;
  nowMs?: () => number;
  /**
   * Testable timer. Defaults to setTimeout.
   * `fn` may return a Promise; tests can await the scheduled callback result.
   */
  schedule?: (fn: () => void | Promise<void>, ms: number) => TimerHandle;
};

type Listener = (snap: DashboardSnapshot) => void;

export type RuntimeControlKind =
  | BasicControlKind
  | SafeControlKind;

type HoldGesture = {
  token: number;
  logicalSessionId: string;
  targetId: string;
  /** true once threshold fire started or completed close path */
  closedOrClosing: boolean;
  /** true once short-release interrupt started */
  interrupted: boolean;
  /** true once any terminal outcome committed (success or fail feedback) */
  settled: boolean;
  timer: TimerHandle | null;
  startedAtMs: number;
  holdMs: number;
};

/**
 * Shared runtime used by all 16 session slots + contextual controls.
 */
export class DashboardRuntime {
  private readonly deps: DashboardRuntimeDeps;
  private readonly metadata: MetadataStore;
  private readonly alerts: AlertEngine;
  private readonly debouncer = new ImageWriteDebouncer();
  private readonly listeners = new Set<Listener>();
  private state: DashboardState;
  private snapshot: DashboardSnapshot;
  private readonly scheduler: PollScheduler;
  private readonly sessionTargets = new Map<number, Set<PaintTarget>>();
  private readonly controlTargets = new Map<RuntimeControlKind, Set<PaintTarget>>();
  private demand = 0;
  private ready: Promise<void>;
  private persistTimer: NodeJS.Timeout | null = null;
  /** Shared in-flight refresh — all concurrent callers await the same tick. */
  private refreshInFlight: Promise<DashboardSnapshot> | null = null;
  private holdGesture: HoldGesture | null = null;
  private holdTokenSeq = 0;
  /** Progress paint while holding interrupt/close. */
  private holdProgressRatio = 0;
  private holdProgressTargetId: string | null = null;
  private readonly draft: DraftCoordinator;
  private draftFace: DraftFaceState = {
    open: false,
    ui: "empty",
    draftCharacters: 0,
    draftBytes: 0,
    pendingRequestId: null,
    ambiguous: false,
  };

  constructor(deps: DashboardRuntimeDeps) {
    this.deps = deps;
    this.metadata =
      deps.metadataStore ??
      new MetadataStore({ paths: deps.configStore.paths, logger: deps.logger });
    const cfg = deps.configStore.getConfig();
    this.alerts =
      deps.alertEngine ??
      new AlertEngine({
        enabled: cfg.soundEnabled,
        platform: process.platform,
      });
    this.state = createInitialDashboardState(cfg.stuckThresholdMinutes);
    this.snapshot = selectDashboardSnapshot(this.state, deps.nowMs?.() ?? Date.now());

    this.scheduler = new PollScheduler({
      getIntervals: () => this.readIntervals(),
      onTick: async () => {
        await this.refresh();
      },
    });

    this.draft = new DraftCoordinator({
      logger: deps.logger,
      helperPath: deps.draftHelperPath,
      spawnHelper: deps.spawnDraftHelper,
      resolveContext: () => this.resolveDraftContext(),
      sendExecutor: (input) => this.executeDraftSend(input),
      launchExecutor: (input) => this.executeDraftLaunch(input),
      onFaceChange: (face) => {
        this.draftFace = face;
        this.reprojectSnapshot();
        void this.paintDraftControls();
      },
      nowMs: () => this.now(),
    });

    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const persisted = await this.metadata.load();
    this.state = reduceDashboard(this.state, { type: "hydrate", persisted });
    for (const [id, meta] of Object.entries(persisted.sessions)) {
      if (meta.lastAlertEvent) this.alerts.markEmitted(id, meta.lastAlertEvent);
    }
    this.snapshot = selectDashboardSnapshot(this.state, this.now());
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private schedule(fn: () => void | Promise<void>, ms: number): TimerHandle {
    if (this.deps.schedule) return this.deps.schedule(fn, ms);
    const t = setTimeout(fn, ms);
    return {
      clear: () => clearTimeout(t),
    };
  }

  private readIntervals(): SchedulerIntervals {
    const p = this.deps.configStore.getConfig().polling;
    return {
      workingMs: p.workingMs,
      idleMs: p.idleMs,
      unavailableMs: p.unavailableMs,
      backoffCapMs: p.backoffCapMs,
    };
  }

  private cliOpts(): OrcaCliOptions {
    const cfg = this.deps.configStore.getConfig();
    return {
      executable: cfg.orcaExecutable,
      timeoutMs: cfg.cliTimeoutMs,
    };
  }

  private async runMutationArgs(args: readonly string[]): Promise<void> {
    if (this.deps.runMutation) {
      await this.deps.runMutation(args, this.cliOpts());
      return;
    }
    await runOrca(args, this.cliOpts());
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  getSnapshot(): DashboardSnapshot {
    return this.withDraftFace(this.snapshot);
  }

  getDraftFaceForTests(): DraftFaceState {
    return { ...this.draftFace };
  }

  getDraftCoordinatorForTests(): DraftCoordinator {
    return this.draft;
  }

  async openDraftOverlay(): Promise<void> {
    await this.ready;
    await this.draft.openOrFocus();
    this.reprojectSnapshot();
    await this.paintDraftControls();
  }

  async focusDraftOverlay(): Promise<void> {
    await this.openDraftOverlay();
  }

  async cancelDraftOverlay(): Promise<void> {
    await this.ready;
    await this.draft.requestCancelFromDeck();
    this.reprojectSnapshot();
    await this.paintDraftControls();
  }

  /** Deck Send key focuses helper; mutation originates from helper sendSelected once. */
  async requestDraftSendFromDeck(): Promise<void> {
    await this.ready;
    await this.draft.requestSendFromDeck();
  }

  async requestDraftLaunchFromDeck(provider: LaunchProvider): Promise<void> {
    await this.ready;
    // Focus helper — launch is explicit from overlay or correlated helper message only.
    await this.draft.openOrFocus();
  }

  getStateForTests(): DashboardState {
    return this.state;
  }

  /** Test helper: current hold gesture progress 0..1, or 0. */
  getHoldProgressForTests(): number {
    return this.holdProgressRatio;
  }

  /** Test/helper: force scheduler to re-read intervals after config patch. */
  notifyConfigChanged(): void {
    this.scheduler.touchIntervals();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addDemand(): void {
    this.demand += 1;
    this.scheduler.addDemand();
    if (this.demand === 1) void this.scheduler.kick();
  }

  removeDemand(): void {
    this.demand = Math.max(0, this.demand - 1);
    this.scheduler.removeDemand();
  }

  registerSessionTarget(slotIndex: number, target: PaintTarget): void {
    if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return;
    let set = this.sessionTargets.get(slotIndex);
    if (!set) {
      set = new Set();
      this.sessionTargets.set(slotIndex, set);
    }
    set.add(target);
    void this.paintSession(slotIndex, target);
  }

  unregisterSessionTarget(slotIndex: number, target: PaintTarget): void {
    const set = this.sessionTargets.get(slotIndex);
    if (!set) return;
    set.delete(target);
    this.debouncer.clear(target.id);
    if (set.size === 0) this.sessionTargets.delete(slotIndex);
  }

  registerControlTarget(kind: RuntimeControlKind, target: PaintTarget): void {
    let set = this.controlTargets.get(kind);
    if (!set) {
      set = new Set();
      this.controlTargets.set(kind, set);
    }
    set.add(target);
    void this.paintControl(kind, target);
  }

  unregisterControlTarget(kind: RuntimeControlKind, target: PaintTarget): void {
    const set = this.controlTargets.get(kind);
    if (!set) return;
    set.delete(target);
    this.debouncer.clear(target.id);
    if (set.size === 0) this.controlTargets.delete(kind);
  }

  async refresh(): Promise<DashboardSnapshot> {
    await this.ready;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async runRefresh(): Promise<DashboardSnapshot> {
    const cfg = this.deps.configStore.getConfig();
    this.alerts.setEnabled(cfg.soundEnabled);
    // Honor latest polling intervals after load/patch.
    this.scheduler.touchIntervals();

    const refreshFn = this.deps.refresh ?? refreshDiscovery;
    const opts: DiscoveryRefreshOptions = {
      cli: this.cliOpts(),
      logger: this.deps.logger,
      nowMs: () => this.now(),
    };
    const result = await refreshFn(opts);
    const nowMs = this.now();

    // Failed/incomplete discovery must not invent identity-lost from empty sessions.
    const topologyReliable = result.ok === true;

    this.state = reduceDashboard(this.state, {
      type: "refresh",
      source: {
        sessions: topologyReliable ? result.snapshot.sessions : [],
        orcaReady: result.snapshot.orcaReady,
        runtimeId: result.snapshot.runtimeId,
        issues: result.snapshot.issues,
        capturedAtMs: result.snapshot.capturedAtMs,
        topologyReliable,
      },
      stuckThresholdMinutes: cfg.stuckThresholdMinutes,
      nowMs,
    });

    if (result.ok) this.scheduler.noteSuccess();
    else this.scheduler.noteFailure();

    this.snapshot = selectDashboardSnapshot(this.state, nowMs);
    this.scheduler.setUrgency(
      !result.ok || !this.snapshot.orcaReady
        ? this.snapshot.cards.length === 0
          ? "failure"
          : this.snapshot.control.urgency === "working"
            ? "working"
            : "failure"
        : this.snapshot.control.urgency === "empty"
          ? "empty"
          : this.snapshot.control.urgency,
    );

    const played = await this.alerts.handle(this.snapshot.alerts);
    for (const a of played) {
      this.state = reduceDashboard(this.state, {
        type: "alert_emitted",
        logicalSessionId: a.logicalSessionId,
        event: a.event,
        nowMs: this.now(),
      });
    }
    if (played.length > 0) {
      this.snapshot = selectDashboardSnapshot(this.state, this.now());
    }

    this.schedulePersist();
    await this.paintAll();
    this.emit();
    return this.snapshot;
  }

  async selectSession(logicalSessionId: string): Promise<DashboardSnapshot> {
    await this.ready;
    this.state = reduceDashboard(this.state, { type: "select", logicalSessionId });
    this.snapshot = selectDashboardSnapshot(this.state, this.now());
    this.schedulePersist();
    await this.paintAll();
    this.emit();
    return this.snapshot;
  }

  async selectSlot(slotIndex: number): Promise<DashboardSnapshot> {
    const card = this.snapshot.slots[slotIndex];
    if (!card) {
      await this.refresh();
      return this.snapshot;
    }
    return this.selectSession(card.logicalSessionId);
  }

  async nextAttention(): Promise<DashboardSnapshot> {
    await this.ready;
    await this.refresh();
    const target = this.snapshot.control.nextTargetId;
    if (!target) return this.snapshot;
    return this.selectSession(target);
  }

  async acknowledgeSelected(): Promise<DashboardSnapshot> {
    await this.ready;
    const id = this.state.selectedLogicalSessionId;
    if (!id) {
      await this.flashControls("acknowledge", false);
      await this.refresh();
      return this.snapshot;
    }
    this.state = reduceDashboard(this.state, {
      type: "acknowledge",
      logicalSessionId: id,
      nowMs: this.now(),
    });
    this.snapshot = selectDashboardSnapshot(this.state, this.now());
    this.schedulePersist();
    await this.flashControls("acknowledge", true);
    await this.refresh();
    return this.snapshot;
  }

  /**
   * Focus: capture selected id, refresh/rejoin, precondition check, exact current handle switch.
   * On success acknowledges current event. Never uses a remembered handle.
   */
  async focusSelected(): Promise<DashboardSnapshot> {
    await this.ready;
    const selectedId = this.state.selectedLogicalSessionId;
    if (!selectedId) {
      await this.flashControls("focus", false);
      await this.refresh();
      return this.snapshot;
    }

    await this.refresh();
    const session = this.findLiveSession(selectedId);
    const gate = checkMutationPreconditions({
      session,
      kind: "focus",
      orcaReady: this.snapshot.orcaReady,
    });
    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn(
        "focus_blocked",
        { code: gate.ok ? "missing_handle" : gate.code },
        { ids: { logicalSessionId: selectedId } },
      );
      await this.flashControls("focus", false);
      await this.refresh();
      return this.snapshot;
    }

    const handle = session.runtimeHandle;
    try {
      if (this.deps.runFocus) {
        await this.deps.runFocus(handle, this.cliOpts());
      } else {
        await runOrca([...MUTATION_COMMANDS.terminalSwitch, "--terminal", handle], this.cliOpts());
      }
      this.state = reduceDashboard(this.state, {
        type: "focus_success",
        logicalSessionId: selectedId,
        nowMs: this.now(),
      });
      this.snapshot = selectDashboardSnapshot(this.state, this.now());
      this.schedulePersist();
      await this.flashControls("focus", true);
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      this.deps.logger.error("focus_failed", { code }, { ids: { logicalSessionId: selectedId } });
      await this.flashControls("focus", false);
    }
    await this.refresh();
    return this.snapshot;
  }

  /**
   * Safe preset send for provider index 0..3.
   * Captures key-down logical id, refreshes, rejoins fresh handle, exact argv once.
   * Never logs/persists preset text. Does not terminal switch / activate / ack.
   */
  async sendPreset(index: PresetIndex, initiatingTargetId?: string): Promise<DashboardSnapshot> {
    await this.ready;
    const selectedId = this.state.selectedLogicalSessionId;
    const kind = presetKind(index);
    if (!selectedId) {
      await this.flashControlTarget(kind, false, initiatingTargetId);
      await this.refresh();
      return this.snapshot;
    }

    await this.refresh();
    const session = this.findLiveSession(selectedId);
    const cfg = this.deps.configStore.getConfig();
    const resolved = resolvePresetText(cfg, session?.agentType, index);
    const gate = checkMutationPreconditions({
      session,
      kind: "preset_send",
      orcaReady: this.snapshot.orcaReady,
      presetText: resolved.text,
    });
    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn(
        "preset_blocked",
        {
          code: gate.ok ? "missing_handle" : gate.code,
          presetIndex: index,
          presetKey: resolved.key,
        },
        { ids: { logicalSessionId: selectedId } },
      );
      await this.flashControlTarget(kind, false, initiatingTargetId);
      await this.refresh();
      return this.snapshot;
    }

    const handle = session.runtimeHandle;
    const args = buildPresetSendArgs(handle, resolved.text);
    try {
      await this.runMutationArgs(args);
      this.deps.logger.info(
        "preset_sent",
        { presetIndex: index, presetKey: resolved.key },
        { ids: { logicalSessionId: selectedId } },
      );
      await this.flashControlTarget(kind, true, initiatingTargetId);
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      this.deps.logger.error(
        "preset_failed",
        { code, presetIndex: index, presetKey: resolved.key },
        { ids: { logicalSessionId: selectedId } },
      );
      await this.flashControlTarget(kind, false, initiatingTargetId);
    }
    await this.refresh();
    return this.snapshot;
  }

  /**
   * Retry — fail closed unless a deterministic public operation exists.
   * Never guesses text/keys. No mutation on current installed contract.
   */
  async retrySelected(initiatingTargetId?: string): Promise<DashboardSnapshot> {
    await this.ready;
    const selectedId = this.state.selectedLogicalSessionId;
    if (!selectedId) {
      await this.flashControlTarget("retry", false, initiatingTargetId);
      await this.refresh();
      return this.snapshot;
    }
    await this.refresh();
    const session = this.findLiveSession(selectedId);
    const retry = evaluateRetrySupport({ session, publicRetryCommands: [] });
    const gate = checkMutationPreconditions({
      session,
      kind: "retry",
      orcaReady: this.snapshot.orcaReady,
      publicRetryCommands: [],
    });
    if (!gate.ok || !retry.supported) {
      this.deps.logger.warn(
        "retry_blocked",
        { code: gate.ok ? "no_public_operation" : gate.code },
        { ids: { logicalSessionId: selectedId } },
      );
      await this.flashControlTarget("retry", false, initiatingTargetId);
      await this.refresh();
      return this.snapshot;
    }
    // Future path only — installed CLI never reaches here.
    await this.flashControlTarget("retry", false, initiatingTargetId);
    await this.refresh();
    return this.snapshot;
  }

  /**
   * Structured reply surface — always fail-closed without typed public contract.
   * Never executes terminal input.
   */
  async structuredReplySelected(initiatingTargetId?: string): Promise<DashboardSnapshot> {
    await this.ready;
    const selectedId = this.state.selectedLogicalSessionId;
    await this.refresh();
    const session = selectedId ? this.findLiveSession(selectedId) : undefined;
    const gate = checkMutationPreconditions({
      session,
      kind: "structured_reply",
      orcaReady: this.snapshot.orcaReady,
      structuredReply: {
        runtimeAdvertisesQueryReplyInput: false,
        publicCliHasTerminalQuery: false,
        publicCliHasTerminalReply: false,
        usableViaPublicCli: false,
        status: "blocked_missing_public_cli",
        detail: "Structured reply public CLI contract is unavailable.",
        futurePublicContract: {
          proposedCommands: ["terminal query", "terminal reply"],
          requiredFlags: ["--terminal", "--json"],
          notes: [],
        },
      },
    });
    this.deps.logger.warn(
      "structured_reply_blocked",
      { code: gate.ok ? "structured_reply_unavailable" : gate.code },
      selectedId ? { ids: { logicalSessionId: selectedId } } : undefined,
    );
    await this.flashControlTarget("structured-reply", false, initiatingTargetId);
    await this.refresh();
    return this.snapshot;
  }

  /**
   * Interrupt/hold-close key down: capture logical id + start hold timer (hot-reloaded ms).
   */
  beginInterruptHold(targetId: string): void {
    const selectedId = this.state.selectedLogicalSessionId;
    // Cancel any prior incomplete gesture idempotently.
    this.clearHoldGesture({ paint: false });
    if (!selectedId) {
      void this.flashControlTarget("interrupt-close", false, targetId);
      return;
    }
    const holdMs = this.deps.configStore.getConfig().holdToCloseMs;
    const token = ++this.holdTokenSeq;
    const gesture: HoldGesture = {
      token,
      logicalSessionId: selectedId,
      targetId,
      closedOrClosing: false,
      interrupted: false,
      settled: false,
      timer: null,
      startedAtMs: this.now(),
      holdMs,
    };
    this.holdGesture = gesture;
    this.holdProgressRatio = 0;
    this.holdProgressTargetId = targetId;
    void this.paintControl("interrupt-close");

    gesture.timer = this.schedule(() => {
      return this.onHoldThreshold(token);
    }, holdMs);
  }

  /**
   * Key up / release before threshold → one interrupt; after close → no-op.
   */
  async endInterruptHold(targetId?: string): Promise<DashboardSnapshot> {
    await this.ready;
    const g = this.holdGesture;
    if (!g) {
      return this.snapshot;
    }
    if (targetId && g.targetId !== targetId) {
      return this.snapshot;
    }
    if (g.closedOrClosing || g.interrupted || g.settled) {
      // Threshold already owns the outcome (or duplicate up).
      if (g.timer) {
        g.timer.clear();
        g.timer = null;
      }
      return this.snapshot;
    }
    // Short release: cancel close timer, send interrupt once.
    if (g.timer) {
      g.timer.clear();
      g.timer = null;
    }
    g.interrupted = true;
    g.settled = true;
    const logicalId = g.logicalSessionId;
    const initiating = g.targetId;
    this.holdProgressRatio = 0;
    this.holdProgressTargetId = null;
    this.holdGesture = null;

    await this.refresh();
    const session = this.findLiveSession(logicalId);
    const gate = checkMutationPreconditions({
      session,
      kind: "interrupt",
      orcaReady: this.snapshot.orcaReady,
    });
    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn(
        "interrupt_blocked",
        { code: gate.ok ? "missing_handle" : gate.code },
        { ids: { logicalSessionId: logicalId } },
      );
      await this.flashControlTarget("interrupt-close", false, initiating);
      await this.refresh();
      return this.snapshot;
    }
    const handle = session.runtimeHandle;
    try {
      await this.runMutationArgs(buildInterruptArgs(handle));
      this.deps.logger.info("interrupt_sent", {}, { ids: { logicalSessionId: logicalId } });
      await this.flashControlTarget("interrupt-close", true, initiating);
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      this.deps.logger.error("interrupt_failed", { code }, { ids: { logicalSessionId: logicalId } });
      await this.flashControlTarget("interrupt-close", false, initiating);
    }
    await this.refresh();
    return this.snapshot;
  }

  /**
   * willDisappear / cancel: drop timer without mutation if not already firing.
   */
  cancelInterruptHold(targetId?: string): void {
    const g = this.holdGesture;
    if (!g) return;
    if (targetId && g.targetId !== targetId) return;
    if (g.closedOrClosing || g.interrupted) {
      // In-flight mutation owns outcome; just detach timer.
      if (g.timer) {
        g.timer.clear();
        g.timer = null;
      }
      return;
    }
    this.clearHoldGesture({ paint: true });
  }

  private async onHoldThreshold(token: number): Promise<void> {
    const g = this.holdGesture;
    if (!g || g.token !== token) return;
    if (g.interrupted || g.closedOrClosing || g.settled) return;
    g.closedOrClosing = true;
    g.settled = true;
    if (g.timer) {
      g.timer.clear();
      g.timer = null;
    }
    const logicalId = g.logicalSessionId;
    const initiating = g.targetId;
    // Progress paint for this gesture only while it is still current.
    if (this.holdGesture?.token === token) {
      this.holdProgressRatio = 1;
      this.holdProgressTargetId = initiating;
    }
    await this.paintControl("interrupt-close");

    await this.refresh();
    // A newer beginInterruptHold may have replaced the gesture during await —
    // never clobber gesture B or its timer/progress.
    if (this.holdGesture?.token === token) {
      this.holdGesture = null;
      this.holdProgressRatio = 0;
      this.holdProgressTargetId = null;
    }

    const session = this.findLiveSession(logicalId);
    const gate = checkMutationPreconditions({
      session,
      kind: "close",
      orcaReady: this.snapshot.orcaReady,
    });

    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn(
        "close_blocked",
        { code: gate.ok ? "missing_handle" : gate.code },
        { ids: { logicalSessionId: logicalId } },
      );
      await this.flashControlTarget("interrupt-close", false, initiating);
      await this.refresh();
      return;
    }
    const handle = session.runtimeHandle;
    try {
      await this.runMutationArgs(buildCloseArgs(handle));
      this.deps.logger.info("close_sent", {}, { ids: { logicalSessionId: logicalId } });
      await this.flashControlTarget("interrupt-close", true, initiating);
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      this.deps.logger.error("close_failed", { code }, { ids: { logicalSessionId: logicalId } });
      await this.flashControlTarget("interrupt-close", false, initiating);
    }
    await this.refresh();
  }

  private clearHoldGesture(opts: { paint: boolean }): void {
    const g = this.holdGesture;
    if (!g) return;
    if (g.timer) {
      g.timer.clear();
      g.timer = null;
    }
    this.holdGesture = null;
    this.holdProgressRatio = 0;
    this.holdProgressTargetId = null;
    if (opts.paint) void this.paintControl("interrupt-close");
  }

  private findLiveSession(logicalSessionId: string): LogicalSession | undefined {
    return this.state.liveById.get(logicalSessionId);
  }

  stop(): void {
    this.scheduler.stop();
    this.clearHoldGesture({ paint: false });
    this.draft.stop();
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private emit(): void {
    const snap = this.withDraftFace(this.snapshot);
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // listener errors must not break runtime
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer != null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.metadata
        .save(toPersistedState(this.state))
        .catch((err) => {
          this.deps.logger.error("metadata_persist_failed", {
            code: err instanceof Error ? err.name : "error",
          });
        });
    }, 50);
    this.persistTimer.unref?.();
  }

  private async paintAll(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const targets = this.sessionTargets.get(slot);
      if (!targets) continue;
      for (const t of targets) writes.push(this.paintSession(slot, t));
    }
    for (const [kind, targets] of this.controlTargets) {
      for (const t of targets) writes.push(this.paintControl(kind, t));
    }
    await Promise.all(writes);
  }

  private async paintSession(slotIndex: number, target: PaintTarget): Promise<void> {
    const card = this.snapshot.slots[slotIndex] ?? null;
    const image = card ? sessionSvgDataUrl(card) : emptySlotSvgDataUrl(slotIndex);
    if (!this.debouncer.shouldWrite(target.id, image)) return;
    await target.setImage(image);
  }

  private async paintControl(kind: RuntimeControlKind, only?: PaintTarget): Promise<void> {
    const targets = only ? [only] : [...(this.controlTargets.get(kind) ?? [])];
    if (targets.length === 0) return;
    const writes: Promise<void>[] = [];
    for (const target of targets) {
      const image = this.imageForControl(kind, target.id);
      if (!this.debouncer.shouldWrite(target.id, image)) continue;
      writes.push(Promise.resolve(target.setImage(image)));
    }
    await Promise.all(writes);
  }

  private imageForControl(kind: RuntimeControlKind, targetId: string): string {
    const control = this.withDraftFace(this.snapshot).control;
    if (kind === "interrupt-close") {
      const progress =
        this.holdProgressTargetId === targetId ? this.holdProgressRatio : 0;
      return controlSvgDataUrl(kind, control, { progress });
    }
    return controlSvgDataUrl(kind, control);
  }

  private withDraftFace(snap: DashboardSnapshot): DashboardSnapshot {
    const face = this.draftFace;
    const draftReady =
      face.open && face.ui === "ready" && face.draftCharacters > 0 && !face.ambiguous;
    const draftDetail = face.ambiguous
      ? "AMBIGUOUS"
      : !face.open
        ? "open"
        : face.ui === "submitting"
          ? "SENDING"
          : face.ui === "ready"
            ? "READY"
            : face.ui === "empty"
              ? "EMPTY"
              : face.ui.toUpperCase();
    const control: ControlViewModel = {
      ...snap.control,
      draftOpen: face.open,
      draftUi: face.ui,
      draftCharacters: face.draftCharacters,
      draftReady,
      draftAmbiguous: face.ambiguous,
      draftDetail,
      newAgentEnabled: draftReady,
    };
    return { ...snap, control };
  }

  private reprojectSnapshot(): void {
    // Base snapshot stays reducer-pure; draft face overlays in getSnapshot/imageForControl.
    this.snapshot = selectDashboardSnapshot(this.state, this.now());
    this.emit();
  }

  private async paintDraftControls(): Promise<void> {
    const kinds: RuntimeControlKind[] = [
      "draft",
      "send-draft",
      "cancel-draft",
      "new-omp",
      "new-claude",
      "new-codex",
    ];
    await Promise.all(kinds.map((k) => this.paintControl(k)));
  }

  private resolveDraftContext(): {
    logicalSessionId: string | null;
    context: ReturnType<typeof buildOverlayContext>;
  } {
    const logicalSessionId = this.state.selectedLogicalSessionId;
    const session = logicalSessionId ? this.findLiveSession(logicalSessionId) : undefined;
    const cfg = this.deps.configStore.getConfig();
    return {
      logicalSessionId,
      context: buildOverlayContext(session, cfg),
    };
  }

  private async executeDraftSend(input: {
    logicalSessionId: string;
    draft: string;
    requestId: string;
  }): Promise<DraftMutationOutcome> {
    // Capture logical id at draft session; refresh/rejoin; full preconditions; exactly one send.
    await this.refresh();
    const session = this.findLiveSession(input.logicalSessionId);
    const gate = checkMutationPreconditions({
      session,
      kind: "draft_send",
      orcaReady: this.snapshot.orcaReady,
      presetText: input.draft,
    });
    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn(
        "draft_send_blocked",
        { code: gate.ok ? "missing_handle" : gate.code },
        { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
      );
      return {
        kind: "failed",
        code: gate.ok ? "missing_handle" : gate.code,
        message: gate.ok ? "Missing terminal handle" : gate.message,
      };
    }
    const handle = session.runtimeHandle;
    const args = ["terminal", "send", "--terminal", handle, "--text", input.draft, "--enter"];
    // Never terminal switch/focus.
    try {
      await this.runMutationArgs(args);
      this.deps.logger.info(
        "draft_sent",
        { chars: input.draft.length },
        { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
      );
      await this.refresh();
      return { kind: "success" };
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      if (code === "timeout" || code === "invalid_json" || code === "empty_stdout") {
        this.deps.logger.error(
          "draft_send_ambiguous",
          { code },
          { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
        );
        return {
          kind: "ambiguous",
          code,
          message: "Outcome unknown — Focus required",
        };
      }
      this.deps.logger.error(
        "draft_send_failed",
        { code },
        { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
      );
      return {
        kind: "failed",
        code,
        message: code === "non_zero_exit" ? "Send failed" : "Send failed",
      };
    }
  }

  private async executeDraftLaunch(input: {
    logicalSessionId: string;
    provider: LaunchProvider;
    draft: string;
    worktreeName: string;
    requestId: string;
  }): Promise<DraftMutationOutcome> {
    await this.refresh();
    const session = this.findLiveSession(input.logicalSessionId);
    if (!session) {
      return { kind: "failed", code: "no_session", message: "No logical session selected" };
    }
    if (!this.snapshot.orcaReady) {
      return { kind: "failed", code: "orca_unavailable", message: "Orca runtime is not ready." };
    }
    const args = buildLaunchArgsForSession(
      session,
      input.provider,
      input.draft,
      input.worktreeName,
    );
    if (!args) {
      return {
        kind: "failed",
        code: "missing_launch_target",
        message: "No projectHostSetupId or repoId for selected session",
      };
    }
    // Exactly one worktree create; never --activate.
    try {
      if (this.deps.runMutation) {
        await this.deps.runMutation(args, this.cliOpts());
      } else {
        const result = await runOrcaJson(args, this.cliOpts());
        if (!result || (result as { json?: { ok?: boolean } }).json?.ok === false) {
          return {
            kind: "failed",
            code: "non_zero_exit",
            message: "Worktree create failed",
          };
        }
      }
      this.deps.logger.info(
        "draft_launch_ok",
        { provider: input.provider },
        { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
      );
      await this.refresh();
      return { kind: "success" };
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      if (code === "timeout" || code === "invalid_json" || code === "empty_stdout") {
        this.deps.logger.error(
          "draft_launch_ambiguous",
          { code, provider: input.provider },
          { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
        );
        return {
          kind: "ambiguous",
          code,
          message: "Outcome unknown — Focus required",
        };
      }
      this.deps.logger.error(
        "draft_launch_failed",
        { code, provider: input.provider },
        { ids: { logicalSessionId: input.logicalSessionId, requestId: input.requestId } },
      );
      return {
        kind: "failed",
        code,
        message: "Worktree create failed",
      };
    }
  }

  private async flashControls(kind: RuntimeControlKind, ok: boolean): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of this.controlTargets.get(kind) ?? []) {
      if (ok && t.showOk) writes.push(Promise.resolve(t.showOk()));
      if (!ok && t.showAlert) writes.push(Promise.resolve(t.showAlert()));
    }
    await Promise.all(writes);
  }

  private async flashControlTarget(
    kind: RuntimeControlKind,
    ok: boolean,
    initiatingTargetId?: string,
  ): Promise<void> {
    const all = [...(this.controlTargets.get(kind) ?? [])];
    const targets = initiatingTargetId
      ? all.filter((t) => t.id === initiatingTargetId)
      : all;
    const list = targets.length > 0 ? targets : all;
    const writes: Promise<void>[] = [];
    for (const t of list) {
      if (ok && t.showOk) writes.push(Promise.resolve(t.showOk()));
      if (!ok && t.showAlert) writes.push(Promise.resolve(t.showAlert()));
    }
    await Promise.all(writes);
  }
}

function presetKind(index: PresetIndex): SafeControlKind {
  if (index === 0) return "preset-1";
  if (index === 1) return "preset-2";
  if (index === 2) return "preset-3";
  return "preset-4";
}

export function cardAtSlot(snap: DashboardSnapshot, slotIndex: number): CardViewModel | null {
  return snap.slots[slotIndex] ?? null;
}
