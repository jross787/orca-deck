/**
 * Dashboard reducer: join refresh → presentation states, unread, slots, selection.
 * Fail-closed identity; no heuristic rebinding; handles never enter metadata.
 */

import type { LogicalSession } from "../orca/discovery.js";
import type { AgentType, KnownAgentState } from "../orca/schema.js";
import { allocateSlots, emptySlotAssignment } from "./slots.js";
import { pickNextAttention } from "./attention.js";
import {
  sameEventVersion,
  SLOT_COUNT,
  type AlertEvent,
  type CardViewModel,
  type ControlViewModel,
  type DashboardAction,
  type DashboardSnapshot,
  type EventVersion,
  type GhostLabel,
  type PersistedDashboardState,
  type SessionCardState,
  type SessionMeta,
} from "./types.js";

export type DashboardState = {
  selectedLogicalSessionId: string | null;
  slotByLogicalId: Map<string, number>;
  metaById: Map<string, SessionMeta>;
  /** Last live discovery sessions by id (memory; includes handles). */
  liveById: Map<string, LogicalSession>;
  /** Ghost cards retained until ack: closed / identity_lost. */
  ghosts: Map<string, CardViewModel>;
  /** Safe labels for ghosts (also used after hydrate before first refresh). */
  ghostLabels: Map<string, GhostLabel>;
  /**
   * Acquired-closed logical ids suppressed while still listed with missing_terminal.
   * Cleared when the id fully disappears from topology or reappears with a live terminal.
   */
  suppressedClosedIds: Set<string>;
  orcaReady: boolean;
  runtimeId?: string;
  issues: string[];
  capturedAtMs: number;
  pendingAlerts: AlertEvent[];
  stuckThresholdMinutes: number;
  /** True after at least one topology-reliable refresh since hydrate. */
  hasReliableTopology: boolean;
};

export function createInitialDashboardState(stuckThresholdMinutes = 60): DashboardState {
  return {
    selectedLogicalSessionId: null,
    slotByLogicalId: new Map(),
    metaById: new Map(),
    liveById: new Map(),
    ghosts: new Map(),
    ghostLabels: new Map(),
    suppressedClosedIds: new Set(),
    orcaReady: false,
    issues: [],
    capturedAtMs: 0,
    pendingAlerts: [],
    stuckThresholdMinutes,
    hasReliableTopology: false,
  };
}

function defaultMeta(logicalSessionId: string, nowMs: number, slot: number | null): SessionMeta {
  return {
    logicalSessionId,
    slot,
    ackedEvent: null,
    unreadEvent: null,
    worktreeUnreadSeeded: false,
    stateChangedAt: nowMs,
    workingSince: null,
    lastAlertEvent: null,
    lastAlertAt: null,
  };
}

function presentationFromSession(
  session: LogicalSession,
  meta: SessionMeta,
  stuckThresholdMinutes: number,
  nowMs: number,
): { cardState: SessionCardState; stuck: boolean; underlying: SessionCardState } {
  if (session.joinHealth === "identity_lost") {
    return { cardState: "identity_lost", stuck: false, underlying: "identity_lost" };
  }
  if (session.joinHealth === "disconnected") {
    return { cardState: "disconnected", stuck: false, underlying: "disconnected" };
  }
  if (session.joinHealth === "ambiguous") {
    return { cardState: "disabled", stuck: false, underlying: "unknown" };
  }
  if (session.joinHealth === "missing_terminal") {
    return { cardState: "closed", stuck: false, underlying: "closed" };
  }
  if (session.joinHealth === "stale_handle" || session.joinHealth === "not_writable") {
    return { cardState: "disabled", stuck: false, underlying: mapAgentState(session.state) };
  }
  if (session.joinHealth === "orca_unavailable") {
    return { cardState: "unavailable", stuck: false, underlying: "unavailable" };
  }

  const base = mapAgentState(session.state);
  if (base === "unknown") {
    return { cardState: "unknown", stuck: false, underlying: "unknown" };
  }

  const stuckMs = stuckThresholdMinutes * 60_000;
  const workingSince = meta.workingSince;
  const continuousWorking =
    base === "working" && workingSince != null && nowMs - workingSince >= stuckMs;
  if (continuousWorking) {
    return { cardState: "stuck", stuck: true, underlying: "working" };
  }
  return { cardState: base, stuck: false, underlying: base };
}

