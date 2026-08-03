/**
 * Usage / model-effort physical keys.
 * Share one DashboardRuntime snapshot — no per-key polling or CLI.
 * Display-only; never mutate agents or substitute quota.
 */

import {
  action,
  KeyDownEvent,
  SingletonAction,
  Target,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import type { DashboardRuntime, PaintTarget } from "../state/runtime.js";
import type { UsageFaceKind } from "../usage/types.js";

export type UsageActionSettings = JsonObject;

export const USAGE_OMP_UUID = "dev.onorca.agent-deck.usage-omp";
export const USAGE_CLAUDE_UUID = "dev.onorca.agent-deck.usage-claude";
export const USAGE_CODEX_UUID = "dev.onorca.agent-deck.usage-codex";
export const MODEL_EFFORT_UUID = "dev.onorca.agent-deck.model-effort";

export const USAGE_ACTION_UUIDS = [
  USAGE_OMP_UUID,
  USAGE_CLAUDE_UUID,
  USAGE_CODEX_UUID,
  MODEL_EFFORT_UUID,
] as const;

export type UsageActionDeps = {
  runtime: DashboardRuntime;
};

function bindKeyTarget(
  ev: WillAppearEvent<UsageActionSettings>,
  targets: Map<string, PaintTarget>,
): PaintTarget | null {
  const actionRef = ev.action;
  if (!actionRef.isKey()) return null;
  const target: PaintTarget = {
    id: actionRef.id,
    setImage: (image) => actionRef.setImage(image, { target: Target.HardwareAndSoftware }),
    showOk: () => actionRef.showOk(),
    showAlert: () => actionRef.showAlert(),
  };
  targets.set(actionRef.id, target);
  return target;
}

function appear(
  kind: UsageFaceKind,
  deps: UsageActionDeps,
  targets: Map<string, PaintTarget>,
  ev: WillAppearEvent<UsageActionSettings>,
): Promise<void> {
  const target = bindKeyTarget(ev, targets);
  if (!target) return Promise.resolve();
  deps.runtime.registerUsageTarget(kind, target);
  deps.runtime.addDemand();
  return deps.runtime.whenReady().then(async () => {
    await deps.runtime.refresh();
  });
}

function disappear(
  kind: UsageFaceKind,
  deps: UsageActionDeps,
  targets: Map<string, PaintTarget>,
  ev: WillDisappearEvent<UsageActionSettings>,
): void {
  const target = targets.get(ev.action.id);
  if (target) {
    deps.runtime.unregisterUsageTarget(kind, target);
    targets.delete(ev.action.id);
  }
  deps.runtime.removeDemand();
}

abstract class UsageActionBase extends SingletonAction<UsageActionSettings> {
  protected abstract readonly faceKind: UsageFaceKind;
  private readonly deps: UsageActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: UsageActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<UsageActionSettings>): Promise<void> {
    await appear(this.faceKind, this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<UsageActionSettings>): void {
    disappear(this.faceKind, this.deps, this.targets, ev);
  }

  /** Press reuses shared refresh — no dedicated CLI poll. */
  override async onKeyDown(_ev: KeyDownEvent<UsageActionSettings>): Promise<void> {
    await this.deps.runtime.refresh();
  }
}

@action({ UUID: USAGE_OMP_UUID })
export class UsageOmpAction extends UsageActionBase {
  protected readonly faceKind: UsageFaceKind = "omp";
}

@action({ UUID: USAGE_CLAUDE_UUID })
export class UsageClaudeAction extends UsageActionBase {
  protected readonly faceKind: UsageFaceKind = "claude";
}

@action({ UUID: USAGE_CODEX_UUID })
export class UsageCodexAction extends UsageActionBase {
  protected readonly faceKind: UsageFaceKind = "codex";
}

@action({ UUID: MODEL_EFFORT_UUID })
export class ModelEffortAction extends UsageActionBase {
  protected readonly faceKind: UsageFaceKind = "model-effort";
}

export function createUsageActions(deps: UsageActionDeps): SingletonAction<UsageActionSettings>[] {
  return [
    new UsageOmpAction(deps),
    new UsageClaudeAction(deps),
    new UsageCodexAction(deps),
    new ModelEffortAction(deps),
  ];
}
