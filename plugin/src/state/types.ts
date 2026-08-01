/**
 * Dashboard presentation and metadata types for the sixteen-card engine.
 * Runtime terminal handles never appear in persisted metadata.
 */

import type { AgentType, KnownAgentState } from "../orca/schema.js";
import type { JoinHealth, LogicalSession } from "../orca/discovery.js";

export const SLOT_COUNT = 16 as const;

export type SessionCardState =
  | "unavailable"
  | "idle"
  | "working"
  | "waiting"
  | "done"
  | "error"
  | "stuck"
  | "disconnected"
  | "closed"
  | "identity_lost"
  | "unknown"
  | "disabled";

/** Unread event version: (logicalSessionId, state, stateStartedAt). */
export type EventVersion = {
  logicalSessionId: string;
  state: SessionCardState;
  stateStartedAt: number;
};

export function eventVersionKey(v: EventVersion): string {
  return `${v.logicalSessionId}\0${v.state}\0${v.stateStartedAt}`;
}

export function sameEventVersion(a: EventVersion | null | undefined, b: EventVersion | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.logicalSessionId === b.logicalSessionId &&
    a.state === b.state &&
    a.stateStartedAt === b.stateStartedAt
  );
}

export type SessionMeta = {
  logicalSessionId: string;
  /** Physical slot 0–15, or null when overflow/hidden. */
  slot: number | null;
  /** Last acknowledged event version (local only). */
  ackedEvent: EventVersion | null;
  /** Current unread event if unacknowledged. */
  unreadEvent: EventVersion | null;
  /** Whether worktree-unread seeding already applied for current event. */
  worktreeUnreadSeeded: boolean;
  /** Last time this session's presentation state changed. */
  stateChangedAt: number;
  /** First observed continuous working start (for stuck overlay). */
  workingSince: number | null;
  /** Last urgent alert event version (dedupe). */
  lastAlertEvent: EventVersion | null;
  lastAlertAt: number | null;
};

export type PersistedDashboardState = {
  schemaVersion: 1;
  selectedLogicalSessionId: string | null;
  /** logicalSessionId → slot (0–15). */
  slotByLogicalId: Record<string, number>;
  sessions: Record<
    string,
    {
      ackedEvent: EventVersion | null;
      unreadEvent: EventVersion | null;
      worktreeUnreadSeeded: boolean;
      stateChangedAt: number;
      workingSince: number | null;
      lastAlertEvent: EventVersion | null;
      lastAlertAt: number | null;
    }
  >;
};

export type CardViewModel = {
  logicalSessionId: string;
  slot: number | null;
  visible: boolean;
  selected: boolean;
  unread: boolean;
  stuck: boolean;
  cardState: SessionCardState;
  /** Underlying agent state when stuck overlays working. */
  underlyingState: KnownAgentState | SessionCardState;
  agentType: AgentType;
  repo: string;
  worktree: string;
  hostId: string;
  elapsedMs: number;
  ompChildCount: number;
  joinHealth: JoinHealth;
  connected: boolean;
  writable: boolean;
  /** Memory-only; never serialize. */
  runtimeHandle?: string;
  stateStartedAt: number | null;
  updatedAt: number | null;
  trackedAgentCountInWorktree: number;
  worktreeUnread: boolean;
  eventVersion: EventVersion | null;
};

export type ControlViewModel = {
  selectedLogicalSessionId: string | null;
  selectedCard: CardViewModel | null;
  nextTargetId: string | null;
  overflowCount: number;
  focusHighlighted: boolean;
  focusEnabled: boolean;
  ackEnabled: boolean;
  orcaReady: boolean;
  urgency: "working" | "idle" | "empty";
  issues: string[];
};

export type DashboardSnapshot = {
  capturedAtMs: number;
  orcaReady: boolean;
  runtimeId?: string;
  cards: CardViewModel[];
  /** Index 0–15 → card or empty. */
  slots: Array<CardViewModel | null>;
  hidden: CardViewModel[];
  control: ControlViewModel;
  /** Sessions still tracked for identity-lost / closed until ack frees slot. */
  metaById: Record<string, SessionMeta>;
  selectedLogicalSessionId: string | null;
  alerts: AlertEvent[];
};

export type AlertEvent = {
  logicalSessionId: string;
  event: EventVersion;
  kind: "waiting" | "error" | "stuck";
};

export type RefreshSource = {
  sessions: LogicalSession[];
  orcaReady: boolean;
  runtimeId?: string;
  issues?: string[];
  capturedAtMs: number;
};

export type DashboardAction =
  | { type: "refresh"; source: RefreshSource; stuckThresholdMinutes: number; nowMs: number }
  | { type: "select"; logicalSessionId: string | null }
  | { type: "acknowledge"; logicalSessionId: string; nowMs: number }
  | { type: "focus_success"; logicalSessionId: string; nowMs: number }
  | { type: "alert_emitted"; logicalSessionId: string; event: EventVersion; nowMs: number }
  | { type: "hydrate"; persisted: PersistedDashboardState };

/** Fail closed: persisted metadata must never carry handles or content. */
export function assertNoHandlesInPersisted(persisted: PersistedDashboardState): void {
  const text = JSON.stringify(persisted);
  if (/runtimeHandle|"handle"|ptyId|incarnation/i.test(text)) {
    throw new Error("persisted dashboard state must not contain runtime handles or terminal content");
  }
}
