/**
 * Build the four usage/model faces from one shared dashboard discovery tick.
 * No per-key CLI polls. Fail closed on missing/stale/unreliable topology.
 */

import type { LogicalSession } from "../orca/discovery.js";
import {
  countActiveOmp,
  extractSessionModelFields,
  formatContextSecondary,
  formatModelEffortPrimary,
} from "./extract.js";
import { unavailableProviderUsageAdapter } from "./providers.js";
import type {
  ProviderUsageAdapter,
  UsageFaceKind,
  UsageFaceView,
  UsageFreshness,
  UsageSnapshot,
} from "./types.js";

export const DEFAULT_USAGE_STALE_AFTER_MS = 10_000;

export type BuildUsageSnapshotInput = {
  sessions: readonly LogicalSession[];
  selectedLogicalSessionId: string | null;
  orcaReady: boolean;
  topologyReliable: boolean;
  /** Real discovery capture time; null when topology unreliable / never observed. */
  discoveryCapturedAtMs: number | null;
  evaluatedAtMs: number;
  staleAfterMs?: number;
  providerUsage?: ProviderUsageAdapter;
};

function freshnessFor(
  sourceObservedAtMs: number | null,
  evaluatedAtMs: number,
  staleAfterMs: number,
  opts: { forceUnavailable?: boolean },
): UsageFreshness {
  if (opts.forceUnavailable || sourceObservedAtMs == null) return "unavailable";
  if (evaluatedAtMs - sourceObservedAtMs > staleAfterMs) return "stale";
  return "fresh";
}

function face(
  partial: Omit<UsageFaceView, "evaluatedAtMs" | "staleAfterMs"> & {
    evaluatedAtMs: number;
    staleAfterMs: number;
  },
): UsageFaceView {
  return partial;
}

function providerFace(
  kind: "claude" | "codex",
  title: string,
  adapter: ProviderUsageAdapter,
  evaluatedAtMs: number,
  staleAfterMs: number,
): UsageFaceView {
  const result = adapter({ provider: kind, evaluatedAtMs });
  // Adapter may be async in the type, but default is sync; normalize.
  if (result instanceof Promise) {
    // Synchronous snapshot path must not block on promises — treat as unavailable.
    return face({
      kind,
      freshness: "unavailable",
      title,
      primary: "UNAVAILABLE",
      secondary: "async adapter",
      sourceLabel: "public Orca CLI",
      sourceObservedAtMs: null,
      evaluatedAtMs,
      staleAfterMs,
      metricKind: "unavailable",
      provenance: "async_provider_adapter_unsupported",
    });
  }
  if (!result.available) {
    return face({
      kind,
      freshness: "unavailable",
      title,
      primary: "UNAVAILABLE",
      secondary: result.reason,
      sourceLabel: result.sourceLabel,
      sourceObservedAtMs: null,
      evaluatedAtMs,
      staleAfterMs,
      metricKind: "unavailable",
      provenance: result.provenance,
    });
  }
  const fr = freshnessFor(result.sourceObservedAtMs, evaluatedAtMs, staleAfterMs, {});
  return face({
    kind,
    freshness: fr,
    title,
    primary: fr === "stale" ? `${result.primary} · STALE` : result.primary,
    secondary: result.secondary || result.sourceLabel,
    sourceLabel: result.sourceLabel,
    sourceObservedAtMs: result.sourceObservedAtMs,
    evaluatedAtMs,
    staleAfterMs,
    metricKind: "provider_usage",
    provenance: result.provenance,
  });
}

