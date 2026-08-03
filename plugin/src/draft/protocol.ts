/**
 * Private versioned NDJSON protocol shared with the Swift overlay helper.
 * Fail closed on malformed/unknown/oversized messages. Never log draft bodies.
 */

export const OVERLAY_PROTOCOL_VERSION = 1 as const;

export const OVERLAY_LIMITS = {
  maxLineBytes: 256 * 1024,
  maxDraftCharacters: 32_768,
  maxWorktreeNameCharacters: 64,
  maxLabelCharacters: 256,
  maxRequestIdCharacters: 128,
} as const;

export type DraftUiState = "empty" | "editing" | "ready" | "submitting";
export type LaunchProvider = "omp" | "claude" | "codex";
export type MutationOutcomeKind = "success" | "failed" | "ambiguous";

export type OverlayContextPayload = {
  repoLabel?: string;
  worktreeLabel?: string;
  hostLabel?: string;
  agentLabel?: string;
  superwhisperMode?: string;
};

export type PluginToHelperMessage =
  | { version: 1; type: "context"; requestId: string; context: OverlayContextPayload }
  | { version: 1; type: "focus"; requestId: string }
  | {
      version: 1;
      type: "outcome";
      requestId: string;
      kind: MutationOutcomeKind;
      code?: string;
      message?: string;
    };

export type HelperToPluginMessage =
  | {
      version: 1;
      type: "state";
      requestId: string;
      ui: DraftUiState;
      draftCharacters: number;
      draftBytes: number;
    }
  | { version: 1; type: "sendSelected"; requestId: string; draft: string }
  | {
      version: 1;
      type: "launchAgent";
      requestId: string;
      provider: LaunchProvider;
      draft: string;
      worktreeName: string;
    }
  | { version: 1; type: "cancelled"; requestId: string }
  | { version: 1; type: "exited"; requestId: string };

export type ProtocolDecodeIssue =
  | "empty_line"
  | "line_too_long"
  | "malformed_json"
  | "unsupported_version"
  | "unknown_type"
  | "invalid_field";

export type ProtocolDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: ProtocolDecodeIssue; detail?: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function requireRequestId(v: unknown): string | null {
  const s = asString(v);
  if (!s || s.length === 0 || s.length > OVERLAY_LIMITS.maxRequestIdCharacters) return null;
  if (s.includes("\n") || s.includes("\0")) return null;
  return s;
}

function requireDraft(v: unknown): string | null {
  const s = asString(v);
  if (!s || s.length === 0 || s.length > OVERLAY_LIMITS.maxDraftCharacters) return null;
  return s;
}

function requireName(v: unknown): string | null {
  const s = asString(v);
  if (!s || s.length === 0 || s.length > OVERLAY_LIMITS.maxWorktreeNameCharacters) return null;
  if (s.includes("\n") || s.includes("\0")) return null;
  return s;
}

function requireLabel(v: unknown): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  const s = asString(v);
  if (s === undefined) return null;
  if (s.length > OVERLAY_LIMITS.maxLabelCharacters) return null;
  if (s.includes("\n") || s.includes("\0")) return null;
  return s;
}

function sanitizeLine(line: string): ProtocolDecodeResult<string> {
  let s = line;
  if (s.endsWith("\n")) s = s.slice(0, -1);
  if (s.endsWith("\r")) s = s.slice(0, -1);
  if (s.length === 0) return { ok: false, issue: "empty_line" };
  if (Buffer.byteLength(s, "utf8") > OVERLAY_LIMITS.maxLineBytes) {
    return { ok: false, issue: "line_too_long" };
  }
  return { ok: true, value: s };
}

