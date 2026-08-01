/**
 * Discovery and identity join: worktree agents ↔ live terminals.
 * logicalSessionId = worktreeId + ":" + paneKey
 * Fail-closed on ambiguous joins. Runtime handles are memory-only.
 */
import {
  makeLogicalSessionId,
  normalizeAgentState,
  normalizeAgentType,
  paneKeyFromTerminal,
  type AgentType,
  type KnownAgentState,
  type OrcaStatusResult,
  type OrcaTerminalListResult,
  type OrcaTerminalRecord,
  type OrcaWorktreePsResult,
  type RuntimeTerminalHandle,
} from "./schema.js";

export type JoinHealth =
  | "ok"
  | "missing_terminal"
  | "ambiguous"
  | "disconnected"
  | "not_writable"
  | "stale_handle"
  | "orca_unavailable"
  | "identity_lost";

export type LogicalSession = {
  logicalSessionId: string;
  worktreeId: string;
  paneKey: string;
  parentPaneKey?: string | null;
  hostId: string;
  repo?: string;
  repoId?: string;
  projectId?: string;
  projectHostSetupId?: string;
  displayName?: string;
  worktreeUnread: boolean;
  agentType: AgentType;
  rawState: string;
  state: KnownAgentState;
  interrupted: boolean;
  stateStartedAt: number | null;
  updatedAt: number | null;
  toolName: string | null;
  runtimeHandle?: RuntimeTerminalHandle;
  tabId?: string;
  leafId?: string;
  connected: boolean;
  writable: boolean;
  joinHealth: JoinHealth;
  ambiguousHandleCount?: number;
  /** Slot-consuming agents in the same worktree (excludes OMP children). */
  trackedAgentCountInWorktree: number;
  /** Contextual OMP child agent count aggregated onto the parent; children never take slots. */
  ompChildCount: number;
};

export type DiscoverySnapshot = {
  capturedAtMs: number;
  orcaReady: boolean;
  runtimeId?: string;
  appVersion?: string;
  capabilities: string[];
  sessions: LogicalSession[];
  ignoredShellCount: number;
  ambiguousCount: number;
  issues: string[];
};

export type JoinInput = {
  status?: OrcaStatusResult | null;
  worktreePs: OrcaWorktreePsResult;
  terminalList: OrcaTerminalListResult;
  nowMs?: number;
  previousHandles?: ReadonlyMap<string, string>;
};

function indexTerminals(terminals: readonly OrcaTerminalRecord[]): Map<string, OrcaTerminalRecord[]> {
  const byWorktreePane = new Map<string, OrcaTerminalRecord[]>();
  for (const t of terminals) {
    const paneKey = paneKeyFromTerminal(t.tabId, t.leafId);
    const key = `${t.worktreeId}\0${paneKey}`;
    const list = byWorktreePane.get(key);
    if (list) list.push(t);
    else byWorktreePane.set(key, [t]);
  }
  return byWorktreePane;
}

function isOmpChildAgent(parentPaneKey: string | null | undefined): boolean {
  return typeof parentPaneKey === "string" && parentPaneKey.length > 0;
}

