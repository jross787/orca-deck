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
  const repo = truncate(card.repo || "repo", 9);
  const worktree = truncate(card.worktree || "worktree", 9);
  const badge = agentBadge(String(card.agentType));
  const elapsed = formatElapsed(card.elapsedMs);
  const children = card.ompChildCount > 0 ? `+${card.ompChildCount}` : "";
  const border = card.selected ? palette.selectedBorder : palette.line;
  const borderWidth = card.selected ? 3 : 1;
  const unreadDot = card.unread
    ? `<circle cx="128" cy="18" r="5" fill="${palette.unread}" stroke="${color}" stroke-width="1"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="${escapeXml(label)} ${escapeXml(repo)}">
  <rect width="144" height="144" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="18" fill="${palette.panel}" stroke="${border}" stroke-width="${borderWidth}"/>
  <text x="72" y="30" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700">${escapeXml(repo)}</text>
  <text x="72" y="55" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="600">${escapeXml(worktree)}</text>
  ${unreadDot}
  <line x1="16" y1="65" x2="128" y2="65" stroke="${palette.line}" stroke-width="1"/>
  <text x="72" y="94" text-anchor="middle" fill="${color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700" letter-spacing="0.5">${escapeXml(label)}</text>
  <text x="14" y="126" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700">${escapeXml(badge)}${children ? ` ${escapeXml(children)}` : ""}</text>
  <text x="130" y="126" text-anchor="end" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700">${escapeXml(elapsed)}</text>
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
  <rect width="144" height="144" fill="${palette.bg}"/>
  <rect x="8" y="8" width="128" height="128" rx="18" fill="${palette.panel}" stroke="${palette.line}" stroke-width="1"/>
  <text x="72" y="66" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700">SLOT ${n}</text>
  <text x="72" y="98" text-anchor="middle" fill="${palette.line}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700">EMPTY</text>
</svg>`;
}

