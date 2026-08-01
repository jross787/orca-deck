/**
 * Versioned, tolerant Orca CLI JSON decoders for Phase 0.
 *
 * Unknown fields are retained on a side channel / ignored by consumers.
 * Unknown agent states map to "unknown" (disabled), never idle.
 * Runtime terminal handles are typed but must never be persisted by callers.
 */

export const SCHEMA_VERSION = "orca-cli-json/1.4.159" as const;

/** Opaque runtime handle — memory only; never write to disk/config/logs as identity. */
export type RuntimeTerminalHandle = string & { readonly __brand: "RuntimeTerminalHandle" };

export type AgentType = "omp" | "claude" | "codex" | "unknown" | (string & {});

export type KnownAgentState =
  | "working"
  | "waiting"
  | "done"
  | "error"
  | "idle"
  | "stuck"
  | "closed"
  | "identity_lost"
  | "unknown";

export type EnvelopeMeta = {
  runtimeId?: string;
  [key: string]: unknown;
};

export type OrcaEnvelope<T> = {
  id?: string;
  ok: boolean;
  result?: T;
  error?: unknown;
  _meta?: EnvelopeMeta;
  [key: string]: unknown;
};

export type OrcaStatusResult = {
  app?: {
    running?: boolean;
    pid?: number;
    desktopWindowStatus?: string;
    [key: string]: unknown;
  };
  runtime?: {
    state?: string;
    reachable?: boolean;
    runtimeId?: string;
    appVersion?: string;
    capabilities?: string[];
    remoteUpdateSupport?: Record<string, unknown>;
    [key: string]: unknown;
  };
  graph?: {
    state?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OrcaAgentRecord = {
  paneKey: string;
  parentPaneKey?: string | null;
  state: string;
  agentType?: string | null;
  /** Content-bearing — must be stripped before fixture/log persistence. */
  prompt?: string | null;
  taskTitle?: string | null;
  displayName?: string | null;
  lastAssistantMessage?: string | null;
  toolName?: string | null;
  toolInput?: unknown;
  interrupted?: boolean;
  stateStartedAt?: number | null;
  updatedAt?: number | null;
  [key: string]: unknown;
};

export type OrcaWorktreeRecord = {
  workspaceKind?: string;
  worktreeId: string;
  repoId?: string;
  projectId?: string;
  projectHostSetupId?: string;
  hostId?: string;
  terminalPlatform?: string;
  repo?: string;
  /** Absolute path — redacted before fixture persistence. */
  path?: string;
  branch?: string;
  isArchived?: boolean;
  isMainWorktree?: boolean;
  worktreeInstanceId?: string;
  displayName?: string;
  workspaceStatus?: string;
  isActive?: boolean;
  unread?: boolean;
  liveTerminalCount?: number;
  hasAttachedPty?: boolean;
  lastOutputAt?: number | null;
  /** Content-bearing preview — never persist. */
  preview?: string | null;
  status?: string;
  agents?: OrcaAgentRecord[];
  [key: string]: unknown;
};

export type OrcaWorktreePsResult = {
  worktrees: OrcaWorktreeRecord[];
  totalCount?: number;
  truncated?: boolean;
  [key: string]: unknown;
};

export type OrcaTerminalRecord = {
  handle: string;
  ptyId?: string;
  incarnationId?: string;
  orphaned?: boolean;
  worktreeId: string;
  worktreePath?: string;
  branch?: string;
  tabId: string;
  leafId: string;
  title?: string | null;
  connected?: boolean;
  writable?: boolean;
  lastOutputAt?: number | null;
  /** Content-bearing — never persist. */
  preview?: string | null;
  [key: string]: unknown;
};

export type OrcaTerminalListResult = {
  terminals: OrcaTerminalRecord[];
  visualLayouts?: unknown[];
  [key: string]: unknown;
};

export type DecodeIssue = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type DecodeResult<T> =
  | { ok: true; value: T; issues: DecodeIssue[]; unknownFieldPaths: string[] }
  | { ok: false; issues: DecodeIssue[]; unknownFieldPaths: string[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

const KNOWN_AGENT_STATES = new Set<string>([
  "working",
  "waiting",
  "done",
  "error",
  "idle",
  "stuck",
  "closed",
  "identity_lost",
  "interrupted",
]);

/**
 * Map raw Orca agent state strings to the internal model.
 * Unknown values become "unknown" (disabled), never "idle".
 */
export function normalizeAgentState(raw: unknown): KnownAgentState {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  const s = raw.toLowerCase();
  if (s === "interrupted") return "error";
  if (KNOWN_AGENT_STATES.has(s) && s !== "interrupted") {
    return s as KnownAgentState;
  }
  return "unknown";
}

export function normalizeAgentType(raw: unknown): AgentType {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  const s = raw.toLowerCase();
  if (s === "omp" || s === "claude" || s === "codex") return s;
  return raw;
}

export function paneKeyFromTerminal(tabId: string, leafId: string): string {
  return `${tabId}:${leafId}`;
}

export function makeLogicalSessionId(worktreeId: string, paneKey: string): string {
  return `${worktreeId}:${paneKey}`;
}

function collectUnknown(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  basePath: string,
  out: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) out.push(basePath ? `${basePath}.${key}` : key);
  }
}

const STATUS_KNOWN = new Set(["app", "runtime", "graph"]);
const RUNTIME_KNOWN = new Set([
  "state",
  "reachable",
  "runtimeId",
  "appVersion",
  "capabilities",
  "remoteUpdateSupport",
]);
const APP_KNOWN = new Set(["running", "pid", "desktopWindowStatus"]);

export function decodeStatusEnvelope(input: unknown): DecodeResult<OrcaEnvelope<OrcaStatusResult>> {
  const issues: DecodeIssue[] = [];
  const unknownFieldPaths: string[] = [];

  if (!isObject(input)) {
    return {
      ok: false,
      issues: [{ path: "", message: "status payload must be an object", severity: "error" }],
      unknownFieldPaths,
    };
  }

  if (typeof input.ok !== "boolean") {
    issues.push({ path: "ok", message: "missing boolean ok", severity: "error" });
  }

  const resultRaw = input.result;
  let result: OrcaStatusResult | undefined;
  if (resultRaw === undefined) {
    if (input.ok === true) {
      issues.push({ path: "result", message: "ok envelope missing result", severity: "error" });
    }
  } else if (!isObject(resultRaw)) {
    issues.push({ path: "result", message: "result must be object", severity: "error" });
  } else {
    collectUnknown(resultRaw, STATUS_KNOWN, "result", unknownFieldPaths);
    const app = isObject(resultRaw.app) ? resultRaw.app : undefined;
    const runtime = isObject(resultRaw.runtime) ? resultRaw.runtime : undefined;
    if (app) collectUnknown(app, APP_KNOWN, "result.app", unknownFieldPaths);
    if (runtime) collectUnknown(runtime, RUNTIME_KNOWN, "result.runtime", unknownFieldPaths);

    const caps = runtime?.capabilities;
    const capabilities = Array.isArray(caps)
      ? caps.filter((c): c is string => typeof c === "string")
      : undefined;

    result = {
      ...resultRaw,
      app: app
        ? {
            ...app,
            running: asBoolean(app.running),
            pid: asNumber(app.pid),
            desktopWindowStatus: asString(app.desktopWindowStatus),
          }
        : undefined,
      runtime: runtime
        ? {
            ...runtime,
            state: asString(runtime.state),
            reachable: asBoolean(runtime.reachable),
            runtimeId: asString(runtime.runtimeId),
            appVersion: asString(runtime.appVersion),
            capabilities,
          }
        : undefined,
      graph: isObject(resultRaw.graph) ? { ...resultRaw.graph, state: asString(resultRaw.graph.state) } : undefined,
    };
  }

  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, issues, unknownFieldPaths };
  }

  return {
    ok: true,
    value: {
      ...input,
      id: asString(input.id),
      ok: Boolean(input.ok),
      result,
      _meta: isObject(input._meta) ? (input._meta as EnvelopeMeta) : undefined,
    },
    issues,
    unknownFieldPaths,
  };
}