function mapAgentState(state: KnownAgentState): SessionCardState {
  switch (state) {
    case "working":
    case "waiting":
    case "done":
    case "error":
    case "idle":
    case "stuck":
    case "closed":
    case "identity_lost":
    case "unknown":
      return state;
    default:
      return "unknown";
  }
}

function makeEventVersion(
  logicalSessionId: string,
  cardState: SessionCardState,
  stateStartedAt: number | null,
  fallbackNow: number,
): EventVersion | null {
  if (
    cardState !== "waiting" &&
    cardState !== "done" &&
    cardState !== "error" &&
    cardState !== "stuck" &&
    cardState !== "closed" &&
    cardState !== "identity_lost"
  ) {
    return null;
  }
  return {
    logicalSessionId,
    state: cardState,
    stateStartedAt: stateStartedAt ?? fallbackNow,
  };
}

function alertKind(state: SessionCardState): AlertEvent["kind"] | null {
  if (state === "waiting" || state === "error" || state === "stuck") return state;
  return null;
}

function repoLabel(session: Pick<LogicalSession, "repo" | "worktreeId">): string {
  if (session.repo && session.repo.length > 0) return session.repo;
  const id = session.worktreeId;
  const idx = id.indexOf("::");
  return idx > 0 ? id.slice(0, idx) : id;
}

function worktreeLabel(session: Pick<LogicalSession, "displayName" | "worktreeId">): string {
  if (session.displayName && session.displayName.length > 0) return session.displayName;
  const id = session.worktreeId;
  const idx = id.indexOf("::");
  return idx >= 0 ? id.slice(idx + 2) : id;
}

function labelsFromSession(session: LogicalSession): GhostLabel {
  return {
    repo: repoLabel(session),
    worktree: worktreeLabel(session),
    agentType: session.agentType,
    hostId: session.hostId,
    cardState: "identity_lost",
  };
}

function labelsFromCard(card: CardViewModel, cardState: "closed" | "identity_lost"): GhostLabel {
  return {
    repo: card.repo,
    worktree: card.worktree,
    agentType: card.agentType,
    hostId: card.hostId,
    cardState,
  };
}

function buildCardView(
  session: LogicalSession | null,
  meta: SessionMeta,
  cardState: SessionCardState,
  stuck: boolean,
  underlying: SessionCardState,
  selected: boolean,
  nowMs: number,
  labels?: GhostLabel | null,
): CardViewModel {
  const logicalSessionId = meta.logicalSessionId;
  const stateStartedAt =
    session?.stateStartedAt ?? meta.unreadEvent?.stateStartedAt ?? meta.stateChangedAt;
  const event = meta.unreadEvent;
  const elapsedBase =
    cardState === "stuck" && meta.workingSince != null
      ? meta.workingSince
      : (stateStartedAt ?? meta.stateChangedAt);
  return {
    logicalSessionId,
    slot: meta.slot,
    visible: meta.slot != null,
    selected,
    unread: event != null && !sameEventVersion(event, meta.ackedEvent),
    stuck,
    cardState,
    underlyingState: underlying,
    agentType: (session?.agentType ?? labels?.agentType ?? "unknown") as AgentType,
    repo: session ? repoLabel(session) : (labels?.repo ?? logicalSessionId.split(":")[0] ?? "?"),
    worktree: session ? worktreeLabel(session) : (labels?.worktree ?? "lost"),
    hostId: session?.hostId ?? labels?.hostId ?? "local",
    elapsedMs: Math.max(0, nowMs - elapsedBase),
    ompChildCount: session?.ompChildCount ?? 0,
    joinHealth:
      session?.joinHealth ??
      (cardState === "identity_lost" ? "identity_lost" : "missing_terminal"),
    connected: session?.connected ?? false,
    writable: session?.writable ?? false,
    runtimeHandle: session?.runtimeHandle,
    stateStartedAt: session?.stateStartedAt ?? null,
    updatedAt: session?.updatedAt ?? null,
    trackedAgentCountInWorktree: session?.trackedAgentCountInWorktree ?? 1,
    worktreeUnread: session?.worktreeUnread ?? false,
    eventVersion: event,
  };
}

function ensureMeta(
  state: DashboardState,
  logicalSessionId: string,
  nowMs: number,
): SessionMeta {
  let meta = state.metaById.get(logicalSessionId);
  if (!meta) {
    meta = defaultMeta(logicalSessionId, nowMs, state.slotByLogicalId.get(logicalSessionId) ?? null);
    state.metaById.set(logicalSessionId, meta);
  }
  return meta;
}

