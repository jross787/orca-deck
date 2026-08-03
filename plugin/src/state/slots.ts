/**
 * Stable 16-slot allocator. Visible slots never reorder on state changes.
 * New sessions take the lowest free slot; overflow stays tracked but hidden.
 */

import { SLOT_COUNT } from "./types.js";

export type SlotAssignment = {
  /** logicalSessionId → slot 0–15 */
  slotByLogicalId: Map<string, number>;
  /** slot → logicalSessionId */
  logicalIdBySlot: Array<string | null>;
  hiddenIds: string[];
  overflowCount: number;
};

export function emptySlotAssignment(): SlotAssignment {
  return {
    slotByLogicalId: new Map(),
    logicalIdBySlot: Array.from({ length: SLOT_COUNT }, () => null),
    hiddenIds: [],
    overflowCount: 0,
  };
}

/**
 * Recompute assignment from previous mapping + live/ghost session ids.
 * `activeIds` are sessions that still need a slot (live, closed unacked, identity-lost unacked).
 * Freed ids (acked closed/identity-lost) must already be omitted.
 */
export function allocateSlots(
  previous: ReadonlyMap<string, number>,
  activeIds: readonly string[],
): SlotAssignment {
  const activeSet = new Set(activeIds);
  const logicalIdBySlot: Array<string | null> = Array.from({ length: SLOT_COUNT }, () => null);
  const slotByLogicalId = new Map<string, number>();

  // Preserve prior slots for still-active ids; drop collisions fail-closed to first occupant.
  const sortedPrev = [...previous.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  for (const [id, slot] of sortedPrev) {
    if (!activeSet.has(id)) continue;
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) continue;
    if (logicalIdBySlot[slot] != null) continue;
    logicalIdBySlot[slot] = id;
    slotByLogicalId.set(id, slot);
  }

  // Assign lowest free slots to new active ids in stable insertion order of activeIds.
  const freeSlots: number[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (logicalIdBySlot[i] == null) freeSlots.push(i);
  }
  let freeIdx = 0;
  const hiddenIds: string[] = [];
  for (const id of activeIds) {
    if (slotByLogicalId.has(id)) continue;
    const slot = freeSlots[freeIdx];
    if (slot === undefined) {
      hiddenIds.push(id);
      continue;
    }
    freeIdx += 1;
    logicalIdBySlot[slot] = id;
    slotByLogicalId.set(id, slot);
  }

  return {
    slotByLogicalId,
    logicalIdBySlot,
    hiddenIds,
    overflowCount: hiddenIds.length,
  };
}

export function lowestFreeSlot(logicalIdBySlot: ReadonlyArray<string | null>): number | null {
  for (let i = 0; i < logicalIdBySlot.length; i++) {
    if (logicalIdBySlot[i] == null) return i;
  }
  return null;
}