const AGENT_KNOWN = new Set([
  "paneKey",
  "parentPaneKey",
  "state",
  "agentType",
  "prompt",
  "taskTitle",
  "displayName",
  "lastAssistantMessage",
  "toolName",
  "toolInput",
  "interrupted",
  "stateStartedAt",
  "updatedAt",
]);

const WORKTREE_KNOWN = new Set([
  "workspaceKind",
  "worktreeId",
  "repoId",
  "projectId",
  "projectHostSetupId",
  "hostId",
  "terminalPlatform",
  "repo",
  "path",
  "branch",
  "isArchived",
  "isMainWorktree",
  "hasHostSidebarActivity",
  "worktreeInstanceId",
  "parentWorktreeId",
  "childWorktreeIds",
  "displayName",
  "workspaceStatus",
  "sortOrder",
  "lastActivityAt",
  "linkedIssue",
  "linkedPR",
  "linkedLinearIssue",
  "linkedGitLabMR",
  "linkedGitLabIssue",
  "comment",
  "isPinned",
  "isActive",
  "unread",
  "liveTerminalCount",
  "hasAttachedPty",
  "lastOutputAt",
  "preview",
  "status",
  "agents",
]);

function decodeAgent(raw: unknown, path: string, issues: DecodeIssue[], unknown: string[]): OrcaAgentRecord | null {
  if (!isObject(raw)) {
    issues.push({ path, message: "agent must be object", severity: "error" });
    return null;
  }
  collectUnknown(raw, AGENT_KNOWN, path, unknown);
  const paneKey = asString(raw.paneKey);
  if (!paneKey) {
    issues.push({ path: `${path}.paneKey`, message: "paneKey required", severity: "error" });
    return null;
  }
  const state = asString(raw.state);
  if (!state) {
    issues.push({ path: `${path}.state`, message: "state required", severity: "error" });
    return null;
  }
  return {
    ...raw,
    paneKey,
    parentPaneKey: (raw.parentPaneKey as string | null | undefined) ?? null,
    state,
    agentType: asString(raw.agentType) ?? null,
    prompt: asString(raw.prompt) ?? null,
    taskTitle: asString(raw.taskTitle) ?? null,
    displayName: asString(raw.displayName) ?? null,
    lastAssistantMessage: asString(raw.lastAssistantMessage) ?? null,
    toolName: asString(raw.toolName) ?? null,
    toolInput: raw.toolInput ?? null,
    interrupted: asBoolean(raw.interrupted),
    stateStartedAt: asNumber(raw.stateStartedAt) ?? null,
    updatedAt: asNumber(raw.updatedAt) ?? null,
  };
}