function applyUnreadTransition(
  meta: SessionMeta,
  nextEvent: EventVersion | null,
  nowMs: number,
  alerts: AlertEvent[],
): void {
  if (!nextEvent) return;
  const prev = meta.unreadEvent;
  if (prev && sameEventVersion(prev, nextEvent)) return;
  if (meta.ackedEvent && sameEventVersion(meta.ackedEvent, nextEvent)) {
    meta.unreadEvent = nextEvent;
    return;
  }
  meta.unreadEvent = nextEvent;
  meta.worktreeUnreadSeeded = false;
  meta.stateChangedAt = nowMs;

  const kind = alertKind(nextEvent.state);
  if (kind && !sameEventVersion(meta.lastAlertEvent, nextEvent)) {
    alerts.push({ logicalSessionId: meta.logicalSessionId, event: nextEvent, kind });
  }
}

function seedWorktreeUnread(
  meta: SessionMeta,
  session: LogicalSession,
  cardState: SessionCardState,
  nowMs: number,
): void {
  if (!session.worktreeUnread) return;
  if (session.trackedAgentCountInWorktree !== 1) return;
  if (meta.worktreeUnreadSeeded) return;
  if (meta.unreadEvent) {
    meta.worktreeUnreadSeeded = true;
    return;
  }
  const ev = makeEventVersion(meta.logicalSessionId, cardState, session.stateStartedAt, nowMs);
  if (!ev) return;
  if (meta.ackedEvent && sameEventVersion(meta.ackedEvent, ev)) {
    meta.worktreeUnreadSeeded = true;
    return;
  }
  meta.unreadEvent = ev;
  meta.worktreeUnreadSeeded = true;
}

function updateWorkingSince(meta: SessionMeta, underlying: SessionCardState, nowMs: number): void {
  if (underlying === "working") {
    if (meta.workingSince == null) meta.workingSince = nowMs;
  } else {
    meta.workingSince = null;
  }
}

function acknowledgeMeta(meta: SessionMeta, nowMs: number): void {
  if (meta.unreadEvent) {
    meta.ackedEvent = { ...meta.unreadEvent };
  }
  meta.stateChangedAt = nowMs;
}

function isGhostFreeable(cardState: SessionCardState, meta: SessionMeta): boolean {
  if (cardState !== "closed" && cardState !== "identity_lost") return false;
  if (!meta.unreadEvent) return true;
  return sameEventVersion(meta.unreadEvent, meta.ackedEvent);
}

function makeIdentityLostGhost(
  state: DashboardState,
  id: string,
  nowMs: number,
  labels: GhostLabel,
  prevSession: LogicalSession | null,
): void {
  const meta = ensureMeta(state, id, nowMs);
  const ev: EventVersion = {
    logicalSessionId: id,
    state: "identity_lost",
    stateStartedAt: nowMs,
  };
  if (!sameEventVersion(meta.unreadEvent, ev) && !sameEventVersion(meta.ackedEvent, ev)) {
    meta.unreadEvent = ev;
    meta.stateChangedAt = nowMs;
  }
  const label: GhostLabel = { ...labels, cardState: "identity_lost" };
  state.ghostLabels.set(id, label);
  const ghost = buildCardView(
    prevSession
      ? {
          ...prevSession,
          runtimeHandle: undefined,
          connected: false,
          writable: false,
          joinHealth: "identity_lost",
          state: "identity_lost",
          rawState: "identity_lost",
        }
      : null,
    meta,
    "identity_lost",
    false,
    "identity_lost",
    state.selectedLogicalSessionId === id,
    nowMs,
    label,
  );
  state.ghosts.set(id, ghost);
}

function makeClosedGhost(
  state: DashboardState,
  id: string,
  nowMs: number,
  session: LogicalSession | null,
  labels: GhostLabel,
): void {
  const meta = ensureMeta(state, id, nowMs);
  const ev: EventVersion = {
    logicalSessionId: id,
    state: "closed",
    stateStartedAt: nowMs,
  };
  if (!sameEventVersion(meta.ackedEvent, ev)) {
    if (!sameEventVersion(meta.unreadEvent, ev)) {
      meta.unreadEvent = ev;
      meta.stateChangedAt = nowMs;
    }
  }
  const label: GhostLabel = { ...labels, cardState: "closed" };
  state.ghostLabels.set(id, label);
  const ghost = buildCardView(
    session
      ? { ...session, joinHealth: "missing_terminal", runtimeHandle: undefined, connected: false, writable: false }
      : null,
    meta,
    "closed",
    false,
    "closed",
    state.selectedLogicalSessionId === id,
    nowMs,
    label,
  );
  state.ghosts.set(id, ghost);
}

