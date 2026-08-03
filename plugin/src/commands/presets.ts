/**
 * Provider-specific preset resolution. Config owns text; never log or persist invocation text.
 */
import type { AgentPresetKey, DeckConfig } from "../config/store.js";
import type { AgentType } from "../orca/schema.js";
import { normalizeAgentType } from "../orca/schema.js";

export const PRESET_LABELS = ["Finish", "Checks", "Review", "Ship"] as const;
export type PresetIndex = 0 | 1 | 2 | 3;

export function agentTypeToPresetKey(agentType: AgentType | string | undefined | null): AgentPresetKey {
  const n = normalizeAgentType(agentType);
  if (n === "omp") return "omp";
  if (n === "claude") return "claude";
  if (n === "codex") return "codex";
  return "unknown";
}

export function resolvePresetText(
  config: Pick<DeckConfig, "presets">,
  agentType: AgentType | string | undefined | null,
  index: PresetIndex,
): { key: AgentPresetKey; index: PresetIndex; text: string } {
  const key = agentTypeToPresetKey(agentType);
  const set = config.presets[key] ?? config.presets.unknown;
  const text = typeof set?.[index] === "string" ? set[index] : "";
  return { key, index, text };
}

/** Exact public CLI argv for a preset send. runOrca appends --json when missing. */
export function buildPresetSendArgs(terminalHandle: string, text: string): string[] {
  return ["terminal", "send", "--terminal", terminalHandle, "--text", text, "--enter"];
}

export function buildInterruptArgs(terminalHandle: string): string[] {
  return ["terminal", "send", "--terminal", terminalHandle, "--interrupt"];
}

export function buildCloseArgs(terminalHandle: string): string[] {
  return ["terminal", "close", "--terminal", terminalHandle];
}
