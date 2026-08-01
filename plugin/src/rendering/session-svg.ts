/**
 * Session-card and control-key SVG faces (144×144).
 * High-contrast palette; every state has icon + label (never color alone).
 * No animation on session cards.
 */

import type { CardViewModel, ControlViewModel, SessionCardState } from "../state/types.js";
import { ImageWriteDebouncer } from "./health-svg.js";

export { ImageWriteDebouncer };

export type SessionPalette = {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  working: string;
  waiting: string;
  done: string;
  error: string;
  stuck: string;
  idle: string;
  identityLost: string;
  closed: string;
  unknown: string;
  selectedBorder: string;
  unread: string;
};

export const SESSION_PALETTE: SessionPalette = {
  bg: "#0b0d10",
  panel: "#12151a",
  ink: "#f2f4f7",
  muted: "#9aa3af",
  line: "#2a313c",
  working: "#3b82f6",
  waiting: "#f5a524",
  done: "#22c55e",
  error: "#f04438",
  stuck: "#a855f7",
  idle: "#6b7280",
  identityLost: "#3f3f46",
  closed: "#4b5563",
  unknown: "#94a3b8",
  selectedBorder: "#ffffff",
  unread: "#f8fafc",
};

export type SessionSvgOptions = {
  size?: number;
  palette?: SessionPalette;
};

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

export function stateColor(state: SessionCardState, palette: SessionPalette = SESSION_PALETTE): string {
  switch (state) {
    case "working":
      return palette.working;
    case "waiting":
      return palette.waiting;
    case "done":
      return palette.done;
    case "error":
      return palette.error;
    case "stuck":
      return palette.stuck;
    case "idle":
    case "unavailable":
      return palette.idle;
    case "identity_lost":
      return palette.identityLost;
    case "closed":
      return palette.closed;
    case "unknown":
    case "disabled":
      return palette.unknown;
    case "disconnected":
      return palette.waiting;
    default:
      return palette.unknown;
  }
}

export function stateLabel(state: SessionCardState): string {
  switch (state) {
    case "working":
      return "WORKING";
    case "waiting":
      return "WAITING";
    case "done":
      return "DONE";
    case "error":
      return "ERROR";
    case "stuck":
      return "STUCK";
    case "idle":
      return "IDLE";
    case "disconnected":
      return "OFFLINE";
    case "closed":
      return "CLOSED";
    case "identity_lost":
      return "LOST";
    case "unknown":
      return "UNKNOWN";
    case "disabled":
      return "DISABLED";
    case "unavailable":
      return "UNAVAIL";
    default:
      return "UNKNOWN";
  }
}

/** Compact glyph path per state (icon, not color-only). */
function stateIcon(state: SessionCardState, color: string): string {
  switch (state) {
    case "working":
      return `<circle cx="24" cy="24" r="8" fill="none" stroke="${color}" stroke-width="3"/><path d="M24 16 v8 h6" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    case "waiting":
      return `<path d="M24 14 l10 18 h-20 z" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/><circle cx="24" cy="28" r="1.6" fill="${color}"/>`;
    case "done":
      return `<circle cx="24" cy="24" r="10" fill="none" stroke="${color}" stroke-width="3"/><path d="M18 24 l4 4 l8-9" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "error":
      return `<circle cx="24" cy="24" r="10" fill="none" stroke="${color}" stroke-width="3"/><path d="M24 18 v7" stroke="${color}" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="30" r="1.6" fill="${color}"/>`;
    case "stuck":
      return `<rect x="14" y="14" width="20" height="20" rx="3" fill="none" stroke="${color}" stroke-width="3"/><path d="M20 24 h8 M24 20 v8" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    case "identity_lost":
      return `<path d="M16 20 h16 M16 28 h16" stroke="${color}" stroke-width="3" stroke-linecap="round"/><path d="M20 16 l-4 8 4 8 M28 16 l4 8 -4 8" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "closed":
      return `<rect x="15" y="16" width="18" height="16" rx="2" fill="none" stroke="${color}" stroke-width="3"/><path d="M15 22 h18" stroke="${color}" stroke-width="3"/>`;
    case "disconnected":
      return `<path d="M16 24 h6 M26 24 h6" stroke="${color}" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="24" r="3" fill="${color}"/>`;
    default:
      return `<circle cx="24" cy="24" r="9" fill="none" stroke="${color}" stroke-width="3"/><text x="24" y="28" text-anchor="middle" fill="${color}" font-size="14" font-family="ui-monospace, Menlo, monospace">?</text>`;
  }
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function agentBadge(agentType: string): string {
  const t = agentType.toLowerCase();
  if (t === "omp") return "OMP";
  if (t === "claude") return "CLAUDE";
  if (t === "codex") return "CODEX";
  return truncate(agentType.toUpperCase() || "AGENT", 8);
}

/**
 * Render a session card SVG (no animation).
 */
export function renderSessionSvg(card: CardViewModel, options: SessionSvgOptions = {}): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  const color = stateColor(card.cardState, palette);
  const label = stateLabel(card.cardState);
  const repo = truncate(card.repo || "repo", 16);
  const worktree = truncate(card.worktree || "worktree", 16);
  const badge = agentBadge(String(card.agentType));
  const elapsed = formatElapsed(card.elapsedMs);
  const children = card.ompChildCount > 0 ? `+${card.ompChildCount}` : "";
  const border = card.selected ? palette.selectedBorder : palette.line;
  const borderWidth = card.selected ? 3 : 1;
  const unreadDot = card.unread
    ? `<circle cx="128" cy="18" r="5" fill="${palette.unread}" stroke="${color}" stroke-width="1"/>`
    : "";
  const icon = stateIcon(card.cardState, color);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="${escapeXml(label)} ${escapeXml(repo)}">
  <rect width="144" height="144" rx="10" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="8" fill="${palette.panel}" stroke="${border}" stroke-width="${borderWidth}"/>
  <text x="14" y="26" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" font-weight="700">${escapeXml(repo)}</text>
  <text x="14" y="44" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${escapeXml(worktree)}</text>
  ${unreadDot}
  <g transform="translate(12, 54)">${icon}</g>
  <text x="60" y="74" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700" letter-spacing="1">${escapeXml(label)}</text>
  <text x="60" y="92" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${escapeXml(badge)}${children ? ` · ${escapeXml(children)}` : ""}</text>
  <text x="14" y="124" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escapeXml(elapsed)}</text>
  <text x="130" y="124" text-anchor="end" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">${escapeXml(card.hostId === "local" ? "" : card.hostId.slice(0, 10))}</text>
