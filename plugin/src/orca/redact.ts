/**
 * Strip content-bearing and identity-sensitive fields before any disk write.
 */
import type {
  FixtureMeta,
  FixtureProvenance,
  OrcaEnvelope,
  OrcaStatusResult,
  OrcaTerminalListResult,
  OrcaTerminalRecord,
  OrcaWorktreePsResult,
  OrcaWorktreeRecord,
  RedactedFixtureBundle,
  RedactedTerminalRecord,
  RedactedWorktreeRecord,
} from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";

const STRIPPED_FIELDS = [
  "prompt",
  "lastAssistantMessage",
  "toolInput",
  "preview",
  "title",
  "path",
  "worktreePath",
  "handle",
  "ptyId",
  "comment",
] as const;

/** True when a string may embed an absolute user path or home directory. */
export function isPathLike(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("/Users/") || value.includes("/home/") || value.includes("\\Users\\")) return true;
  if (value.includes("::/") || value.includes("::\\")) return true;
  if (value.startsWith("/") || value.startsWith("~/") || value.startsWith("~\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}

function safeToken(value: string | undefined | null, fallback: string): string | undefined {
  if (value == null) return undefined;
  if (value.length === 0) return undefined;
  if (isPathLike(value)) return fallback;
  return value;
}

function safeOptional(value: string | undefined | null): string | undefined {
  if (value == null || value.length === 0) return undefined;
  if (isPathLike(value)) return undefined;
  return value;
}

/**
 * Build a deterministic raw worktreeId → fixture worktreeId map for one bundle.
 * Path-bearing IDs become wt_<n>; safe IDs are preserved. Same map must be used
 * for worktree and terminal records so joins stay coherent.
 */
export function buildWorktreeIdMap(
  worktrees: readonly OrcaWorktreeRecord[],
  terminals: readonly OrcaTerminalRecord[],
): Map<string, string> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const wt of worktrees) {
    if (!seen.has(wt.worktreeId)) {
      seen.add(wt.worktreeId);
      ordered.push(wt.worktreeId);
    }
  }
  for (const term of terminals) {
    if (!seen.has(term.worktreeId)) {
      seen.add(term.worktreeId);
      ordered.push(term.worktreeId);
    }
  }

  const map = new Map<string, string>();
  let pathIndex = 0;
  for (const raw of ordered) {
    if (isPathLike(raw)) {
      map.set(raw, `wt_${pathIndex}`);
      pathIndex += 1;
    } else {
      map.set(raw, raw);
    }
  }
  return map;
}

export function redactWorktree(
  wt: OrcaWorktreeRecord,
  index: number,
  worktreeIdMap: ReadonlyMap<string, string>,
): RedactedWorktreeRecord {
  const worktreeId = worktreeIdMap.get(wt.worktreeId) ?? `wt_${index}`;
  return {
    workspaceKind: wt.workspaceKind,
    worktreeId,
    repoId: safeToken(wt.repoId, `<redacted-repo-id:#${index}>`),
    hostId: safeToken(wt.hostId, `<redacted-host:#${index}>`) ?? "local",
    terminalPlatform: wt.terminalPlatform,
    repo: safeToken(wt.repo, `<redacted-repo:#${index}>`),
    pathPlaceholder: `<redacted-path:#${index}>`,
    branch: safeOptional(wt.branch),
    isArchived: wt.isArchived,
    isMainWorktree: wt.isMainWorktree,
    worktreeInstanceId: safeToken(wt.worktreeInstanceId, `<redacted-wti:#${index}>`),
    displayName: safeToken(wt.displayName, `<redacted-name:#${index}>`),
    isActive: wt.isActive,
    unread: wt.unread,
    liveTerminalCount: wt.liveTerminalCount,
    hasAttachedPty: wt.hasAttachedPty,
    lastOutputAt: wt.lastOutputAt ?? null,
    status: wt.status,
    agents: (wt.agents ?? []).map((a) => ({
      paneKey: a.paneKey,
      parentPaneKey: a.parentPaneKey ?? null,
      state: a.state,
      agentType: a.agentType ?? null,
      toolName: a.toolName ?? null,
      interrupted: a.interrupted,
      stateStartedAt: a.stateStartedAt ?? null,
      updatedAt: a.updatedAt ?? null,
      hasPrompt: typeof a.prompt === "string" && a.prompt.length > 0,
      hasToolInput: a.toolInput != null && a.toolInput !== "",
    })),
  };
}

