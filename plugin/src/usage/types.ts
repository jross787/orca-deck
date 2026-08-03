/**
 * Display-only usage / model-effort faces.
 * Never mutate agents. Never substitute context-window for account quota.
 */

export type UsageFaceKind = "omp" | "claude" | "codex" | "model-effort";

/** Explicit freshness — never invent provider update times. */
export type UsageFreshness = "fresh" | "stale" | "unavailable";

/**
 * Metric class for the face. Context-window values MUST use context_window
 * so UI never implies account quota.
 */
export type UsageMetricKind =
  | "active_count"
  | "context_window"
  | "model_effort"
  | "provider_usage"
  | "unavailable";

export type PublicModelFields = {
  model: string | null;
  effort: string | null;
  /** Context tokens when publicly present. */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** True when any model/effort/context field was present on the public record. */
  anyPresent: boolean;
};

export type UsageFaceView = {
  kind: UsageFaceKind;
  freshness: UsageFreshness;
  title: string;
  /** Primary value line (count, model, UNAVAILABLE, …). */
  primary: string;
  /** Secondary detail (context %, effort, provenance short). */
  secondary: string;
  /** Human source label — not a filesystem path. */
  sourceLabel: string;
  /**
   * Real observation time of the underlying public source (ms epoch).
   * Null when no observation exists. NEVER Date.now() masquerading as provider time.
   */
  sourceObservedAtMs: number | null;
  /** When the deck last evaluated this face (local clock). */
  evaluatedAtMs: number;
  staleAfterMs: number;
  metricKind: UsageMetricKind;
  /** Stable provenance token for adapters/tests. */
  provenance: string;
};

export type UsageSnapshot = {
  evaluatedAtMs: number;
  staleAfterMs: number;
  topologyReliable: boolean;
  orcaReady: boolean;
  /** Discovery capture time when topology was reliable; else null. */
  discoveryCapturedAtMs: number | null;
  faces: Record<UsageFaceKind, UsageFaceView>;
};

export type ProviderUsageAdapterResult =
  | {
      available: true;
      /** Account/provider usage value text — only from official public API. */
      primary: string;
      secondary: string;
      sourceLabel: string;
      sourceObservedAtMs: number;
      provenance: string;
    }
  | {
      available: false;
      reason: string;
      sourceLabel: string;
      provenance: string;
    };

export type ProviderUsageAdapter = (input: {
  provider: "claude" | "codex";
  evaluatedAtMs: number;
}) => ProviderUsageAdapterResult | Promise<ProviderUsageAdapterResult>;
