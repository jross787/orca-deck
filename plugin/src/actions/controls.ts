/**
 * Next Attention, Focus, and Acknowledge keypad actions.
 * Share one DashboardRuntime; never poll independently.
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

export type ControlActionSettings = JsonObject;

export const NEXT_ATTENTION_UUID = "dev.onorca.agent-deck.next-attention";
export const FOCUS_UUID = "dev.onorca.agent-deck.focus";
export const ACKNOWLEDGE_UUID = "dev.onorca.agent-deck.acknowledge";

export type ControlActionDeps = {
  runtime: DashboardRuntime;
};

function bindKeyTarget(
  ev: WillAppearEvent<ControlActionSettings>,
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

@action({ UUID: NEXT_ATTENTION_UUID })
export class NextAttentionAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    const target = bindKeyTarget(ev, this.targets);
    if (!target) return;
    this.deps.runtime.registerControlTarget("next", target);
    this.deps.runtime.addDemand();
    await this.deps.runtime.whenReady();
    await this.deps.runtime.refresh();
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    const target = this.targets.get(ev.action.id);
    if (target) {
      this.deps.runtime.unregisterControlTarget("next", target);
      this.targets.delete(ev.action.id);
    }
    this.deps.runtime.removeDemand();
  }

  override async onKeyDown(_ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    await this.deps.runtime.nextAttention();
  }
}

@action({ UUID: FOCUS_UUID })
export class FocusAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    const target = bindKeyTarget(ev, this.targets);
    if (!target) return;
    this.deps.runtime.registerControlTarget("focus", target);
    this.deps.runtime.addDemand();
    await this.deps.runtime.whenReady();
    await this.deps.runtime.refresh();
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    const target = this.targets.get(ev.action.id);
    if (target) {
      this.deps.runtime.unregisterControlTarget("focus", target);
      this.targets.delete(ev.action.id);
    }
    this.deps.runtime.removeDemand();
  }

  override async onKeyDown(_ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    await this.deps.runtime.focusSelected();
  }
}

@action({ UUID: ACKNOWLEDGE_UUID })
export class AcknowledgeAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    const target = bindKeyTarget(ev, this.targets);
    if (!target) return;
    this.deps.runtime.registerControlTarget("acknowledge", target);
    this.deps.runtime.addDemand();
    await this.deps.runtime.whenReady();
    await this.deps.runtime.refresh();
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    const target = this.targets.get(ev.action.id);
    if (target) {
      this.deps.runtime.unregisterControlTarget("acknowledge", target);
      this.targets.delete(ev.action.id);
    }
    this.deps.runtime.removeDemand();
  }

  override async onKeyDown(_ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    // Local metadata only — does not mutate Orca unread.
    await this.deps.runtime.acknowledgeSelected();
  }
}