function decodeWorktree(
  raw: unknown,
  path: string,
  issues: DecodeIssue[],
  unknown: string[],
): OrcaWorktreeRecord | null {
  if (!isObject(raw)) {
    issues.push({ path, message: "worktree must be object", severity: "error" });
    return null;
  }
  collectUnknown(raw, WORKTREE_KNOWN, path, unknown);
  const worktreeId = asString(raw.worktreeId);
  if (!worktreeId) {
    issues.push({ path: `${path}.worktreeId`, message: "worktreeId required", severity: "error" });
    return null;
  }
  const agentsRaw = raw.agents;
  const agents: OrcaAgentRecord[] = [];
  if (agentsRaw !== undefined) {
    if (!Array.isArray(agentsRaw)) {
      issues.push({ path: `${path}.agents`, message: "agents must be array", severity: "error" });
    } else {
      agentsRaw.forEach((a, i) => {
        const decoded = decodeAgent(a, `${path}.agents[${i}]`, issues, unknown);
        if (decoded) agents.push(decoded);
      });
    }
  }
  return {
    ...raw,
    worktreeId,
    workspaceKind: asString(raw.workspaceKind),
    repoId: asString(raw.repoId),
    projectId: asString(raw.projectId),
    projectHostSetupId: asString(raw.projectHostSetupId),
    hostId: asString(raw.hostId),
    terminalPlatform: asString(raw.terminalPlatform),
    repo: asString(raw.repo),
    path: asString(raw.path),
    branch: asString(raw.branch),
    isArchived: asBoolean(raw.isArchived),
    isMainWorktree: asBoolean(raw.isMainWorktree),
    worktreeInstanceId: asString(raw.worktreeInstanceId),
    displayName: asString(raw.displayName),
    workspaceStatus: asString(raw.workspaceStatus),
    isActive: asBoolean(raw.isActive),
    unread: asBoolean(raw.unread),
    liveTerminalCount: asNumber(raw.liveTerminalCount),
    hasAttachedPty: asBoolean(raw.hasAttachedPty),
    lastOutputAt: asNumber(raw.lastOutputAt) ?? null,
    preview: asString(raw.preview) ?? null,
    status: asString(raw.status),
    agents,
  };
}

