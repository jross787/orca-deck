/**
 * Redacted diagnostics export for the property inspector.
 * Metadata / health / config provenance only — never prompts, presets bodies,
 * draft text, terminal content, handles, filesystem paths, or secrets.
 */

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
    detail: string;
    checkedAt: string;
    schemaVersion: string;
    orcaAppVersion?: string;
    runtimeId?: string;
    runtimeState?: string;
    checks: Array<{ id: string; ok: boolean | null; detail: string }>;
    blockers?: Array<{ id: string; severity: string; message: string }>;
  };
  dashboard?: {
    orcaReady: boolean;
    capturedAtMs: number;
    cardCount: number;
    overflowCount: number;
    selectedLogicalSessionId: string | null;
    urgency: string;
    issues: string[];
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
]);

export function assertSafeDiagnostics(value: unknown, path = ""): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeDiagnostics(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_DIAG_KEYS.has(k)) {
        throw new Error(`diagnostics contains forbidden key: ${path}.${k}`);
      }
      if (/prompt|draft|stdout|stderr|toolinput|preview|handle|secret|password|apiKey/i.test(k)) {
        throw new Error(`diagnostics contains content-bearing key: ${path}.${k}`);
      }
      // Reject absolute filesystem paths as string values.
      if (
        typeof v === "string" &&
        (v.startsWith("/Users/") ||
          v.startsWith("/home/") ||
          v.includes("Library/Application Support"))
      ) {
        throw new Error(`diagnostics leaked filesystem path at ${path}.${k}`);
      }
      assertSafeDiagnostics(v, path ? `${path}.${k}` : k);
    }
  }
}

function configErrorClass(err: string | undefined): string | undefined {
  if (!err) return undefined;
  if (/ENOENT/i.test(err)) return "missing_file";
  if (/valid/i.test(err)) return "validation_failed";
  if (/parse|JSON/i.test(err)) return "parse_failed";
  return "config_error";
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
      detail: h.detail,
      checkedAt: h.checkedAt,
      schemaVersion: h.schemaVersion,
      orcaAppVersion: h.orcaAppVersion,
      runtimeId: h.runtimeId,
      runtimeState: h.runtimeState,
      checks: h.checks.map((c) => ({
        id: c.id,
        ok: c.ok,
        detail: c.detail,
      })),
      blockers: h.capability?.blockers?.map((b) => ({
        id: b.id,
        severity: b.severity,
        message: b.message,
      })),
    };
  }

  if (input.dashboard) {
    const d = input.dashboard;
    exp.dashboard = {
      orcaReady: d.orcaReady,
      capturedAtMs: d.capturedAtMs,
      cardCount: d.cards.length,
      overflowCount: d.control.overflowCount,
      selectedLogicalSessionId: d.selectedLogicalSessionId,
      urgency: d.control.urgency,
      issues: [...d.control.issues],
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
