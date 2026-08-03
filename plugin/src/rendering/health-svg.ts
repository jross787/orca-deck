/**
 * Dynamic SVG faces for the Health key.
 * Compact instrument-panel aesthetic; thin sonar sweep on ready (respect reduced motion).
 */
import type { HealthSnapshot, HealthState } from "../health/check.js";

export type HealthPalette = {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  ready: string;
  unavailable: string;
  incompatible: string;
  error: string;
};

export const HEALTH_PALETTE: HealthPalette = {
  bg: "#0b0d10",
  panel: "#12151a",
  ink: "#f2f4f7",
  muted: "#9aa3af",
  line: "#2a313c",
  ready: "#3dd68c",
  unavailable: "#f5a524",
  incompatible: "#c084fc",
  error: "#f04438",
};

export type HealthSvgOptions = {
  size?: number;
  reducedMotion?: boolean;
  nowMs?: number;
  palette?: HealthPalette;
};

function stateColor(state: HealthState, palette: HealthPalette): string {
  switch (state) {
    case "ready":
      return palette.ready;
    case "unavailable":
      return palette.unavailable;
    case "incompatible":
      return palette.incompatible;
    case "error":
      return palette.error;
  }
}

function stateLabel(state: HealthState): string {
  switch (state) {
    case "ready":
      return "READY";
    case "unavailable":
      return "UNAVAIL";
    case "incompatible":
      return "INCOMPAT";
    case "error":
      return "ERROR";
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render a 144×144 (default) health key SVG string (not a data URL).
 */
export function renderHealthSvg(
  health: Pick<HealthSnapshot, "state" | "detail" | "orcaAppVersion" | "runtimeState">,
  options: HealthSvgOptions = {},
): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? HEALTH_PALETTE;
  const color = stateColor(health.state, palette);
  const label = stateLabel(health.state);
  const version = health.orcaAppVersion ? truncate(health.orcaAppVersion, 12) : "—";
  const runtime = health.runtimeState ? truncate(health.runtimeState, 14) : health.state;
  const detail = truncate(health.detail || "", 16);
  const reducedMotion = options.reducedMotion === true;
  const sweep =
    health.state === "ready" && !reducedMotion
      ? `<circle cx="72" cy="52" r="22" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.35">
  <animate attributeName="r" values="16;28;16" dur="2.4s" repeatCount="indefinite"/>
  <animate attributeName="opacity" values="0.55;0.05;0.55" dur="2.4s" repeatCount="indefinite"/>
</circle>`
      : `<circle cx="72" cy="52" r="22" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.35"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="Orca health ${escapeXml(label)}">
  <rect width="144" height="144" rx="10" fill="${palette.bg}"/>
  <rect x="8" y="8" width="128" height="128" rx="8" fill="${palette.panel}" stroke="${palette.line}" stroke-width="1"/>
  <text x="16" y="28" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" font-weight="700" letter-spacing="1.2">ORCA</text>
  <text x="128" y="28" text-anchor="end" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escapeXml(version)}</text>
  <line x1="16" y1="34" x2="128" y2="34" stroke="${palette.line}" stroke-width="1"/>
  ${sweep}
  <circle cx="72" cy="52" r="8" fill="${color}"/>
  <text x="72" y="92" text-anchor="middle" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" font-weight="700" letter-spacing="1.5">${escapeXml(label)}</text>
  <text x="72" y="111" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" font-weight="600">${escapeXml(runtime)}</text>
  <text x="72" y="128" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escapeXml(detail)}</text>
</svg>`;
}

/**
 * Build a data URL suitable for action.setImage.
 */
export function healthSvgDataUrl(
  health: Pick<HealthSnapshot, "state" | "detail" | "orcaAppVersion" | "runtimeState">,
  options: HealthSvgOptions = {},
): string {
  const svg = renderHealthSvg(health, options);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Debounce identical image writes per action id.
 */
export class ImageWriteDebouncer {
  private readonly last = new Map<string, string>();

  /**
   * @returns true when the image should be written (changed or first write).
   */
  shouldWrite(actionId: string, image: string): boolean {
    if (this.last.get(actionId) === image) return false;
    this.last.set(actionId, image);
    return true;
  }

  clear(actionId?: string): void {
    if (actionId === undefined) this.last.clear();
    else this.last.delete(actionId);
  }
}