export function decodeWorktreePsEnvelope(
  input: unknown,
): DecodeResult<OrcaEnvelope<OrcaWorktreePsResult>> {
  const issues: DecodeIssue[] = [];
  const unknownFieldPaths: string[] = [];

  if (!isObject(input)) {
    return {
      ok: false,
      issues: [{ path: "", message: "worktree ps payload must be an object", severity: "error" }],
      unknownFieldPaths,
    };
  }
  if (typeof input.ok !== "boolean") {
    issues.push({ path: "ok", message: "missing boolean ok", severity: "error" });
  }

  let result: OrcaWorktreePsResult | undefined;
  if (input.result === undefined) {
    if (input.ok === true) {
      issues.push({ path: "result", message: "ok envelope missing result", severity: "error" });
    }
  } else if (!isObject(input.result)) {
    issues.push({ path: "result", message: "result must be object", severity: "error" });
  } else {
    const r = input.result;
    collectUnknown(r, new Set(["worktrees", "totalCount", "truncated"]), "result", unknownFieldPaths);
    if (!Array.isArray(r.worktrees)) {
      issues.push({ path: "result.worktrees", message: "worktrees must be array", severity: "error" });
    } else {
      const worktrees: OrcaWorktreeRecord[] = [];
      r.worktrees.forEach((w, i) => {
        const decoded = decodeWorktree(w, `result.worktrees[${i}]`, issues, unknownFieldPaths);
        if (decoded) worktrees.push(decoded);
      });
      result = {
        ...r,
        worktrees,
        totalCount: asNumber(r.totalCount),
        truncated: asBoolean(r.truncated),
      };
    }
  }

  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, issues, unknownFieldPaths };
  }

  return {
    ok: true,
    value: {
      ...input,
      id: asString(input.id),
      ok: Boolean(input.ok),
      result,
      _meta: isObject(input._meta) ? (input._meta as EnvelopeMeta) : undefined,
    },
    issues,
    unknownFieldPaths,
  };
}

const TERMINAL_KNOWN = new Set([
  "handle",
  "ptyId",
  "incarnationId",
  "orphaned",
  "worktreeId",
  "worktreePath",
  "branch",
  "tabId",
  "leafId",
  "title",
  "connected",
  "writable",
  "lastOutputAt",
  "preview",
]);

function decodeTerminal(
  raw: unknown,
  path: string,
  issues: DecodeIssue[],
  unknown: string[],
): OrcaTerminalRecord | null {
  if (!isObject(raw)) {
    issues.push({ path, message: "terminal must be object", severity: "error" });
    return null;
  }
  collectUnknown(raw, TERMINAL_KNOWN, path, unknown);
  const handle = asString(raw.handle);
  const worktreeId = asString(raw.worktreeId);
  const tabId = asString(raw.tabId);
  const leafId = asString(raw.leafId);
  if (!handle) issues.push({ path: `${path}.handle`, message: "handle required", severity: "error" });
  if (!worktreeId)
    issues.push({ path: `${path}.worktreeId`, message: "worktreeId required", severity: "error" });
  if (!tabId) issues.push({ path: `${path}.tabId`, message: "tabId required", severity: "error" });
  if (!leafId) issues.push({ path: `${path}.leafId`, message: "leafId required", severity: "error" });
  if (!handle || !worktreeId || !tabId || !leafId) return null;

  return {
    ...raw,
    handle,
    ptyId: asString(raw.ptyId),
    incarnationId: asString(raw.incarnationId),
    orphaned: asBoolean(raw.orphaned),
    worktreeId,
    worktreePath: asString(raw.worktreePath),
    branch: asString(raw.branch),
    tabId,
    leafId,
    title: asString(raw.title) ?? null,
    connected: asBoolean(raw.connected),
    writable: asBoolean(raw.writable),
    lastOutputAt: asNumber(raw.lastOutputAt) ?? null,
    preview: asString(raw.preview) ?? null,
  };
}

