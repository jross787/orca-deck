/**
 * Redacted diagnostics export for the property inspector.
 * Metadata / health / config provenance only — never prompts, presets bodies,
 * draft text, terminal content, handles, filesystem paths, or secrets.
 */

import { createHash } from "node:crypto";
import type { DeckConfig } from "../config/store.js";
import type { HealthSnapshot } from "../health/check.js";
import type { DashboardSnapshot } from "../state/types.js";
import type { UsageSnapshot } from "./types.js";

export type DiagnosticsExport = {
  exportedAt: string;
  schemaVersion: string;
  plugin: {
    configSchemaVersion: number;
    configSource: string;
    configHasError: boolean;
    /** Error code/class only — never raw file contents. */
    configErrorClass?: string;
  };
  health?: {
    state: string;
    /** Safe reason code — never free-form CLI/err text. */
    detailCode: string;
    checkedAt: string;
    schemaVersion: string;
    orcaAppVersion?: string;
    runtimeId?: string;
    runtimeState?: string;
    checks: Array<{ id: string; ok: boolean | null; detailCode: string }>;
    blockers?: Array<{ id: string; severity: string; messageCode: string }>;
  };
  dashboard?: {
    orcaReady: boolean;
    capturedAtMs: number;
    cardCount: number;
    overflowCount: number;
    /** Non-reversible opaque token when a session is selected; never raw logical id. */
    selectedSessionToken: string | null;
    urgency: string;
    issueCodes: string[];
    agentTypeCounts: Record<string, number>;
  };
  usage?: {
    evaluatedAtMs: number;
    staleAfterMs: number;
    topologyReliable: boolean;
    faces: Array<{
      kind: string;
      freshness: string;
      primary: string;
      metricKind: string;
      provenance: string;
      sourceObservedAtMs: number | null;
    }>;
  };
  configFlags?: {
    paletteEnabled: boolean;
    soundEnabled: boolean;
    holdToCloseMs: number;
    cliTimeoutMs: number;
    stuckThresholdMinutes: number;
    polling: DeckConfig["polling"];
    /** Preset slot counts only — never preset text bodies. */
    presetSlotCounts: Record<string, number>;
    hasOrcaExecutableOverride: boolean;
    hasSuperwhisper: boolean;
    remoteHostFilterCount: number;
  };
};

const FORBIDDEN_DIAG_KEYS = new Set([
  "prompt",
  "toolInput",
  "preview",
  "path",
  "handle",
  "runtimeHandle",
  "draft",
  "text",
  "presets",
  "presetText",
  "stdout",
  "stderr",
  "args",
  "argv",
  "svg",
  "image",
  "payload",
  "body",
  "secret",
  "token",
  "password",
  "apiKey",
  "configPath",
  "logPath",
  "statePath",
  "supportDir",
  "home",
  "selectedLogicalSessionId",
  "logicalSessionId",
  "detail",
  "message",
]);

/** Absolute user-home paths embedded anywhere in a string (macOS/Linux). */
const EMBEDDED_USER_PATH =
  /(?:^|[\s"'`:=,(\[{])(?:\/Users\/|\/home\/)[^\s"'`)\]},;]*/i;

const APP_SUPPORT_PATH = /Library\/Application Support/i;

/**
 * True when a string embeds a macOS/Linux absolute user path or App Support path.
 * Does not log or echo the value.
 */
export function stringEmbedsFilesystemPath(value: string): boolean {
  if (APP_SUPPORT_PATH.test(value)) return true;
  if (EMBEDDED_USER_PATH.test(value)) return true;
  // Bare absolute user roots (value is exactly/starts with path).
  if (value.startsWith("/Users/") || value.startsWith("/home/")) return true;
  // Mid-string without whitespace delimiter (logical ids: repo::/Users/...:tab:leaf).
  if (value.includes("/Users/") || value.includes("/home/")) return true;
  return false;
}

export function assertSafeDiagnostics(value: unknown, path = ""): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeDiagnostics(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_DIAG_KEYS.has(k)) {
        throw new Error(`diagnostics contains forbidden key at ${path || "<root>"}`);
      }
      if (/prompt|draft|stdout|stderr|toolinput|preview|handle|secret|password|apiKey|logicalSessionId/i.test(k)) {
        throw new Error(`diagnostics contains content-bearing key at ${path || "<root>"}`);
      }
      if (typeof v === "string" && stringEmbedsFilesystemPath(v)) {
        throw new Error(`diagnostics leaked filesystem path at ${path || "<root>"}.${k}`);
      }
      assertSafeDiagnostics(v, path ? `${path}.${k}` : k);
    }
    return;
  }
  if (typeof value === "string" && stringEmbedsFilesystemPath(value)) {
    throw new Error(`diagnostics leaked filesystem path at ${path || "<root>"}`);
  }
}

function configErrorClass(err: string | undefined): string | undefined {
  if (!err) return undefined;
  if (/ENOENT/i.test(err)) return "missing_file";
  if (/valid/i.test(err)) return "validation_failed";
  if (/parse|JSON/i.test(err)) return "parse_failed";
  return "config_error";
}

/**
 * Map free-form health/CLI text to a short reason code.
 * Never returns the original string (may contain paths).
 */