export function joinDiscovery(input: JoinInput): DiscoverySnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const issues: string[] = [];
  const capabilities = input.status?.runtime?.capabilities ?? [];
  const runtimeState = input.status?.runtime?.state;
  const reachable = input.status?.runtime?.reachable;
  const orcaReady =
    input.status == null ? true : runtimeState === "ready" && reachable !== false;
  if (input.status && !orcaReady) issues.push("orca_runtime_not_ready");

  const worktrees = input.worktreePs.worktrees ?? [];
  const terminals = input.terminalList.terminals ?? [];
  const byWorktreePane = indexTerminals(terminals);

  // Slot-consuming agents only (OMP children with parentPaneKey are excluded).
  const trackedCounts = new Map<string, number>();
  const childCounts = new Map<string, number>(); // key: worktreeId\0parentPaneKey
  const agentPaneKeys = new Set<string>();

  for (const wt of worktrees) {
    let tracked = 0;
    for (const a of wt.agents ?? []) {
      agentPaneKeys.add(`${wt.worktreeId}\0${a.paneKey}`);
      if (isOmpChildAgent(a.parentPaneKey)) {
        const ck = `${wt.worktreeId}\0${a.parentPaneKey}`;
        childCounts.set(ck, (childCounts.get(ck) ?? 0) + 1);
      } else {
        tracked += 1;
      }
    }
    trackedCounts.set(wt.worktreeId, tracked);
  }

  let ignoredShellCount = 0;
  for (const t of terminals) {
    const pk = paneKeyFromTerminal(t.tabId, t.leafId);
    if (!agentPaneKeys.has(`${t.worktreeId}\0${pk}`)) ignoredShellCount += 1;
  }

  const sessions: LogicalSession[] = [];
  let ambiguousCount = 0;

  for (const wt of worktrees) {
    const trackedAgentCountInWorktree = trackedCounts.get(wt.worktreeId) ?? 0;
    for (const agent of wt.agents ?? []) {
      // OMP children never consume dashboard slots.
      if (isOmpChildAgent(agent.parentPaneKey)) continue;

      const logicalSessionId = makeLogicalSessionId(wt.worktreeId, agent.paneKey);
      const joinKey = `${wt.worktreeId}\0${agent.paneKey}`;
      const matches = byWorktreePane.get(joinKey) ?? [];
      const ompChildCount = childCounts.get(`${wt.worktreeId}\0${agent.paneKey}`) ?? 0;
      const base = {
        logicalSessionId,
        worktreeId: wt.worktreeId,
        paneKey: agent.paneKey,
        parentPaneKey: agent.parentPaneKey ?? null,
        hostId: wt.hostId ?? "local",
        repo: wt.repo,
        repoId: wt.repoId,
        projectId: wt.projectId,
        projectHostSetupId: wt.projectHostSetupId,
        displayName: wt.displayName,
        worktreeUnread: wt.unread === true,
        agentType: normalizeAgentType(agent.agentType),
        rawState: agent.state,
        state: normalizeAgentState(agent.state),
        interrupted: agent.interrupted === true,
        stateStartedAt: agent.stateStartedAt ?? null,
        updatedAt: agent.updatedAt ?? null,
        toolName: agent.toolName ?? null,
        trackedAgentCountInWorktree,
        ompChildCount,
      };

      if (matches.length === 0) {
        sessions.push({ ...base, connected: false, writable: false, joinHealth: "missing_terminal" });
        continue;
      }
      if (matches.length > 1) {
        ambiguousCount += 1;
        issues.push(`ambiguous_join:${logicalSessionId}:count=${matches.length}`);
        sessions.push({
          ...base,
          connected: false,
          writable: false,
          joinHealth: "ambiguous",
          ambiguousHandleCount: matches.length,
        });
        continue;
      }

      const term = matches[0]!;
      const connected = term.connected === true;
      const writable = term.writable === true;
      let joinHealth: JoinHealth = "ok";
      if (!connected) joinHealth = "disconnected";
      else if (!writable) joinHealth = "not_writable";

      sessions.push({
        ...base,
        runtimeHandle: term.handle as RuntimeTerminalHandle,
        tabId: term.tabId,
        leafId: term.leafId,
        connected,
        writable,
        joinHealth,
      });
    }
  }

  return {
    capturedAtMs: nowMs,
    orcaReady,
    runtimeId: input.status?.runtime?.runtimeId,
    appVersion: input.status?.runtime?.appVersion,
    capabilities: [...capabilities],
    sessions,
    ignoredShellCount,
    ambiguousCount,
    issues,
  };
}

export function reconcileAfterStaleHandle(input: {
  previousSessionIds: readonly string[];
  next: DiscoverySnapshot;
}): { surviving: LogicalSession[]; identityLostIds: string[]; newSessionIds: string[] } {
  const nextById = new Map(input.next.sessions.map((s) => [s.logicalSessionId, s]));
  const surviving: LogicalSession[] = [];
  const identityLostIds: string[] = [];
  const prevSet = new Set(input.previousSessionIds);
  for (const id of input.previousSessionIds) {
    const found = nextById.get(id);
    if (found && found.joinHealth !== "missing_terminal") surviving.push(found);
    else identityLostIds.push(id);
  }
  const newSessionIds: string[] = [];
  for (const s of input.next.sessions) {
    if (!prevSet.has(s.logicalSessionId)) newSessionIds.push(s.logicalSessionId);
  }
  return { surviving, identityLostIds, newSessionIds };
}

export function canMutateSession(session: LogicalSession): {
  allowed: boolean;
  reason?: JoinHealth | "orca_unavailable";
} {
  if (session.joinHealth === "ambiguous") return { allowed: false, reason: "ambiguous" };
  if (session.joinHealth === "missing_terminal") return { allowed: false, reason: "missing_terminal" };
  if (session.joinHealth === "disconnected") return { allowed: false, reason: "disconnected" };
  if (session.joinHealth === "not_writable") return { allowed: false, reason: "not_writable" };
  if (session.joinHealth === "stale_handle") return { allowed: false, reason: "stale_handle" };
  if (session.joinHealth === "identity_lost") return { allowed: false, reason: "identity_lost" };
  if (!session.runtimeHandle) return { allowed: false, reason: "missing_terminal" };
  if (!session.connected) return { allowed: false, reason: "disconnected" };
  if (!session.writable) return { allowed: false, reason: "not_writable" };
  return { allowed: true };
}

export function markStaleHandle(session: LogicalSession): LogicalSession {
  return {
    ...session,
    joinHealth: "stale_handle",
    runtimeHandle: undefined,
    connected: false,
    writable: false,
  };
}