function freeSession(state: DashboardState, id: string): void {
  state.ghosts.delete(id);
  state.ghostLabels.delete(id);
  state.metaById.delete(id);
  state.slotByLogicalId.delete(id);
  if (state.selectedLogicalSessionId === id) state.selectedLogicalSessionId = null;
}

function refreshTopologyUnreliable(
  state: DashboardState,
  action: Extract<DashboardAction, { type: "refresh" }>,
): DashboardState {
  const source = action.source;
  state.orcaReady = source.orcaReady;
  state.runtimeId = source.runtimeId;
  state.issues = [...(source.issues ?? [])];
  state.capturedAtMs = source.capturedAtMs;
  state.stuckThresholdMinutes = action.stuckThresholdMinutes;
  state.pendingAlerts = [];
  // Keep liveById / ghosts / slots / unread / meta untouched.
  return state;
}

function refreshDashboard(
  state: DashboardState,
  action: Extract<DashboardAction, { type: "refresh" }>,
): DashboardState {
  const source = action.source;
  if (!source.topologyReliable) {
    return refreshTopologyUnreliable(state, action);
  }

  const nowMs = action.nowMs;
  const stuckThresholdMinutes = action.stuckThresholdMinutes;
  const nextLive = new Map<string, LogicalSession>();
  for (const s of source.sessions) nextLive.set(s.logicalSessionId, s);

  const alerts: AlertEvent[] = [];
  const prevLiveIds = new Set(state.liveById.keys());
  const nextLiveIds = new Set(nextLive.keys());
  const firstReliable = !state.hasReliableTopology;

  // Hydrate recovery: persisted slotted sessions missing from first reliable topology → identity_lost.
  if (firstReliable) {
    for (const [id, slot] of state.slotByLogicalId) {
      if (nextLiveIds.has(id)) continue;
      if (state.ghosts.has(id)) continue;
      if (state.suppressedClosedIds.has(id)) continue;
      const labels =
        state.ghostLabels.get(id) ??
        ({
          repo: id.split(":")[0] ?? "?",
          worktree: "lost",
          agentType: "unknown",
          hostId: "local",
          cardState: "identity_lost",
        } satisfies GhostLabel);
      makeIdentityLostGhost(state, id, nowMs, labels, null);
      void slot;
    }
    // Also ghost any hydrated meta ids that had unread closed/identity_lost and no live match.
    for (const [id, meta] of state.metaById) {
      if (nextLiveIds.has(id) || state.ghosts.has(id)) continue;
      if (state.suppressedClosedIds.has(id)) continue;
      const unreadState = meta.unreadEvent?.state;
      if (unreadState === "closed" || unreadState === "identity_lost") {
        const labels =
          state.ghostLabels.get(id) ??
          ({
            repo: id.split(":")[0] ?? "?",
            worktree: "lost",
            agentType: "unknown",
            hostId: "local",
            cardState: unreadState,
          } satisfies GhostLabel);
        if (unreadState === "closed") {
          makeClosedGhost(state, id, nowMs, null, labels);
        } else {
          makeIdentityLostGhost(state, id, nowMs, labels, null);
        }
      }
    }
  }

  // Identity-lost: previous live ids missing from next (paneKey did not survive).
  for (const id of prevLiveIds) {
    if (nextLiveIds.has(id)) continue;
    if (state.ghosts.has(id)) continue;
    // Fully gone: clear suppression so a future new appearance is a new lifecycle.
    state.suppressedClosedIds.delete(id);
    const prev = state.liveById.get(id)!;
    makeIdentityLostGhost(state, id, nowMs, labelsFromSession(prev), prev);
  }

  // missing_terminal → closed ghost (including first observation).
  for (const [id, session] of nextLive) {
    if (session.joinHealth !== "missing_terminal") continue;
    if (state.suppressedClosedIds.has(id)) continue;
    if (state.ghosts.has(id) && state.ghosts.get(id)!.cardState === "closed") continue;

    const prev = state.liveById.get(id);
    const transitioned =
      !prev || prev.joinHealth !== "missing_terminal" || !state.ghosts.has(id);
    if (!transitioned && state.ghosts.has(id)) continue;

    makeClosedGhost(state, id, nowMs, session, labelsFromSession(session));
  }

  // Update live sessions presentation + unread.
  for (const [id, session] of nextLive) {
    // Suppressed closed while still missing_terminal: do not re-track.
    if (state.suppressedClosedIds.has(id) && session.joinHealth === "missing_terminal") {
      continue;
    }
    // Live terminal returned: clear suppression and closed/identity ghost.
    if (
      state.suppressedClosedIds.has(id) &&
      session.joinHealth !== "missing_terminal" &&
      session.joinHealth !== "identity_lost"
    ) {
      state.suppressedClosedIds.delete(id);
    }

    const existingGhost = state.ghosts.get(id);
    if (existingGhost && (existingGhost.cardState === "closed" || existingGhost.cardState === "identity_lost")) {
      if (session.joinHealth === "missing_terminal" || session.joinHealth === "identity_lost") {
        continue;
      }
      // Pane returned with same logical id — clear ghost, reattach handle.
      state.ghosts.delete(id);
      state.ghostLabels.delete(id);
      state.suppressedClosedIds.delete(id);
    }

    if (session.joinHealth === "missing_terminal") {
      // Already ghosted above; skip live presentation.
      continue;
    }

    const meta = ensureMeta(state, id, nowMs);
    updateWorkingSince(meta, mapAgentState(session.state), nowMs);
    const pres = presentationFromSession(session, meta, stuckThresholdMinutes, nowMs);
    const ev = makeEventVersion(id, pres.cardState, session.stateStartedAt, nowMs);
    applyUnreadTransition(meta, ev, nowMs, alerts);
    seedWorktreeUnread(
      meta,
      session,
      pres.cardState === "stuck" ? "working" : pres.cardState,
      nowMs,
    );
  }

  // Drop freeable ghosts (acked closed / identity_lost).
  for (const [id, ghost] of [...state.ghosts.entries()]) {
    const meta = state.metaById.get(id);
    if (!meta) {
      state.ghosts.delete(id);
      state.ghostLabels.delete(id);
      continue;
    }
    if (isGhostFreeable(ghost.cardState, meta)) {
      if (ghost.cardState === "closed") {
        // Keep suppressed while still listed missing_terminal.
        const stillListed = nextLive.get(id);
        if (stillListed && stillListed.joinHealth === "missing_terminal") {
          state.suppressedClosedIds.add(id);
        }
      }
      freeSession(state, id);
    }
  }

  // Active ids = live (not ghosted/suppressed) + remaining ghosts.
  const activeIds: string[] = [];
  const seen = new Set<string>();
  for (const [id, session] of nextLive) {
    if (state.ghosts.has(id)) continue;
    if (state.suppressedClosedIds.has(id) && session.joinHealth === "missing_terminal") continue;
    activeIds.push(id);
    seen.add(id);
  }
  for (const id of state.ghosts.keys()) {
    if (seen.has(id)) continue;
    activeIds.push(id);
    seen.add(id);
  }

  const assignment = allocateSlots(state.slotByLogicalId, activeIds);
  state.slotByLogicalId = assignment.slotByLogicalId;
  for (const [id, slot] of assignment.slotByLogicalId) {
    const meta = ensureMeta(state, id, nowMs);
    meta.slot = slot;
  }
  for (const id of assignment.hiddenIds) {
    const meta = ensureMeta(state, id, nowMs);
    meta.slot = null;
  }

  // Prune meta for ids no longer active (keep suppressed set itself).
  for (const id of [...state.metaById.keys()]) {
    if (!seen.has(id)) state.metaById.delete(id);
  }
  // Drop suppression for ids that fully disappeared from topology.
  for (const id of [...state.suppressedClosedIds]) {
    if (!nextLiveIds.has(id)) state.suppressedClosedIds.delete(id);
  }

  state.liveById = nextLive;
  state.orcaReady = source.orcaReady;
  state.runtimeId = source.runtimeId;
  state.issues = [...(source.issues ?? [])];
  state.capturedAtMs = source.capturedAtMs;
  state.stuckThresholdMinutes = stuckThresholdMinutes;
  state.pendingAlerts = alerts;
  state.hasReliableTopology = true;
  return state;
}

