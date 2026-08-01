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

export function redactWorktree(wt: OrcaWorktreeRecord, index: number): RedactedWorktreeRecord {
  const repoHint = wt.worktreeId.includes("::") ? wt.worktreeId.split("::")[0] : wt.worktreeId;
  return {
    workspaceKind: wt.workspaceKind,
    worktreeId: wt.worktreeId,
    repoId: wt.repoId,
    hostId: wt.hostId,
    terminalPlatform: wt.terminalPlatform,
    repo: wt.repo,
    pathPlaceholder: `<redacted-path:${repoHint ?? "wt"}#${index}>`,
    branch: wt.branch && wt.branch.length > 0 ? wt.branch : undefined,
    isArchived: wt.isArchived,
    isMainWorktree: wt.isMainWorktree,
    worktreeInstanceId: wt.worktreeInstanceId,
    displayName: wt.displayName,
    workspaceStatus: wt.workspaceStatus,
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

export function redactTerminal(term: OrcaTerminalRecord, index: number): RedactedTerminalRecord {
  return {
    handlePlaceholder: `<redacted-handle:${index}>`,
    incarnationId: term.incarnationId,
    orphaned: term.orphaned,
    worktreeId: term.worktreeId,
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
  const worktrees = (input.worktreePs.result?.worktrees ?? []).map((wt, i) => redactWorktree(wt, i));
  const terminals = (input.terminalList.result?.terminals ?? []).map((t, i) => redactTerminal(t, i));
  const meta: FixtureMeta = {
    schemaVersion: SCHEMA_VERSION,
    provenance: input.provenance,
    scenario: input.scenario,
    capturedAt: input.capturedAt,
    orcaAppVersion: input.orcaAppVersion,
    notes: input.notes,
    redaction: {
      strippedFields: [...STRIPPED_FIELDS],
      pathPolicy: "absolute paths replaced with pathPlaceholder derived from worktreeId",
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