export function sanitizeDetailCode(raw: string | undefined | null): string {
  if (raw == null || raw.length === 0) return "none";
  // Prefer spawn classification when both spawn + ENOENT appear (common CLI path errors).
  if (/spawn/i.test(raw)) return "spawn_failed";
  if (/ENOENT|not found|no such file/i.test(raw)) return "not_found";
  if (/EACCES|permission/i.test(raw)) return "permission_denied";
  if (/timeout|ETIMEDOUT/i.test(raw)) return "timeout";
  if (/invalid json|JSON/i.test(raw)) return "invalid_json";
  if (/incompatible/i.test(raw)) return "incompatible";
  if (/unavailable|not ready|unreachable/i.test(raw)) return "unavailable";
  if (/ready|ok\b/i.test(raw) && raw.length < 80) return "ok";
  if (/missing/i.test(raw)) return "missing";
  if (/blocked/i.test(raw)) return "blocked";
  return "error";
}
/** Non-reversible stable opaque token for a logical session id. */
export function opaqueSessionToken(logicalSessionId: string): string {
  return createHash("sha256").update(logicalSessionId, "utf8").digest("hex").slice(0, 16);
}

function sanitizeIssueCode(issue: string): string {
  // Prefer the prefix before the first path-ish segment.
  const head = issue.split(/[/:]/)[0] ?? "issue";
  if (/^[a-z0-9_.-]+$/i.test(head) && head.length <= 64) return head;
  return sanitizeDetailCode(issue);
}

export function buildDiagnosticsExport(input: {
  config: DeckConfig;
  configSource: string;
  configLastError?: string;
  health?: HealthSnapshot | null;
  dashboard?: DashboardSnapshot | null;
  usage?: UsageSnapshot | null;
  now?: () => Date;
}): DiagnosticsExport {
  const now = input.now?.() ?? new Date();
  const cfg = input.config;

  const agentTypeCounts: Record<string, number> = {};
  if (input.dashboard) {
    for (const c of input.dashboard.cards) {
      const t = String(c.agentType || "unknown");
      agentTypeCounts[t] = (agentTypeCounts[t] ?? 0) + 1;
    }
  }

  const presetSlotCounts: Record<string, number> = {};
  for (const [k, set] of Object.entries(cfg.presets)) {
    presetSlotCounts[k] = Array.isArray(set) ? set.length : 0;
  }

  const exp: DiagnosticsExport = {
    exportedAt: now.toISOString(),
    schemaVersion: "orca-agent-deck-diagnostics/1",
    plugin: {
      configSchemaVersion: cfg.schemaVersion,
      configSource: input.configSource,
      configHasError: Boolean(input.configLastError),
      configErrorClass: configErrorClass(input.configLastError),
    },
    configFlags: {
      paletteEnabled: cfg.paletteEnabled,
      soundEnabled: cfg.soundEnabled,
      holdToCloseMs: cfg.holdToCloseMs,
      cliTimeoutMs: cfg.cliTimeoutMs,
      stuckThresholdMinutes: cfg.stuckThresholdMinutes,
      polling: { ...cfg.polling },
      presetSlotCounts,
      hasOrcaExecutableOverride: Boolean(cfg.orcaExecutable),
      hasSuperwhisper: Boolean(cfg.superwhisper),
      remoteHostFilterCount: cfg.remoteHostFilters?.length ?? 0,
    },
  };

  if (input.health) {
    const h = input.health;
    exp.health = {
      state: h.state,
      detailCode: sanitizeDetailCode(h.detail),
      checkedAt: h.checkedAt,
      schemaVersion: h.schemaVersion,
      orcaAppVersion: h.orcaAppVersion,
      runtimeId: h.runtimeId,
      runtimeState: h.runtimeState,
      checks: h.checks.map((c) => ({
        id: c.id,
        ok: c.ok,
        detailCode: sanitizeDetailCode(c.detail),
      })),
      blockers: h.capability?.blockers?.map((b) => ({
        id: b.id,
        severity: b.severity,
        messageCode: sanitizeDetailCode(b.message),
      })),
    };
  }

  if (input.dashboard) {
    const d = input.dashboard;
    const selected = d.selectedLogicalSessionId;
    exp.dashboard = {
      orcaReady: d.orcaReady,
      capturedAtMs: d.capturedAtMs,
      cardCount: d.cards.length,
      overflowCount: d.control.overflowCount,
      selectedSessionToken: selected ? opaqueSessionToken(selected) : null,
      urgency: d.control.urgency,
      issueCodes: d.control.issues.map(sanitizeIssueCode),
      agentTypeCounts,
    };
  }

  if (input.usage) {
    const u = input.usage;
    exp.usage = {
      evaluatedAtMs: u.evaluatedAtMs,
      staleAfterMs: u.staleAfterMs,
      topologyReliable: u.topologyReliable,
      faces: (Object.keys(u.faces) as Array<keyof typeof u.faces>).map((k) => {
        const f = u.faces[k];
        return {
          kind: f.kind,
          freshness: f.freshness,
          primary: f.primary,
          metricKind: f.metricKind,
          provenance: f.provenance,
          sourceObservedAtMs: f.sourceObservedAtMs,
        };
      }),
    };
  }

  assertSafeDiagnostics(exp);
  return exp;
}