export function decodeTerminalListEnvelope(
  input: unknown,
): DecodeResult<OrcaEnvelope<OrcaTerminalListResult>> {
  const issues: DecodeIssue[] = [];
  const unknownFieldPaths: string[] = [];

  if (!isObject(input)) {
    return {
      ok: false,
      issues: [{ path: "", message: "terminal list payload must be an object", severity: "error" }],
      unknownFieldPaths,
    };
  }
  if (typeof input.ok !== "boolean") {
    issues.push({ path: "ok", message: "missing boolean ok", severity: "error" });
  }

  let result: OrcaTerminalListResult | undefined;
  if (input.result === undefined) {
    if (input.ok === true) {
      issues.push({ path: "result", message: "ok envelope missing result", severity: "error" });
    }
  } else if (!isObject(input.result)) {
    issues.push({ path: "result", message: "result must be object", severity: "error" });
  } else {
    const r = input.result;
    collectUnknown(r, new Set(["terminals", "visualLayouts"]), "result", unknownFieldPaths);
    if (!Array.isArray(r.terminals)) {
      issues.push({ path: "result.terminals", message: "terminals must be array", severity: "error" });
    } else {
      const terminals: OrcaTerminalRecord[] = [];
      r.terminals.forEach((t, i) => {
        const decoded = decodeTerminal(t, `result.terminals[${i}]`, issues, unknownFieldPaths);
        if (decoded) terminals.push(decoded);
      });
      result = {
        ...r,
        terminals,
        visualLayouts: Array.isArray(r.visualLayouts) ? r.visualLayouts : undefined,
      };
    }
  }

  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, issues, unknownFieldPaths };
  }

  return {
    ok: true,
    value: {
      ...input,
      id: asString(input.id),
      ok: Boolean(input.ok),
      result,
      _meta: isObject(input._meta) ? (input._meta as EnvelopeMeta) : undefined,
    },
    issues,
    unknownFieldPaths,
  };
}

/** Redacted agent record safe for fixtures/logs. */
export type RedactedAgentRecord = {
  paneKey: string;
  parentPaneKey?: string | null;
  state: string;
  agentType?: string | null;
  toolName?: string | null;
  interrupted?: boolean;
  stateStartedAt?: number | null;
  updatedAt?: number | null;
  hasPrompt?: boolean;
  hasToolInput?: boolean;
};

export type RedactedWorktreeRecord = {
  workspaceKind?: string;
  worktreeId: string;
  repoId?: string;
  projectId?: string;
  projectHostSetupId?: string;
  hostId?: string;
  terminalPlatform?: string;
  repo?: string;
  pathPlaceholder?: string;
  branch?: string;
  isArchived?: boolean;
  isMainWorktree?: boolean;
  worktreeInstanceId?: string;
  displayName?: string;
  workspaceStatus?: string;
  isActive?: boolean;
  unread?: boolean;
  liveTerminalCount?: number;
  hasAttachedPty?: boolean;
  lastOutputAt?: number | null;
  status?: string;
  agents: RedactedAgentRecord[];
};

export type RedactedTerminalRecord = {
  /** Opaque placeholder — not a live handle. */
  handlePlaceholder: string;
  incarnationId?: string;
  orphaned?: boolean;
  worktreeId: string;
  tabId: string;
  leafId: string;
  connected?: boolean;
  writable?: boolean;
  lastOutputAt?: number | null;
  hasTitle?: boolean;
};

export type FixtureProvenance = "observed" | "synthetic";

export type FixtureMeta = {
  schemaVersion: typeof SCHEMA_VERSION;
  provenance: FixtureProvenance;
  scenario: string;
  capturedAt?: string;
  orcaAppVersion?: string;
  notes?: string[];
  redaction: {
    strippedFields: string[];
    pathPolicy: string;
    handlePolicy: string;
  };
};

export type RedactedFixtureBundle = {
  meta: FixtureMeta;
  status?: OrcaEnvelope<OrcaStatusResult>;
  worktreePs: OrcaEnvelope<{ worktrees: RedactedWorktreeRecord[]; totalCount?: number; truncated?: boolean }>;
  terminalList: OrcaEnvelope<{ terminals: RedactedTerminalRecord[] }>;
};
