/**
 * Tolerant extraction of public model / effort / context fields from Orca agent records.
 * Only reads known public field names; never scrapes private DB/UI.
 * Missing/unknown → null (caller renders UNAVAILABLE).
 */

import type { LogicalSession } from "../orca/discovery.js";
import type { OrcaAgentRecord } from "../orca/schema.js";
import type { PublicModelFields } from "./types.js";

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function readContextBag(
  raw: Record<string, unknown>,
): Pick<PublicModelFields, "contextTokens" | "contextWindow" | "contextPercent"> {
  let contextTokens: number | null = null;
  let contextWindow: number | null = null;
  let contextPercent: number | null = null;

  const nested = raw.contextUsage;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const cu = nested as Record<string, unknown>;
    contextTokens = asFiniteNumber(cu.tokens) ?? asFiniteNumber(cu.contextTokens) ?? null;
    contextWindow =
      asFiniteNumber(cu.contextWindow) ?? asFiniteNumber(cu.window) ?? asFiniteNumber(cu.limit) ?? null;
    contextPercent =
      asFiniteNumber(cu.percent) ?? asFiniteNumber(cu.contextPercent) ?? asFiniteNumber(cu.pct) ?? null;
  }

  contextTokens =
    contextTokens ??
    asFiniteNumber(raw.contextTokens) ??
    asFiniteNumber(raw.tokens) ??
    null;
  contextWindow =
    contextWindow ??
    asFiniteNumber(raw.contextWindow) ??
    asFiniteNumber(raw.contextLimit) ??
    null;
  contextPercent =
    contextPercent ??
    asFiniteNumber(raw.contextPercent) ??
    asFiniteNumber(raw.contextPct) ??
    null;

  // Derive percent only when both sides are real public numbers.
  if (
    contextPercent == null &&
    contextTokens != null &&
    contextWindow != null &&
    contextWindow > 0
  ) {
    contextPercent = Math.round((contextTokens / contextWindow) * 1000) / 10;
  }

  return { contextTokens, contextWindow, contextPercent };
}

/**
 * Extract display-only model/effort/context from a public agent-shaped record.
 * Accepts OrcaAgentRecord or any plain object (session overlays).
 */
export function extractPublicModelFields(raw: unknown): PublicModelFields {
  const empty: PublicModelFields = {
    model: null,
    effort: null,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    anyPresent: false,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;

  const model =
    asNonEmptyString(obj.model) ??
    asNonEmptyString(obj.modelId) ??
    asNonEmptyString(obj.modelName) ??
    asNonEmptyString(obj.model_id) ??
    null;

  const effort =
    asNonEmptyString(obj.effort) ??
    asNonEmptyString(obj.reasoningEffort) ??
    asNonEmptyString(obj.thinkingLevel) ??
    asNonEmptyString(obj.thinking) ??
    asNonEmptyString(obj.reasoning_effort) ??
    null;

  const ctx = readContextBag(obj);
  const anyPresent = Boolean(
    model ||
      effort ||
      ctx.contextTokens != null ||
      ctx.contextWindow != null ||
      ctx.contextPercent != null,
  );

  return {
    model,
    effort,
    contextTokens: ctx.contextTokens,
    contextWindow: ctx.contextWindow,
    contextPercent: ctx.contextPercent,
    anyPresent,
  };
}

/** Session may carry optional public model fields via discovery overlay. */
export function extractSessionModelFields(
  session: LogicalSession | null | undefined,
): PublicModelFields {
  if (!session) {
    return {
      model: null,
      effort: null,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      anyPresent: false,
    };
  }
  // Prefer explicit overlay fields when discovery copied them.
  const fromSession = extractPublicModelFields({
    model: session.model,
    effort: session.effort,
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow,
    contextPercent: session.contextPercent,
    contextUsage: session.contextUsage,
  });
  if (fromSession.anyPresent) return fromSession;
  return extractPublicModelFields(session);
}

export function formatContextSecondary(fields: PublicModelFields): string | null {
  if (fields.contextPercent != null) {
    const pct =
      fields.contextPercent % 1 === 0
        ? String(fields.contextPercent)
        : fields.contextPercent.toFixed(1);
    return `ctx ${pct}%`;
  }
  if (fields.contextTokens != null && fields.contextWindow != null) {
    return `ctx ${fields.contextTokens}/${fields.contextWindow}`;
  }
  if (fields.contextTokens != null) return `ctx ${fields.contextTokens} tok`;
  return null;
}

export function formatModelEffortPrimary(fields: PublicModelFields): string {
  if (fields.model && fields.effort) return `${fields.model} · ${fields.effort}`;
  if (fields.model) return fields.model;
  if (fields.effort) return `effort ${fields.effort}`;
  return "UNAVAILABLE";
}

/** Count active (non-child) OMP sessions from a live set. */
export function countActiveOmp(sessions: readonly LogicalSession[]): number {
  let n = 0;
  for (const s of sessions) {
    if (s.agentType === "omp") n += 1;
  }
  return n;
}

/** Type guard helper for tests — agent record passthrough. */
export function extractAgentModelFields(agent: OrcaAgentRecord): PublicModelFields {
  return extractPublicModelFields(agent);
}
