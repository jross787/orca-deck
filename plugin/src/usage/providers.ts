/**
 * Provider usage adapters (Claude / Codex).
 * Installed public Orca CLI has no account-usage endpoint — fail closed.
 * Keep a thin boundary so a future official API can supply data without scraping.
 */

import type { ProviderUsageAdapter, ProviderUsageAdapterResult } from "./types.js";

export const CLAUDE_USAGE_PROVENANCE = "no_public_orca_claude_usage_api" as const;
export const CODEX_USAGE_PROVENANCE = "no_public_orca_codex_usage_api" as const;
export const PROVIDER_USAGE_SOURCE_LABEL = "public Orca CLI" as const;

/**
 * Default adapter: explicit unavailable until an official public source exists.
 * Does not call Orca, does not invent quota numbers, does not scrape UI/DB.
 */
export const unavailableProviderUsageAdapter: ProviderUsageAdapter = (input) => {
  const provenance =
    input.provider === "claude" ? CLAUDE_USAGE_PROVENANCE : CODEX_USAGE_PROVENANCE;
  const result: ProviderUsageAdapterResult = {
    available: false,
    reason: "No public Orca usage endpoint for this provider",
    sourceLabel: PROVIDER_USAGE_SOURCE_LABEL,
    provenance,
  };
  return result;
};

/**
 * Optional future adapter factory — accepts only already-fetched official payloads.
 * Not wired to any network/CLI call here.
 */
export function officialPayloadProviderUsageAdapter(payload: {
  provider: "claude" | "codex";
  primary: string;
  secondary?: string;
  sourceObservedAtMs: number;
  provenance: string;
  sourceLabel?: string;
}): ProviderUsageAdapter {
  return (input) => {
    if (input.provider !== payload.provider) {
      return unavailableProviderUsageAdapter(input);
    }
    return {
      available: true,
      primary: payload.primary,
      secondary: payload.secondary ?? "",
      sourceLabel: payload.sourceLabel ?? PROVIDER_USAGE_SOURCE_LABEL,
      sourceObservedAtMs: payload.sourceObservedAtMs,
      provenance: payload.provenance,
    };
  };
}