export function redactTerminal(
  term: OrcaTerminalRecord,
  index: number,
  worktreeIdMap: ReadonlyMap<string, string>,
): RedactedTerminalRecord {
  const worktreeId = worktreeIdMap.get(term.worktreeId) ?? `wt_orphan_${index}`;
  return {
    handlePlaceholder: `<redacted-handle:${index}>`,
    incarnationId: safeToken(term.incarnationId, `<redacted-inc:#${index}>`),
    orphaned: term.orphaned,
    worktreeId,
    tabId: term.tabId,
    leafId: term.leafId,
    connected: term.connected,
    writable: term.writable,
    lastOutputAt: term.lastOutputAt ?? null,
    hasTitle: typeof term.title === "string" && term.title.length > 0,
  };
}

export function redactStatusForFixture(
  envelope: OrcaEnvelope<OrcaStatusResult>,
): OrcaEnvelope<OrcaStatusResult> {
  const result = envelope.result;
  if (!result) return { ok: envelope.ok, id: envelope.id };
  return {
    ok: envelope.ok,
    id: typeof envelope.id === "string" ? "<redacted-envelope-id>" : envelope.id,
    result: {
      app: result.app
        ? { running: result.app.running, desktopWindowStatus: result.app.desktopWindowStatus }
        : undefined,
      runtime: result.runtime
        ? {
            state: result.runtime.state,
            reachable: result.runtime.reachable,
            runtimeId: result.runtime.runtimeId,
            appVersion: result.runtime.appVersion,
            capabilities: result.runtime.capabilities,
          }
        : undefined,
      graph: result.graph ? { state: result.graph.state } : undefined,
    },
    _meta: envelope._meta?.runtimeId ? { runtimeId: envelope._meta.runtimeId } : undefined,
  };
}

export function buildRedactedFixture(input: {
  provenance: FixtureProvenance;
  scenario: string;
  status?: OrcaEnvelope<OrcaStatusResult>;
  worktreePs: OrcaEnvelope<OrcaWorktreePsResult>;
  terminalList: OrcaEnvelope<OrcaTerminalListResult>;
  notes?: string[];
  capturedAt?: string;
  orcaAppVersion?: string;
}): RedactedFixtureBundle {
  const rawWorktrees = input.worktreePs.result?.worktrees ?? [];
  const rawTerminals = input.terminalList.result?.terminals ?? [];
  const worktreeIdMap = buildWorktreeIdMap(rawWorktrees, rawTerminals);
  const worktrees = rawWorktrees.map((wt, i) => redactWorktree(wt, i, worktreeIdMap));
  const terminals = rawTerminals.map((t, i) => redactTerminal(t, i, worktreeIdMap));
  const meta: FixtureMeta = {
    schemaVersion: SCHEMA_VERSION,
    provenance: input.provenance,
    scenario: input.scenario,
    capturedAt: input.capturedAt,
    orcaAppVersion: input.orcaAppVersion,
    notes: input.notes,
    redaction: {
      strippedFields: [...STRIPPED_FIELDS],
      pathPolicy:
        "absolute paths and path-bearing worktreeIds replaced via deterministic per-bundle wt_<n> map shared by worktrees and terminals; pathPlaceholder is index-only",
      handlePolicy:
        "live runtime handles replaced with handlePlaceholder; never restore as command targets from fixtures",
    },
  };
  return {
    meta,
    status: input.status ? redactStatusForFixture(input.status) : undefined,
    worktreePs: {
      ok: input.worktreePs.ok,
      id: "<redacted-envelope-id>",
      result: {
        worktrees,
        totalCount: input.worktreePs.result?.totalCount,
        truncated: input.worktreePs.result?.truncated,
      },
    },
    terminalList: {
      ok: input.terminalList.ok,
      id: "<redacted-envelope-id>",
      result: { terminals },
    },
  };
}

export function assertSafeFixtureJson(serialized: string): void {
  const forbidden = [
    /"prompt"\s*:/,
    /"lastAssistantMessage"\s*:/,
    /"toolInput"\s*:/,
    /"preview"\s*:/,
    /"handle"\s*:\s*"term_/,
    /"path"\s*:\s*"\//,
    /"worktreePath"\s*:\s*"\//,
    /\/Users\//,
    /\/home\//,
  ];
  for (const re of forbidden) {
    if (re.test(serialized)) {
      throw new Error(`Refusing to write fixture: matched forbidden pattern ${re}`);
    }
  }
}
