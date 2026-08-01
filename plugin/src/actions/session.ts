/**
 * Sixteen explicit session-slot actions.
 * Each UUID maps deterministically to a fixed slot; press selects only.
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

export type SessionActionSettings = JsonObject;

export const SESSION_ACTION_UUIDS: readonly string[] = Array.from(
  { length: 16 },
  (_, i) => `dev.onorca.agent-deck.session-${String(i + 1).padStart(2, "0")}`,
);

export function slotIndexFromUuid(uuid: string): number | null {
  const m = /^dev\.onorca\.agent-deck\.session-(\d{2})$/.exec(uuid);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 16) return null;
  return n - 1;
}

export type SessionActionDeps = {
  runtime: DashboardRuntime;
};

type SessionActionInstance = {
  slotIndex: number;
  deps: SessionActionDeps;
  targets: Map<string, PaintTarget>;
};

function createSessionActionClass(slotIndex: number, uuid: string) {
  @action({ UUID: uuid })
  class SessionSlotAction extends SingletonAction<SessionActionSettings> {
    private readonly slotIndex = slotIndex;
    private readonly deps: SessionActionDeps;
    private readonly targets = new Map<string, PaintTarget>();

    constructor(deps: SessionActionDeps) {
      super();
      this.deps = deps;
    }

    override async onWillAppear(ev: WillAppearEvent<SessionActionSettings>): Promise<void> {
      const action = ev.action;
      if (!action.isKey()) return;
      const target: PaintTarget = {
        id: action.id,
        setImage: (image, opts) =>
          action.setImage(image, { target: Target.HardwareAndSoftware, ...opts }),
        showOk: () => action.showOk(),
        showAlert: () => action.showAlert(),
      };
      this.targets.set(action.id, target);
      this.deps.runtime.registerSessionTarget(this.slotIndex, target);
      this.deps.runtime.addDemand();
      await this.deps.runtime.whenReady();
      // Visibility triggers immediate refresh via demand/kick.
      await this.deps.runtime.refresh();
    }

    override onWillDisappear(ev: WillDisappearEvent<SessionActionSettings>): void {
      const target = this.targets.get(ev.action.id);
      if (target) {
        this.deps.runtime.unregisterSessionTarget(this.slotIndex, target);
        this.targets.delete(ev.action.id);
      }
      this.deps.runtime.removeDemand();
    }

    override async onKeyDown(_ev: KeyDownEvent<SessionActionSettings>): Promise<void> {
      // Select only — never focus or acknowledge.
      await this.deps.runtime.selectSlot(this.slotIndex);
    }
  }

  return SessionSlotAction;
}

export type SessionActionCtor = new (deps: SessionActionDeps) => SingletonAction<SessionActionSettings>;

/**
 * Build the 16 session action instances (one class per UUID).
 */
export function createSessionActions(deps: SessionActionDeps): SingletonAction<SessionActionSettings>[] {
  return SESSION_ACTION_UUIDS.map((uuid, index) => {
    const Ctor = createSessionActionClass(index, uuid);
    return new Ctor(deps);
  });
}

// Silence unused type lint in some TS configs
export type _SessionActionInstance = SessionActionInstance;
