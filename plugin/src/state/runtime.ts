/**
 * One shared dashboard runtime: discovery refresh, reducer, metadata, alerts, paint fan-out.
 * All session/control actions consume this store — no per-key polling.
 */

import type { ConfigStore } from "../config/store.js";
import { checkMutationPreconditions } from "../commands/preconditions.js";
import type { RedactedLogger } from "../diagnostics/logger.js";
import {
  MUTATION_COMMANDS,
  OrcaCliError,
  runOrca,
  type OrcaCliOptions,
} from "../orca/cli.js";
import type { LogicalSession } from "../orca/discovery.js";
import { refreshDiscovery, type DiscoveryRefreshOptions } from "../orca/refresh.js";
import {
  controlSvgDataUrl,
  emptySlotSvgDataUrl,
  sessionSvgDataUrl,
  ImageWriteDebouncer,
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
import type { CardViewModel, DashboardSnapshot } from "./types.js";
import { SLOT_COUNT } from "./types.js";

export type PaintTarget = {
  id: string;
  setImage: (image: string, opts?: { target?: number }) => Promise<void> | void;
  setTitle?: (title: string) => Promise<void> | void;
  showOk?: () => Promise<void> | void;
  showAlert?: () => Promise<void> | void;
};

export type DashboardRuntimeDeps = {
  configStore: ConfigStore;
  logger: RedactedLogger;
  metadataStore?: MetadataStore;
  alertEngine?: AlertEngine;
  /** Injected discovery for tests. */
  refresh?: typeof refreshDiscovery;
  /** Injected focus runner for tests. */
  runFocus?: (handle: string, cli: OrcaCliOptions) => Promise<void>;
  nowMs?: () => number;
};

type Listener = (snap: DashboardSnapshot) => void;

/**
 * Shared runtime used by all 16 session slots + Next/Focus/Ack.
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
  private readonly controlTargets = {
    next: new Set<PaintTarget>(),
    focus: new Set<PaintTarget>(),
    acknowledge: new Set<PaintTarget>(),
  };
  private demand = 0;
  private ready: Promise<void>;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(deps: DashboardRuntimeDeps) {
    this.deps = deps;
    this.metadata = deps.metadataStore ?? new MetadataStore({ paths: deps.configStore.paths });
    const cfg = deps.configStore.getConfig();
    this.alerts =
      deps.alertEngine ??
      new AlertEngine({
        enabled: cfg.soundEnabled,
        platform: process.platform,
      });
    this.state = createInitialDashboardState(cfg.stuckThresholdMinutes);
    this.snapshot = selectDashboardSnapshot(this.state, deps.nowMs?.() ?? Date.now());

    const intervals = this.readIntervals();
    this.scheduler = new PollScheduler({
      intervals,
      onTick: async () => {
        await this.refresh();
      },
    });

    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const persisted = await this.metadata.load();
    this.state = reduceDashboard(this.state, { type: "hydrate", persisted });
    // Rehydrate alert dedupe from metadata.
    for (const [id, meta] of Object.entries(persisted.sessions)) {
      if (meta.lastAlertEvent) this.alerts.markEmitted(id, meta.lastAlertEvent);
    }
    this.snapshot = selectDashboardSnapshot(this.state, this.now());
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
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

  async whenReady(): Promise<void> {
    await this.ready;
  }

  getSnapshot(): DashboardSnapshot {
    return this.snapshot;
  }

  getStateForTests(): DashboardState {
    return this.state;
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

  registerControlTarget(kind: "next" | "focus" | "acknowledge", target: PaintTarget): void {
    this.controlTargets[kind].add(target);
    void this.paintControl(kind, target);
  }

  unregisterControlTarget(kind: "next" | "focus" | "acknowledge", target: PaintTarget): void {
    this.controlTargets[kind].delete(target);
    this.debouncer.clear(target.id);
  }

  async refresh(): Promise<DashboardSnapshot> {
    await this.ready;
    const cfg = this.deps.configStore.getConfig();
    this.alerts.setEnabled(cfg.soundEnabled);

    const refreshFn = this.deps.refresh ?? refreshDiscovery;
    const opts: DiscoveryRefreshOptions = {
      cli: this.cliOpts(),
      logger: this.deps.logger,
      nowMs: () => this.now(),
    };
    const result = await refreshFn(opts);
    const nowMs = this.now();

    this.state = reduceDashboard(this.state, {
      type: "refresh",
      source: {
        sessions: result.snapshot.sessions,
        orcaReady: result.snapshot.orcaReady,
        runtimeId: result.snapshot.runtimeId,
        issues: result.snapshot.issues,
        capturedAtMs: result.snapshot.capturedAtMs,
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
    // Selection never focuses or acknowledges.
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

    // Refresh/rejoin before mutation — never use a remembered handle.
    await this.refresh();
    const session = this.findLiveSession(selectedId);
    const gate = checkMutationPreconditions({
      session,
      kind: "focus",
      orcaReady: this.snapshot.orcaReady,
    });
    if (!gate.ok || !session?.runtimeHandle) {
      this.deps.logger.warn("focus_blocked", {
        code: gate.ok ? "missing_handle" : gate.code,
      }, { ids: { logicalSessionId: selectedId } });
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

  private findLiveSession(logicalSessionId: string): LogicalSession | undefined {
    return this.state.liveById.get(logicalSessionId);
  }

  stop(): void {
    this.scheduler.stop();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.snapshot);
      } catch {
        // listener errors must not break runtime
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer != null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.metadata.save(toPersistedState(this.state)).catch(() => undefined);
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
    for (const kind of ["next", "focus", "acknowledge"] as const) {
      for (const t of this.controlTargets[kind]) writes.push(this.paintControl(kind, t));
    }
    await Promise.all(writes);
  }

  private async paintSession(slotIndex: number, target: PaintTarget): Promise<void> {
    const card = this.snapshot.slots[slotIndex] ?? null;
    const image = card ? sessionSvgDataUrl(card) : emptySlotSvgDataUrl(slotIndex);
    if (!this.debouncer.shouldWrite(target.id, image)) return;
    await target.setImage(image);
  }

  private async paintControl(
    kind: "next" | "focus" | "acknowledge",
    target: PaintTarget,
  ): Promise<void> {
    const image = controlSvgDataUrl(kind, this.snapshot.control);
    if (!this.debouncer.shouldWrite(target.id, image)) return;
    await target.setImage(image);
  }

  private async flashControls(kind: "next" | "focus" | "acknowledge", ok: boolean): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of this.controlTargets[kind]) {
      if (ok && t.showOk) writes.push(Promise.resolve(t.showOk()));
      if (!ok && t.showAlert) writes.push(Promise.resolve(t.showAlert()));
    }
    await Promise.all(writes);
  }
}

export function cardAtSlot(snap: DashboardSnapshot, slotIndex: number): CardViewModel | null {
  return snap.slots[slotIndex] ?? null;
}