export function emptySlotSvgDataUrl(slotIndex: number, options: SessionSvgOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(renderEmptySlotSvg(slotIndex, options))}`;
}

export type BasicControlKind = "next" | "focus" | "acknowledge";

export type SafeControlKind =
  | "interrupt-close"
  | "preset-1"
  | "preset-2"
  | "preset-3"
  | "preset-4"
  | "retry"
  | "structured-reply"
  | "draft"
  | "send-draft"
  | "cancel-draft"
  | "new-omp"
  | "new-claude"
  | "new-codex";

export type ControlKind = BasicControlKind | SafeControlKind;

export type ControlSvgOptions = SessionSvgOptions & {
  /** Hold-to-close progress 0..1 for interrupt-close face. */
  progress?: number;
};

type ControlFaceInput = Pick<
  ControlViewModel,
  | "overflowCount"
  | "focusHighlighted"
  | "focusEnabled"
  | "ackEnabled"
  | "nextTargetId"
  | "selectedLogicalSessionId"
  | "orcaReady"
> &
  Partial<
    Pick<
      ControlViewModel,
      | "mutationEnabled"
      | "presetsEnabled"
      | "retryEnabled"
      | "retryDetail"
      | "interruptEnabled"
      | "structuredReplyEnabled"
      | "structuredReplyDetail"
      | "presetKey"
      | "draftOpen"
      | "draftUi"
      | "draftCharacters"
      | "draftReady"
      | "draftAmbiguous"
      | "draftDetail"
      | "newAgentEnabled"
    >
  >;

function controlFace(
  kind: ControlKind,
  control: ControlFaceInput,
  progress: number,
): { title: string; detail: string; color: string; border: string; borderWidth: number; bar?: number } {
  const palette = SESSION_PALETTE;
  if (kind === "next") {
    const overflow = control.overflowCount > 0 ? `+${control.overflowCount}` : "";
    let detail = control.nextTargetId
      ? truncate(control.nextTargetId.split(":").slice(-1)[0] ?? "target", 14)
      : "none";
    if (overflow) detail = `${detail} ${overflow}`;
    return {
      title: "NEXT",
      detail,
      color: control.nextTargetId ? palette.waiting : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "focus") {
    const enabled = control.focusEnabled;
    return {
      title: "FOCUS",
      detail: control.focusHighlighted ? "NEEDS FOCUS" : enabled ? "ready" : "blocked",
      color: control.focusHighlighted ? palette.waiting : enabled ? palette.working : palette.idle,
      border: control.focusHighlighted ? palette.selectedBorder : palette.line,
      borderWidth: control.focusHighlighted ? 3 : 1,
    };
  }
  if (kind === "acknowledge") {
    return {
      title: "ACK",
      detail: control.ackEnabled ? "clear unread" : "idle",
      color: control.ackEnabled ? palette.done : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "interrupt-close") {
    const enabled = control.interruptEnabled === true;
    const holding = progress > 0;
    return {
      title: holding && progress >= 1 ? "CLOSE" : "INT/K",
      detail: holding
        ? progress >= 1
          ? "closing"
          : `hold ${Math.round(progress * 100)}%`
        : enabled
          ? "tap/hold"
          : "blocked",
      color: holding ? (progress >= 1 ? palette.error : palette.waiting) : enabled ? palette.error : palette.idle,
      border: holding ? palette.error : palette.line,
      borderWidth: holding ? 3 : 1,
      bar: holding ? Math.max(0, Math.min(1, progress)) : undefined,
    };
  }
  if (kind === "preset-1" || kind === "preset-2" || kind === "preset-3" || kind === "preset-4") {
    const labels = {
      "preset-1": "FINISH",
      "preset-2": "CHECKS",
      "preset-3": "REVIEW",
      "preset-4": "SHIP",
    } as const;
    const colors = {
      "preset-1": palette.working,
      "preset-2": palette.done,
      "preset-3": palette.waiting,
      "preset-4": palette.stuck,
    } as const;
    const enabled = control.presetsEnabled === true;
    return {
      title: labels[kind],
      detail: enabled ? control.presetKey ?? "ready" : "blocked",
      color: enabled ? colors[kind] : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "retry") {
    const enabled = control.retryEnabled === true;
    return {
      title: "RETRY",
      detail: enabled ? "ready" : control.retryDetail || "FOCUS REQUIRED",
      color: enabled ? palette.waiting : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "structured-reply") {
    return {
      title: "REPLY",
      detail: control.structuredReplyDetail || "REPLY UNAVAILABLE",
      color: palette.unknown,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "draft") {
    const open = control.draftOpen === true;
    const ambiguous = control.draftAmbiguous === true;
    const ui = control.draftUi ?? "empty";
    let detail = control.draftDetail || "open";
    let color = palette.idle;
    if (ambiguous) {
      detail = "AMBIGUOUS";
      color = palette.waiting;
    } else if (ui === "submitting") {
      detail = "SENDING";
      color = palette.waiting;
    } else if (ui === "ready" || control.draftReady) {
      detail = "READY";
      color = palette.done;
    } else if (open) {
      detail = ui === "empty" ? "EMPTY" : ui.toUpperCase();
      color = palette.working;
    }
    return {
      title: "DRAFT",
      detail,
      color,
      border: open ? palette.selectedBorder : palette.line,
      borderWidth: open ? 2 : 1,
    };
  }
  if (kind === "send-draft") {
    const enabled = control.draftReady === true && control.draftAmbiguous !== true;
    return {
      title: "SEND",
      detail: control.draftAmbiguous ? "FOCUS REQ" : enabled ? "selected" : "blocked",
      color: enabled ? palette.done : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "cancel-draft") {
    const open = control.draftOpen === true;
    return {
      title: "CANCEL",
      detail: open ? "close draft" : "idle",
      color: open ? palette.error : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  if (kind === "new-omp" || kind === "new-claude" || kind === "new-codex") {
    const labels = {
      "new-omp": "OMP*",
      "new-claude": "CLAUDE*",
      "new-codex": "CODEX*",
    } as const;
    const colors = {
      "new-omp": palette.working,
      "new-claude": palette.waiting,
      "new-codex": palette.stuck,
    } as const;
    const enabled = control.newAgentEnabled === true;
    return {
      title: labels[kind],
      detail: enabled ? "launch" : "need draft",
      color: enabled ? colors[kind] : palette.idle,
      border: palette.line,
      borderWidth: 1,
    };
  }
  return {
    title: "CTRL",
    detail: "unknown",
    color: palette.unknown,
    border: palette.line,
    borderWidth: 1,
  };
}

function controlDetailLines(text: string): readonly [string, string?] {
  if (text.length <= 11) return [text];
  const before = text.lastIndexOf(" ", 11);
  const split = before > 0 ? before : text.indexOf(" ", 11);
  if (split <= 0) return [truncate(text, 11)];
  return [truncate(text.slice(0, split), 11), truncate(text.slice(split + 1), 11)];
}

export function renderControlSvg(
  kind: ControlKind,
  control: ControlFaceInput,
  options: ControlSvgOptions = {},
): string {
  const size = options.size ?? 144;
  const palette = options.palette ?? SESSION_PALETTE;
  const progress = options.progress ?? 0;
  const face = controlFace(kind, control, progress);
  const barWidth = face.bar != null ? Math.round(120 * face.bar) : 0;
  const [detailFirst, detailSecond] = controlDetailLines(face.detail);
  const detailSvg = detailSecond
    ? `<text x="72" y="101" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="600">${escapeXml(detailFirst)}</text>
  <text x="72" y="124" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="600">${escapeXml(detailSecond)}</text>`
    : `<text x="72" y="113" text-anchor="middle" fill="${palette.ink}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="600">${escapeXml(detailFirst)}</text>`;
  const barSvg =
    face.bar != null
      ? `<rect x="12" y="132" width="120" height="5" rx="2" fill="${palette.line}"/>
  <rect x="12" y="132" width="${barWidth}" height="5" rx="2" fill="${face.color}"/>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144" role="img" aria-label="${face.title} ${escapeXml(face.detail)}">
  <rect width="144" height="144" fill="${palette.bg}"/>
  <rect x="6" y="6" width="132" height="132" rx="18" fill="${palette.panel}" stroke="${face.border}" stroke-width="${face.borderWidth}"/>
  <text x="72" y="32" text-anchor="middle" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700" letter-spacing="2">ORCA</text>
  <text x="72" y="72" text-anchor="middle" fill="${face.color}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="28" font-weight="700" letter-spacing="0.5">${face.title}</text>
  ${detailSvg}
  ${barSvg}
</svg>`;
}

export function controlSvgDataUrl(
  kind: ControlKind,
  control: ControlFaceInput,
  options: ControlSvgOptions = {},
): string {
  return `data:image/svg+xml,${encodeURIComponent(renderControlSvg(kind, control, options))}`;
}
