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

function metricBadge(metricKind: UsageFaceView["metricKind"]): string {
  switch (metricKind) {
    case "active_count":
      return "COUNT";
    case "context_window":
      return "CTX";
    case "model_effort":
      return "MODEL";
    case "provider_usage":
      return "USAGE";
    default:
      return "N/A";
  }
}

function formatSourceClock(ms: number | null): string {
  if (ms == null) return "src —";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "src —";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `src ${hh}:${mm}:${ss}Z`;
}

/**
 * Render a usage/model key SVG (no animation).
 */
export function renderUsageSvg(face: UsageFaceView, options: UsageSvgOptions = {}): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  const color = freshnessColor(face.freshness, palette);
  const title = escapeXml(truncate(face.title, 7));
  const primary = escapeXml(truncate(face.primary, 11));
  const secondary = escapeXml(truncate(face.secondary, 13));
  const fresh = escapeXml(freshnessLabel(face.freshness));
  const badge = escapeXml(metricBadge(face.metricKind));
  const source = escapeXml(truncate(formatSourceClock(face.sourceObservedAtMs), 15));
  const borderW = face.freshness === "unavailable" ? 2 : 3;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="10" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="8" fill="${palette.panel}" stroke="${color}" stroke-width="${borderW}"/>
  <text x="14" y="29" fill="${palette.muted}" font-family="ui-monospace,Menlo,monospace" font-size="14" font-weight="700" letter-spacing="0.04em">${title}</text>
  <rect x="76" y="12" width="54" height="20" rx="3" fill="${color}" opacity="0.2"/>
  <text x="103" y="28" text-anchor="middle" fill="${color}" font-family="ui-monospace,Menlo,monospace" font-size="14" font-weight="700">${badge}</text>
  <text x="14" y="60" fill="${palette.ink}" font-family="ui-monospace,Menlo,monospace" font-size="18" font-weight="700">${primary}</text>
  <text x="14" y="82" fill="${palette.muted}" font-family="ui-monospace,Menlo,monospace" font-size="15" font-weight="600">${secondary}</text>
  <rect x="14" y="94" width="116" height="1" fill="${palette.line}"/>
  <text x="14" y="115" fill="${color}" font-family="ui-monospace,Menlo,monospace" font-size="16" font-weight="700">${fresh}</text>
  <text x="14" y="132" fill="${palette.muted}" font-family="ui-monospace,Menlo,monospace" font-size="14">${source}</text>
</svg>`;
}

export function usageSvgDataUrl(face: UsageFaceView, options: UsageSvgOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(renderUsageSvg(face, options))}`;
}
