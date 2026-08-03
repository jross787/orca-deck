/**
 * Health action — development/setup diagnostics for Orca Agent Deck.
 */
import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  Target,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import type { ConfigStore } from "../config/store.js";
import type { RedactedLogger } from "../diagnostics/logger.js";
import { checkOrcaHealth, type HealthSnapshot } from "../health/check.js";
import {
  healthSvgDataUrl,
  ImageWriteDebouncer,
} from "../rendering/health-svg.js";

export type HealthActionSettings = JsonObject;

export type HealthActionDeps = {
  configStore: ConfigStore;
  logger: RedactedLogger;
  /** Injected for tests. */
  checkHealth?: typeof checkOrcaHealth;
};

const UUID = "dev.onorca.agent-deck.health";

@action({ UUID })
export class HealthAction extends SingletonAction<HealthActionSettings> {
  private readonly deps: HealthActionDeps;
  private readonly debouncer = new ImageWriteDebouncer();
  private lastHealth: HealthSnapshot | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<HealthSnapshot> | null = null;

  constructor(deps: HealthActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<HealthActionSettings>): Promise<void> {
    this.deps.logger.info("health_will_appear", undefined, {
      ids: { actionId: ev.action.id },
    });
    const health = await this.refreshHealth();
    const image = healthSvgDataUrl(health);
    if (this.debouncer.shouldWrite(ev.action.id, image)) {
      await ev.action.setImage(image, { target: Target.HardwareAndSoftware });
    }
    await this.paintAll(health);
    this.ensurePolling();
  }

  override onWillDisappear(ev: WillDisappearEvent<HealthActionSettings>): void {
    this.debouncer.clear(ev.action.id);
  }

  override async onKeyDown(_ev: KeyDownEvent<HealthActionSettings>): Promise<void> {
    await this.refreshAndPaint();
  }

  getLastHealth(): HealthSnapshot | null {
    return this.lastHealth;
  }

  async refreshAndPaint(preferActionId?: string): Promise<HealthSnapshot> {
    const health = await this.refreshHealth();
    await this.paintAll(health, preferActionId);
    return health;
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runHealthCheck().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async runHealthCheck(): Promise<HealthSnapshot> {
    const snap = this.deps.configStore.getSnapshot();
    const cfg = snap.config;
    const check = this.deps.checkHealth ?? checkOrcaHealth;
    const health = await check({
      cli: {
        executable: cfg.orcaExecutable,
        timeoutMs: cfg.cliTimeoutMs,
      },
      logger: this.deps.logger,
      configError: snap.lastError,
    });
    this.lastHealth = health;
    this.deps.logger.info(
      "health_snapshot",
      {
        state: health.state,
        checkCount: health.checks.length,
      },
      {
        ids: health.runtimeId ? { runtimeId: health.runtimeId } : undefined,
        schemaVersion: health.schemaVersion,
      },
    );
    return health;
  }

  private async paintAll(health: HealthSnapshot, _preferActionId?: string): Promise<void> {
    const image = healthSvgDataUrl(health);
    const writes: Promise<void>[] = [];
    streamDeck.actions.forEach((a) => {
      if (!a.isKey() || a.manifestId !== UUID) return;
      if (!this.debouncer.shouldWrite(a.id, image)) return;
      writes.push(a.setImage(image, { target: Target.HardwareAndSoftware }));
    });
    await Promise.all(writes);
  }

  private ensurePolling(): void {
    if (this.refreshTimer) return;
    const tick = () => {
      void this.refreshAndPaint();
    };
    const ms = this.deps.configStore.getConfig().polling.unavailableMs;
    this.refreshTimer = setInterval(tick, ms);
    this.refreshTimer.unref?.();
  }
}