export function reduceDashboard(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "hydrate": {
      const p = action.persisted;
      state.selectedLogicalSessionId = p.selectedLogicalSessionId;
      state.slotByLogicalId = new Map(
        Object.entries(p.slotByLogicalId).filter(
          ([, slot]) => Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT,
        ),
      );
      state.metaById = new Map();
      state.ghostLabels = new Map();
      state.ghosts = new Map();
      state.suppressedClosedIds = new Set(p.suppressedClosedIds ?? []);
      state.hasReliableTopology = false;
      state.liveById = new Map();

      for (const [id, raw] of Object.entries(p.sessions)) {
        state.metaById.set(id, {
          logicalSessionId: id,
          slot: state.slotByLogicalId.get(id) ?? null,
          ackedEvent: raw.ackedEvent,
          unreadEvent: raw.unreadEvent,
          worktreeUnreadSeeded: raw.worktreeUnreadSeeded,
          stateChangedAt: raw.stateChangedAt,
          workingSince: raw.workingSince,
          lastAlertEvent: raw.lastAlertEvent,
          lastAlertAt: raw.lastAlertAt,
        });
        if (raw.ghostLabel) state.ghostLabels.set(id, raw.ghostLabel);
      }
      if (p.ghosts) {
        for (const [id, label] of Object.entries(p.ghosts)) {
          state.ghostLabels.set(id, label);
        }
      }
      return state;
    }
    case "select": {
      state.selectedLogicalSessionId = action.logicalSessionId;
      return state;
    }
    case "acknowledge":
    case "focus_success": {
      const id = action.logicalSessionId;
      const meta = state.metaById.get(id);
      if (meta) acknowledgeMeta(meta, action.nowMs);
      const ghost = state.ghosts.get(id);
      if (ghost && meta && isGhostFreeable(ghost.cardState, meta)) {
        if (ghost.cardState === "closed") {
          const live = state.liveById.get(id);
          if (live && live.joinHealth === "missing_terminal") {
            state.suppressedClosedIds.add(id);
          }
        }
        freeSession(state, id);
      }
      return state;
    }
    case "alert_emitted": {
      const meta = state.metaById.get(action.logicalSessionId);
      if (meta) {
        meta.lastAlertEvent = action.event;
        meta.lastAlertAt = action.nowMs;
      }
      state.pendingAlerts = state.pendingAlerts.filter(
        (a) =>
          !(
            a.logicalSessionId === action.logicalSessionId &&
            sameEventVersion(a.event, action.event)
          ),
      );
      return state;
    }
    case "refresh":
      return refreshDashboard(state, action);
    default:
      return state;
  }
}