export function buildUsageSnapshot(input: BuildUsageSnapshotInput): UsageSnapshot {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_USAGE_STALE_AFTER_MS;
  const evaluatedAtMs = input.evaluatedAtMs;
  const adapter = input.providerUsage ?? unavailableProviderUsageAdapter;
  const sourceMs =
    input.topologyReliable && input.discoveryCapturedAtMs != null
      ? input.discoveryCapturedAtMs
      : null;
  const baseFresh = freshnessFor(sourceMs, evaluatedAtMs, staleAfterMs, {
    forceUnavailable: !input.orcaReady || !input.topologyReliable,
  });

  // --- OMP: active count always from public sessions; model/context only when present ---
  const ompCount = countActiveOmp(input.sessions);
  const selected = input.selectedLogicalSessionId
    ? input.sessions.find((s) => s.logicalSessionId === input.selectedLogicalSessionId)
    : undefined;
  const selectedIsOmp = selected?.agentType === "omp";
  const ompFields = selectedIsOmp ? extractSessionModelFields(selected) : extractSessionModelFields(null);
  const ctxSecondary = formatContextSecondary(ompFields);

  let ompPrimary = `${ompCount} active`;
  let ompSecondary = "count · public worktree ps";
  let ompMetric: UsageFaceView["metricKind"] = "active_count";
  let ompProvenance = "public_worktree_ps_omp_count";

  if (baseFresh === "unavailable") {
    ompPrimary = "UNAVAILABLE";
    ompSecondary = !input.orcaReady ? "orca not ready" : "topology unreliable";
    ompMetric = "unavailable";
    ompProvenance = "discovery_unavailable";
  } else if (selectedIsOmp && ompFields.model) {
    ompPrimary = `${ompCount} · ${ompFields.model}`;
    ompSecondary = ctxSecondary ?? (ompFields.effort ? `effort ${ompFields.effort}` : "OMP selected");
    if (ctxSecondary) ompMetric = "context_window";
    ompProvenance = "public_worktree_ps_omp_selected_model";
  } else if (selectedIsOmp && ctxSecondary) {
    // Context alone — never label as account quota.
    ompPrimary = `${ompCount} active`;
    ompSecondary = ctxSecondary;
    ompMetric = "context_window";
    ompProvenance = "public_worktree_ps_omp_context";
  } else if (selectedIsOmp && !ompFields.anyPresent) {
    ompSecondary = "model/context unavailable";
    ompProvenance = "public_worktree_ps_omp_count_no_model_fields";
  }

  if (baseFresh === "stale" && ompPrimary !== "UNAVAILABLE") {
    ompSecondary = `${ompSecondary} · STALE`;
  }

  const ompFace = face({
    kind: "omp",
    freshness: baseFresh === "unavailable" ? "unavailable" : baseFresh,
    title: "OMP",
    primary: ompPrimary,
    secondary: ompSecondary,
    sourceLabel: "public worktree ps",
    sourceObservedAtMs: sourceMs,
    evaluatedAtMs,
    staleAfterMs,
    metricKind: ompMetric,
    provenance: ompProvenance,
  });

  // --- Claude / Codex: adapter boundary (default unavailable) ---
  const claudeFace = providerFace("claude", "CLAUDE", adapter, evaluatedAtMs, staleAfterMs);
  const codexFace = providerFace("codex", "CODEX", adapter, evaluatedAtMs, staleAfterMs);

  // --- Selected-session model/effort (display-only) ---
  const modelFields = extractSessionModelFields(selected);
  let modelFresh: UsageFreshness = "unavailable";
  let modelPrimary = "UNAVAILABLE";
  let modelSecondary = "no selection";
  let modelSourceMs: number | null = null;
  let modelProvenance = "no_selected_session";
  let modelMetric: UsageFaceView["metricKind"] = "unavailable";

  if (!selected) {
    modelFresh = "unavailable";
    modelPrimary = "UNAVAILABLE";
    modelSecondary = "no selection";
  } else if (!input.orcaReady || !input.topologyReliable) {
    modelFresh = "unavailable";
    modelPrimary = "UNAVAILABLE";
    modelSecondary = !input.orcaReady ? "orca not ready" : "topology unreliable";
    modelProvenance = "discovery_unavailable";
  } else if (!modelFields.anyPresent || (!modelFields.model && !modelFields.effort)) {
    modelFresh = "unavailable";
    modelPrimary = "UNAVAILABLE";
    modelSecondary = "no public model/effort fields";
    modelSourceMs = sourceMs;
    modelProvenance = "public_agent_fields_absent";
    // Context alone still displayable as secondary context_window, not model.
    if (formatContextSecondary(modelFields)) {
      modelSecondary = formatContextSecondary(modelFields)!;
      modelMetric = "context_window";
      modelProvenance = "public_agent_context_only";
    }
  } else {
    modelSourceMs = selected.updatedAt ?? sourceMs;
    modelFresh = freshnessFor(modelSourceMs, evaluatedAtMs, staleAfterMs, {});
    modelPrimary = formatModelEffortPrimary(modelFields);
    modelSecondary =
      formatContextSecondary(modelFields) ??
      `${selected.agentType} · public agent fields`;
    modelMetric = "model_effort";
    modelProvenance = "public_agent_model_effort";
    if (modelFresh === "stale") {
      modelSecondary = `${modelSecondary} · STALE`;
    }
  }

  const modelFace = face({
    kind: "model-effort",
    freshness: modelFresh,
    title: "MODEL",
    primary: modelPrimary,
    secondary: modelSecondary,
    sourceLabel: "public agent fields",
    sourceObservedAtMs: modelSourceMs,
    evaluatedAtMs,
    staleAfterMs,
    metricKind: modelMetric,
    provenance: modelProvenance,
  });

  const faces: Record<UsageFaceKind, UsageFaceView> = {
    omp: ompFace,
    claude: claudeFace,
    codex: codexFace,
    "model-effort": modelFace,
  };

  return {
    evaluatedAtMs,
    staleAfterMs,
    topologyReliable: input.topologyReliable,
    orcaReady: input.orcaReady,
    discoveryCapturedAtMs: sourceMs,
    faces,
  };
}

export function emptyUsageSnapshot(evaluatedAtMs: number, staleAfterMs = DEFAULT_USAGE_STALE_AFTER_MS): UsageSnapshot {
  return buildUsageSnapshot({
    sessions: [],
    selectedLogicalSessionId: null,
    orcaReady: false,
    topologyReliable: false,
    discoveryCapturedAtMs: null,
    evaluatedAtMs,
    staleAfterMs,
  });
}
