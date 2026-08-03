/**
 * Shared poll scheduler for the dashboard.
 * One loop serves every action instance — never per-key polling.
 * Intervals are read via getter on each reschedule so config patches apply.
 */

export type SchedulerUrgency = "working" | "idle" | "empty" | "failure";

export type SchedulerIntervals = {
  workingMs: number;
  idleMs: number;
  unavailableMs: number;
  backoffCapMs: number;
};

export type SchedulerOptions = {
  /** Static intervals (tests). Prefer getIntervals for live config. */
  intervals?: SchedulerIntervals;
  /** Dynamic intervals from config store — re-read each reschedule. */
  getIntervals?: () => SchedulerIntervals;
  /** Invoked on each tick; may be async. Overlapping ticks coalesce. */
  onTick: () => void | Promise<void>;
  nowMs?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
};

export function nextIntervalMs(
  urgency: SchedulerUrgency,
  intervals: SchedulerIntervals,
  failureStreak: number,
): number {
  if (urgency === "failure" || (urgency === "empty" && failureStreak > 0)) {
    const base = intervals.unavailableMs;
    const mult = Math.min(failureStreak, 8);
    const ms = base * Math.max(1, 2 ** Math.max(0, mult - 1));
    return Math.min(ms, intervals.backoffCapMs);
  }
  if (urgency === "working") return intervals.workingMs;
  if (urgency === "idle") return intervals.idleMs;
  return intervals.unavailableMs;
}

const DEFAULT_INTERVALS: SchedulerIntervals = {
  workingMs: 2_000,
  idleMs: 3_000,
  unavailableMs: 10_000,
  backoffCapMs: 30_000,
};

/**
 * Demand-driven scheduler: runs only while consumers are visible / demand > 0.
 */
export class PollScheduler {
  private readonly opts: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private demand = 0;
  private urgency: SchedulerUrgency = "empty";
  private failureStreak = 0;
  private inFlight: Promise<void> | null = null;
  private queued = false;
  private stopped = true;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  getDemand(): number {
    return this.demand;
  }

  getUrgency(): SchedulerUrgency {
    return this.urgency;
  }

  getFailureStreak(): number {
    return this.failureStreak;
  }

  addDemand(): void {
    this.demand += 1;
    if (this.demand > 0) this.ensureRunning();
  }

  removeDemand(): void {
    this.demand = Math.max(0, this.demand - 1);
    if (this.demand === 0) this.stop();
  }

  setUrgency(urgency: SchedulerUrgency): void {
    this.urgency = urgency;
    if (!this.stopped) this.reschedule();
  }

  /** Force interval re-read after config patch. */
  touchIntervals(): void {
    if (!this.stopped && this.demand > 0) this.reschedule();
  }

  noteSuccess(): void {
    this.failureStreak = 0;
  }

  noteFailure(): void {
    this.failureStreak += 1;
  }

  /** Immediate refresh; coalesces concurrent callers onto one in-flight tick. */
  async kick(): Promise<void> {
    await this.runTick();
    if (!this.stopped) this.reschedule();
  }

  start(): void {
    this.stopped = false;
    if (this.demand > 0) this.ensureRunning();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  readIntervals(): SchedulerIntervals {
    return this.opts.getIntervals?.() ?? this.opts.intervals ?? DEFAULT_INTERVALS;
  }

  currentIntervalMs(): number {
    return nextIntervalMs(this.urgency, this.readIntervals(), this.failureStreak);
  }

  private ensureRunning(): void {
    this.stopped = false;
    if (!this.timer) this.reschedule();
  }

  private reschedule(): void {
    if (this.timer != null) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.demand <= 0) return;
    const ms = this.currentIntervalMs();
    const setTimer = this.opts.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      void this.runTick().finally(() => {
        if (!this.stopped && this.demand > 0) this.reschedule();
      });
    }, ms);
    this.timer.unref?.();
  }

  private async runTick(): Promise<void> {
    if (this.inFlight) {
      this.queued = true;
      await this.inFlight;
      if (!this.queued) return;
      this.queued = false;
    }
    this.inFlight = (async () => {
      await this.opts.onTick();
    })().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    if (this.queued) {
      this.queued = false;
      await this.runTick();
    }
  }
}