</svg>`;
}

export function sessionSvgDataUrl(card: CardViewModel, options: SessionSvgOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(renderSessionSvg(card, options))}`;
}

export function renderEmptySlotSvg(slotIndex: number, options: SessionSvgOptions = {}): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  const n = String(slotIndex + 1).padStart(2, "0");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="Empty slot ${n}">
  <rect width="144" height="144" rx="10" fill="${palette.bg}"/>
  <rect x="8" y="8" width="128" height="128" rx="8" fill="${palette.panel}" stroke="${palette.line}" stroke-width="1"/>
  <text x="72" y="70" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">SLOT ${n}</text>
  <text x="72" y="92" text-anchor="middle" fill="${palette.line}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">EMPTY</text>
</svg>`;
}

export function emptySlotSvgDataUrl(slotIndex: number, options: SessionSvgOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(renderEmptySlotSvg(slotIndex, options))}`;
}

export type ControlKind = "next" | "focus" | "acknowledge";

export function renderControlSvg(
  kind: ControlKind,
  control: Pick<
    ControlViewModel,
    | "overflowCount"
    | "focusHighlighted"
    | "focusEnabled"
    | "ackEnabled"
    | "nextTargetId"
    | "selectedLogicalSessionId"
    | "orcaReady"
  >,
  options: SessionSvgOptions = {},
): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  let title = "CTRL";
  let detail = "";
  let color = palette.muted;

  if (kind === "next") {
    title = "NEXT";
    const overflow = control.overflowCount > 0 ? `+${control.overflowCount}` : "";
    detail = control.nextTargetId
      ? truncate(control.nextTargetId.split(":").slice(-1)[0] ?? "target", 14)
      : "none";
    color = control.nextTargetId ? palette.waiting : palette.idle;
    if (overflow) detail = `${detail} ${overflow}`;
  } else if (kind === "focus") {
    title = "FOCUS";
    const enabled = control.focusEnabled;
    color = control.focusHighlighted ? palette.waiting : enabled ? palette.working : palette.idle;
    detail = control.focusHighlighted ? "NEEDS FOCUS" : enabled ? "ready" : "blocked";
  } else {
    title = "ACK";
    const enabled = control.ackEnabled;
    color = enabled ? palette.done : palette.idle;
    detail = enabled ? "clear unread" : "idle";
  }

  const border = kind === "focus" && control.focusHighlighted ? palette.selectedBorder : palette.line;
  const borderWidth = kind === "focus" && control.focusHighlighted ? 3 : 1;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="${title}">
  <rect width="144" height="144" rx="10" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="8" fill="${palette.panel}" stroke="${border}" stroke-width="${borderWidth}"/>
  <text x="72" y="48" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" letter-spacing="2">ORCA</text>
  <text x="72" y="82" text-anchor="middle" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700" letter-spacing="2">${title}</text>
  <text x="72" y="110" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escapeXml(detail)}</text>
</svg>`;
}

export function controlSvgDataUrl(
  kind: ControlKind,
  control: Pick<
    ControlViewModel,
    | "overflowCount"
    | "focusHighlighted"
    | "focusEnabled"
    | "ackEnabled"
    | "nextTargetId"
    | "selectedLogicalSessionId"
    | "orcaReady"
  >,
  options: SessionSvgOptions = {},
): string {
  return `data:image/svg+xml,${encodeURIComponent(renderControlSvg(kind, control, options))}`;
}
