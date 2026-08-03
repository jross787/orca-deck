/**
 * Usage / model-effort key SVG faces (144×144).
 * Explicit unavailable/stale labels — never color alone.
 */

import type { UsageFaceView, UsageFreshness } from "../usage/types.js";
import { ImageWriteDebouncer } from "./health-svg.js";
import { SESSION_PALETTE, type SessionPalette } from "./session-svg.js";

export { ImageWriteDebouncer };

export type UsageSvgOptions = {
  size?: number;
  palette?: SessionPalette;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function freshnessColor(freshness: UsageFreshness, palette: SessionPalette): string {
  if (freshness === "fresh") return palette.done;
  if (freshness === "stale") return palette.waiting;
  return palette.unknown;
}

function freshnessLabel(freshness: UsageFreshness): string {
  if (freshness === "fresh") return "FRESH";
  if (freshness === "stale") return "STALE";
  return "UNAVAILABLE";
}



/**
 * Render a usage/model key SVG (no animation).
 */
export function renderUsageSvg(face: UsageFaceView, options: UsageSvgOptions = {}): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  const color = freshnessColor(face.freshness, palette);
  const title = escapeXml(truncate(face.title, 9));
  const primary = escapeXml(truncate(face.primary, 9));
  const secondary = escapeXml(truncate(face.secondary, 11));
  const fresh = escapeXml(freshnessLabel(face.freshness));
  const borderW = face.freshness === "unavailable" ? 2 : 3;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="18" fill="${palette.panel}" stroke="${color}" stroke-width="${borderW}"/>
  <text x="72" y="31" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700" letter-spacing="0.5">${title}</text>
  <text x="72" y="66" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace,Menlo,monospace" font-size="24" font-weight="700">${primary}</text>
  <text x="72" y="96" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="600">${secondary}</text>
  <text x="72" y="127" text-anchor="middle" fill="${color}" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700">${fresh}</text>
</svg>`;
}

export function usageSvgDataUrl(face: UsageFaceView, options: UsageSvgOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(renderUsageSvg(face, options))}`;
}
