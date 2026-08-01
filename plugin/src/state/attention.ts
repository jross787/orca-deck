/**
 * Next Attention ranking across visible + hidden sessions.
 * Does not move cards; only selects a target logical id.
 */

import type { CardViewModel, SessionCardState } from "./types.js";

const UNREAD_RANK: Record<string, number> = {
  waiting: 0,
  error: 1,
  stuck: 2,
  done: 3,
  closed: 3,
};

const NON_UNREAD_RANK: Record<string, number> = {
  disconnected: 4,
  identity_lost: 5,
  working: 6,
  stuck: 6,
  idle: 7,
  done: 8,
  waiting: 8,
  error: 8,
  closed: 8,
  unknown: 9,
  disabled: 9,
  unavailable: 10,
};

function unreadClassRank(state: SessionCardState): number | null {
  if (state in UNREAD_RANK) return UNREAD_RANK[state]!;
  return null;
}

function nonUnreadRank(state: SessionCardState): number {
  return NON_UNREAD_RANK[state] ?? 20;
}

export type RankedAttention = {
  logicalSessionId: string;
  rank: number;
  tie: number;
};

/**
 * Rank cards for Next Attention.
 * Priority: unread waiting → unread error → unread stuck → unread done/closed
 * → disconnected → identity lost → working → idle.
 * Unread ties: oldest transition first (smaller stateStartedAt / event).
 * Non-unread ties: most recently updated first.
 */
export function rankAttentionTargets(
  cards: readonly CardViewModel[],
  excludeLogicalSessionId?: string | null,
): RankedAttention[] {
  const ranked: RankedAttention[] = [];
  for (const card of cards) {
    if (excludeLogicalSessionId && card.logicalSessionId === excludeLogicalSessionId) {
      // Still include if it is the only candidate — caller filters alternatives.
      continue;
    }
    if (card.cardState === "unavailable") continue;

    if (card.unread && card.eventVersion) {
      const cls = unreadClassRank(card.eventVersion.state);
      if (cls == null) continue;
      ranked.push({
        logicalSessionId: card.logicalSessionId,
        rank: cls,
        tie: card.eventVersion.stateStartedAt,
      });
      continue;
    }

    ranked.push({
      logicalSessionId: card.logicalSessionId,
      rank: nonUnreadRank(card.cardState),
      tie: -(card.updatedAt ?? card.stateStartedAt ?? 0),
    });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.logicalSessionId.localeCompare(b.logicalSessionId));
  return ranked;
}

/**
 * Pick Next Attention target. Excludes current selection when alternatives exist.
 */
export function pickNextAttention(
  cards: readonly CardViewModel[],
  selectedLogicalSessionId: string | null,
): string | null {
  const without = rankAttentionTargets(cards, selectedLogicalSessionId);
  if (without.length > 0) return without[0]!.logicalSessionId;
  // Only the current selection (or nothing) remains.
  if (selectedLogicalSessionId) {
    const self = cards.find((c) => c.logicalSessionId === selectedLogicalSessionId);
    if (self && self.cardState !== "unavailable") return self.logicalSessionId;
  }
  const all = rankAttentionTargets(cards, null);
  return all[0]?.logicalSessionId ?? null;
}