function applyUnavailableOverlay(card: CardViewModel, orcaReady: boolean): CardViewModel {
  if (orcaReady) return card;
  if (card.cardState === "closed" || card.cardState === "identity_lost") return card;
  return {
    ...card,
    cardState: "unavailable",
    stuck: false,
    underlyingState: card.underlyingState,
    runtimeHandle: undefined,
    connected: false,
    writable: false,
  };
}

export function selectDashboardSnapshot(
  state: DashboardState,
  nowMs: number = state.capturedAtMs,
): DashboardSnapshot {
  const cards: CardViewModel[] = [];
  const stuckThresholdMinutes = state.stuckThresholdMinutes;

  for (const [id, session] of state.liveById) {
    if (state.ghosts.has(id)) continue;
    if (state.suppressedClosedIds.has(id) && session.joinHealth === "missing_terminal") continue;
    const meta =
      state.metaById.get(id) ??
      defaultMeta(id, nowMs, state.slotByLogicalId.get(id) ?? null);
    meta.slot = state.slotByLogicalId.has(id) ? state.slotByLogicalId.get(id)! : meta.slot;
    const pres = presentationFromSession(session, meta, stuckThresholdMinutes, nowMs);
    let card = buildCardView(
      session,
      meta,
      pres.cardState,
      pres.stuck,
      pres.underlying,
      state.selectedLogicalSessionId === id,
      nowMs,
    );
    card = applyUnavailableOverlay(card, state.orcaReady);
    cards.push(card);
  }

  for (const [id, ghost] of state.ghosts) {
    const meta =
      state.metaById.get(id) ??
      defaultMeta(id, nowMs, state.slotByLogicalId.get(id) ?? null);
    meta.slot = state.slotByLogicalId.has(id) ? state.slotByLogicalId.get(id)! : null;
    const labels = state.ghostLabels.get(id) ?? labelsFromCard(ghost, ghost.cardState as "closed" | "identity_lost");
    const refreshed = buildCardView(
      null,
      meta,
      ghost.cardState,
      false,
      ghost.cardState,
      state.selectedLogicalSessionId === id,
      nowMs,
      labels,
    );
    cards.push({
      ...refreshed,
      repo: labels.repo,
      worktree: labels.worktree,
      agentType: labels.agentType as AgentType,
      hostId: labels.hostId,
      ompChildCount: ghost.ompChildCount,
      joinHealth: ghost.cardState === "identity_lost" ? "identity_lost" : "missing_terminal",
    });
  }

  const slots: Array<CardViewModel | null> = Array.from({ length: SLOT_COUNT }, () => null);
  const hidden: CardViewModel[] = [];
  for (const card of cards) {
    if (card.slot != null && card.slot >= 0 && card.slot < SLOT_COUNT) {
      slots[card.slot] = { ...card, visible: true };
    } else {
      hidden.push({ ...card, visible: false, slot: null });
    }
  }

  const selected =
    cards.find((c) => c.logicalSessionId === state.selectedLogicalSessionId) ?? null;
  const nextTargetId = pickNextAttention(cards, state.selectedLogicalSessionId);
  const overflowCount = hidden.length;

  const focusHighlighted = Boolean(
    selected &&
      (selected.cardState === "unknown" ||
        selected.cardState === "disabled" ||
        selected.joinHealth === "ambiguous"),
  );
  const focusEnabled = Boolean(
    selected &&
      selected.runtimeHandle &&
      selected.connected &&
      selected.writable &&
      selected.joinHealth === "ok" &&
      state.orcaReady,
  );
  const ackEnabled = Boolean(selected && selected.unread);

  let urgency: ControlViewModel["urgency"] = "empty";
  if (!state.orcaReady || cards.length === 0) urgency = "empty";
  else if (
    cards.some(
      (c) =>
        c.cardState === "working" ||
        c.cardState === "waiting" ||
        c.cardState === "error" ||
        c.cardState === "stuck",
    )
  ) {
    urgency = "working";
  } else urgency = "idle";

  const metaById: Record<string, SessionMeta> = {};
  for (const [id, meta] of state.metaById) metaById[id] = { ...meta };

  return {
    capturedAtMs: state.capturedAtMs,
    orcaReady: state.orcaReady,
    runtimeId: state.runtimeId,
    cards,
    slots,
    hidden,
    control: {
      selectedLogicalSessionId: state.selectedLogicalSessionId,
      selectedCard: selected,
      nextTargetId,
      overflowCount,
      focusHighlighted,
      focusEnabled,
      ackEnabled,
      orcaReady: state.orcaReady,
      urgency,
      issues: [...state.issues],
    },
    metaById,
    selectedLogicalSessionId: state.selectedLogicalSessionId,
    alerts: [...state.pendingAlerts],
  };
}

