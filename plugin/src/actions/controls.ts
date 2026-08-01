/**
 * Next Attention, Focus, Acknowledge, and Phase 3 safe control keypad actions.
 * Share one DashboardRuntime; never poll independently.
 */

import {
  action,
  KeyDownEvent,
  KeyUpEvent,
  SingletonAction,
  Target,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import type { PresetIndex } from "../commands/presets.js";
import type { DashboardRuntime, PaintTarget, RuntimeControlKind } from "../state/runtime.js";

export type ControlActionSettings = JsonObject;

export const NEXT_ATTENTION_UUID = "dev.onorca.agent-deck.next-attention";
export const FOCUS_UUID = "dev.onorca.agent-deck.focus";
export const ACKNOWLEDGE_UUID = "dev.onorca.agent-deck.acknowledge";
export const INTERRUPT_CLOSE_UUID = "dev.onorca.agent-deck.interrupt-close";
export const PRESET_1_UUID = "dev.onorca.agent-deck.preset-1";
export const PRESET_2_UUID = "dev.onorca.agent-deck.preset-2";
export const PRESET_3_UUID = "dev.onorca.agent-deck.preset-3";
export const PRESET_4_UUID = "dev.onorca.agent-deck.preset-4";
export const RETRY_UUID = "dev.onorca.agent-deck.retry";
export const STRUCTURED_REPLY_UUID = "dev.onorca.agent-deck.structured-reply";
export const DRAFT_PLACEHOLDER_UUID = "dev.onorca.agent-deck.draft";

export const SAFE_CONTROL_UUIDS = [
  INTERRUPT_CLOSE_UUID,
  PRESET_1_UUID,
  PRESET_2_UUID,
  PRESET_3_UUID,
  PRESET_4_UUID,
  RETRY_UUID,
  STRUCTURED_REPLY_UUID,
  DRAFT_PLACEHOLDER_UUID,
] as const;

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

function appear(
  kind: RuntimeControlKind,
  deps: ControlActionDeps,
  targets: Map<string, PaintTarget>,
  ev: WillAppearEvent<ControlActionSettings>,
): Promise<void> {
  const target = bindKeyTarget(ev, targets);
  if (!target) return Promise.resolve();
  deps.runtime.registerControlTarget(kind, target);
  deps.runtime.addDemand();
  return deps.runtime.whenReady().then(async () => {
    await deps.runtime.refresh();
  });
}

function disappear(
  kind: RuntimeControlKind,
  deps: ControlActionDeps,
  targets: Map<string, PaintTarget>,
  ev: WillDisappearEvent<ControlActionSettings>,
): void {
  const target = targets.get(ev.action.id);
  if (target) {
    deps.runtime.unregisterControlTarget(kind, target);
    targets.delete(ev.action.id);
  }
  deps.runtime.removeDemand();
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
    await appear("next", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("next", this.deps, this.targets, ev);
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
    await appear("focus", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("focus", this.deps, this.targets, ev);
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
    await appear("acknowledge", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("acknowledge", this.deps, this.targets, ev);
  }

  override async onKeyDown(_ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    // Local metadata only — does not mutate Orca unread.
    await this.deps.runtime.acknowledgeSelected();
  }
}

@action({ UUID: INTERRUPT_CLOSE_UUID })
export class InterruptCloseAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    await appear("interrupt-close", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    this.deps.runtime.cancelInterruptHold(ev.action.id);
    disappear("interrupt-close", this.deps, this.targets, ev);
  }

  override onKeyDown(ev: KeyDownEvent<ControlActionSettings>): void {
    this.deps.runtime.beginInterruptHold(ev.action.id);
  }

  override async onKeyUp(ev: KeyUpEvent<ControlActionSettings>): Promise<void> {
    await this.deps.runtime.endInterruptHold(ev.action.id);
  }
}

abstract class PresetActionBase extends SingletonAction<ControlActionSettings> {
  protected abstract readonly index: PresetIndex;
  protected abstract readonly kind: RuntimeControlKind;
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    await appear(this.kind, this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear(this.kind, this.deps, this.targets, ev);
  }

  override async onKeyDown(ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    await this.deps.runtime.sendPreset(this.index, ev.action.id);
  }
}

@action({ UUID: PRESET_1_UUID })
export class Preset1Action extends PresetActionBase {
  protected readonly index = 0 as const;
  protected readonly kind = "preset-1" as const;
}

@action({ UUID: PRESET_2_UUID })
export class Preset2Action extends PresetActionBase {
  protected readonly index = 1 as const;
  protected readonly kind = "preset-2" as const;
}

@action({ UUID: PRESET_3_UUID })
export class Preset3Action extends PresetActionBase {
  protected readonly index = 2 as const;
  protected readonly kind = "preset-3" as const;
}

@action({ UUID: PRESET_4_UUID })
export class Preset4Action extends PresetActionBase {
  protected readonly index = 3 as const;
  protected readonly kind = "preset-4" as const;
}

@action({ UUID: RETRY_UUID })
export class RetryAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    await appear("retry", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("retry", this.deps, this.targets, ev);
  }

  override async onKeyDown(ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    await this.deps.runtime.retrySelected(ev.action.id);
  }
}

@action({ UUID: STRUCTURED_REPLY_UUID })
export class StructuredReplyAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    await appear("structured-reply", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("structured-reply", this.deps, this.targets, ev);
  }

  override async onKeyDown(ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    // Fail-closed: no public typed prompt/options contract.
    await this.deps.runtime.structuredReplySelected(ev.action.id);
  }
}

/**
 * Draft key is a non-executing Phase 4 placeholder face so layout stays stable.
 * Presses do nothing (no terminal input).
 */
@action({ UUID: DRAFT_PLACEHOLDER_UUID })
export class DraftPlaceholderAction extends SingletonAction<ControlActionSettings> {
  private readonly deps: ControlActionDeps;
  private readonly targets = new Map<string, PaintTarget>();

  constructor(deps: ControlActionDeps) {
    super();
    this.deps = deps;
  }

  override async onWillAppear(ev: WillAppearEvent<ControlActionSettings>): Promise<void> {
    await appear("draft", this.deps, this.targets, ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<ControlActionSettings>): void {
    disappear("draft", this.deps, this.targets, ev);
  }

  override async onKeyDown(_ev: KeyDownEvent<ControlActionSettings>): Promise<void> {
    // Phase 4 — intentionally non-executing.
  }
}

export function createSafeControlActions(deps: ControlActionDeps): SingletonAction<ControlActionSettings>[] {
  return [
    new InterruptCloseAction(deps),
    new Preset1Action(deps),
    new Preset2Action(deps),
    new Preset3Action(deps),
    new Preset4Action(deps),
    new RetryAction(deps),
    new StructuredReplyAction(deps),
    new DraftPlaceholderAction(deps),
  ];
}