export function encodePluginMessage(message: PluginToHelperMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function encodeHelperMessage(message: HelperToPluginMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeHelperMessage(line: string): ProtocolDecodeResult<HelperToPluginMessage> {
  const cleaned = sanitizeLine(line);
  if (!cleaned.ok) return cleaned;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.value);
  } catch {
    return { ok: false, issue: "malformed_json" };
  }
  if (!isObject(raw)) return { ok: false, issue: "malformed_json" };
  const version = asInt(raw.version);
  if (version !== OVERLAY_PROTOCOL_VERSION) {
    return { ok: false, issue: "unsupported_version", detail: String(version) };
  }
  const type = asString(raw.type);
  const requestId = requireRequestId(raw.requestId);
  if (!requestId) return { ok: false, issue: "invalid_field", detail: "requestId" };
  switch (type) {
    case "state": {
      const ui = asString(raw.ui);
      if (ui !== "empty" && ui !== "editing" && ui !== "ready" && ui !== "submitting") {
        return { ok: false, issue: "invalid_field", detail: "ui" };
      }
      const draftCharacters = asInt(raw.draftCharacters);
      const draftBytes = asInt(raw.draftBytes);
      if (
        draftCharacters == null ||
        draftBytes == null ||
        draftCharacters < 0 ||
        draftBytes < 0 ||
        draftCharacters > OVERLAY_LIMITS.maxDraftCharacters
      ) {
        return { ok: false, issue: "invalid_field", detail: "counts" };
      }
      return {
        ok: true,
        value: { version: 1, type: "state", requestId, ui, draftCharacters, draftBytes },
      };
    }
    case "sendSelected": {
      const draft = requireDraft(raw.draft);
      if (!draft) return { ok: false, issue: "invalid_field", detail: "draft" };
      return { ok: true, value: { version: 1, type: "sendSelected", requestId, draft } };
    }
    case "launchAgent": {
      const provider = asString(raw.provider);
      if (provider !== "omp" && provider !== "claude" && provider !== "codex") {
        return { ok: false, issue: "invalid_field", detail: "provider" };
      }
      const draft = requireDraft(raw.draft);
      const worktreeName = requireName(raw.worktreeName);
      if (!draft) return { ok: false, issue: "invalid_field", detail: "draft" };
      if (!worktreeName) return { ok: false, issue: "invalid_field", detail: "worktreeName" };
      return {
        ok: true,
        value: { version: 1, type: "launchAgent", requestId, provider, draft, worktreeName },
      };
    }
    case "cancelled":
      return { ok: true, value: { version: 1, type: "cancelled", requestId } };
    case "exited":
      return { ok: true, value: { version: 1, type: "exited", requestId } };
    default:
      return { ok: false, issue: "unknown_type", detail: type ?? "missing" };
  }
}

export function decodePluginMessage(line: string): ProtocolDecodeResult<PluginToHelperMessage> {
  const cleaned = sanitizeLine(line);
  if (!cleaned.ok) return cleaned;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.value);
  } catch {
    return { ok: false, issue: "malformed_json" };
  }
  if (!isObject(raw)) return { ok: false, issue: "malformed_json" };
  const version = asInt(raw.version);
  if (version !== OVERLAY_PROTOCOL_VERSION) {
    return { ok: false, issue: "unsupported_version", detail: String(version) };
  }
  const type = asString(raw.type);
  const requestId = requireRequestId(raw.requestId);
  if (!requestId) return { ok: false, issue: "invalid_field", detail: "requestId" };
  switch (type) {
    case "context": {
      if (!isObject(raw.context)) return { ok: false, issue: "invalid_field", detail: "context" };
      const repoLabel = requireLabel(raw.context.repoLabel);
      const worktreeLabel = requireLabel(raw.context.worktreeLabel);
      const hostLabel = requireLabel(raw.context.hostLabel);
      const agentLabel = requireLabel(raw.context.agentLabel);
      const superwhisperMode = requireLabel(raw.context.superwhisperMode);
      if (
        repoLabel === null ||
        worktreeLabel === null ||
        hostLabel === null ||
        agentLabel === null ||
        superwhisperMode === null
      ) {
        return { ok: false, issue: "invalid_field", detail: "context" };
      }
      return {
        ok: true,
        value: {
          version: 1,
          type: "context",
          requestId,
          context: { repoLabel, worktreeLabel, hostLabel, agentLabel, superwhisperMode },
        },
      };
    }
    case "focus":
      return { ok: true, value: { version: 1, type: "focus", requestId } };
    case "outcome": {
      const kind = asString(raw.kind);
      if (kind !== "success" && kind !== "failed" && kind !== "ambiguous") {
        return { ok: false, issue: "invalid_field", detail: "kind" };
      }
      const code = asString(raw.code);
      const message = asString(raw.message);
      if (code && code.length > 64) return { ok: false, issue: "invalid_field", detail: "code" };
      if (message && message.length > 256) return { ok: false, issue: "invalid_field", detail: "message" };
      return {
        ok: true,
        value: {
          version: 1,
          type: "outcome",
          requestId,
          kind,
          code: code || undefined,
          message: message || undefined,
        },
      };
    }
    default:
      return { ok: false, issue: "unknown_type", detail: type ?? "missing" };
  }
}

/** Metadata-only projection of helper state — never includes draft text. */
export type DraftFaceState = {
  open: boolean;
  ui: DraftUiState;
  draftCharacters: number;
  draftBytes: number;
  pendingRequestId: string | null;
  ambiguous: boolean;
  lastCode?: string;
};

export function emptyDraftFaceState(): DraftFaceState {
  return {
    open: false,
    ui: "empty",
    draftCharacters: 0,
    draftBytes: 0,
    pendingRequestId: null,
    ambiguous: false,
  };
}