export function toPersistedState(state: DashboardState): PersistedDashboardState {
  const slotByLogicalId: Record<string, number> = {};
  for (const [id, slot] of state.slotByLogicalId) {
    if (slot >= 0 && slot < SLOT_COUNT) slotByLogicalId[id] = slot;
  }
  const sessions: PersistedDashboardState["sessions"] = {};
  for (const [id, meta] of state.metaById) {
    const label = state.ghostLabels.get(id) ?? null;
    sessions[id] = {
      ackedEvent: meta.ackedEvent,
      unreadEvent: meta.unreadEvent,
      worktreeUnreadSeeded: meta.worktreeUnreadSeeded,
      stateChangedAt: meta.stateChangedAt,
      workingSince: meta.workingSince,
      lastAlertEvent: meta.lastAlertEvent,
      lastAlertAt: meta.lastAlertAt,
      ghostLabel: label,
    };
  }
  const ghosts: Record<string, GhostLabel> = {};
  for (const [id, label] of state.ghostLabels) {
    ghosts[id] = label;
  }
  return {
    schemaVersion: 1,
    selectedLogicalSessionId: state.selectedLogicalSessionId,
    slotByLogicalId,
    sessions,
    ghosts,
    suppressedClosedIds: [...state.suppressedClosedIds],
  };
}

export { emptySlotAssignment } from "./slots.js";
export { eventVersionKey } from "./types.js";
