/**
 * Typed property-inspector ↔ plugin message protocol.
 * Every request carries requestId; replies echo it.
 */
import type { DeckConfig } from "../config/store.js";
import type { HealthSnapshot } from "../health/check.js";
import type { DiagnosticsExport } from "../usage/diagnostics.js";

export type PiRequestType =
  | "config.get"
  | "config.patch"
  | "health.refresh"
  | "sound.test"
  | "diagnostics.export";

export type PiRequest =
  | { type: "config.get"; requestId: string }
  | { type: "config.patch"; requestId: string; patch: Record<string, unknown> }
  | { type: "health.refresh"; requestId: string }
  | { type: "sound.test"; requestId: string }
  | { type: "diagnostics.export"; requestId: string };

export type PiResponse =
  | {
      type: "config.snapshot";
      requestId: string;
      config: DeckConfig;
      path: string;
      source: string;
      lastError?: string;
    }
  | {
      type: "config.saved";
      requestId: string;
      config: DeckConfig;
      path: string;
      source: string;
    }
  | {
      type: "health.snapshot";
      requestId: string;
      health: HealthSnapshot;
    }
  | {
      type: "sound.tested";
      requestId: string;
      played: boolean;
      detail: string;
    }
  | {
      type: "diagnostics.snapshot";
      requestId: string;
      diagnostics: DiagnosticsExport;
    }
  | {
      type: "error";
      requestId: string;
      code: string;
      message: string;
    };

export type PiMessage = PiRequest | PiResponse;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parsePiRequest(input: unknown):
  | { ok: true; value: PiRequest }
  | { ok: false; code: string; message: string } {
  if (!isObject(input)) {
    return { ok: false, code: "invalid_message", message: "PI message must be an object" };
  }
  const requestId = input.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ok: false, code: "missing_request_id", message: "requestId is required" };
  }
  const type = input.type;
  if (type === "config.get") {
    return { ok: true, value: { type, requestId } };
  }
  if (type === "health.refresh") {
    return { ok: true, value: { type, requestId } };
  }
  if (type === "sound.test") {
    return { ok: true, value: { type, requestId } };
  }
  if (type === "diagnostics.export") {
    return { ok: true, value: { type, requestId } };
  }
  if (type === "config.patch") {
    if (!isObject(input.patch)) {
      return { ok: false, code: "invalid_patch", message: "config.patch requires object patch" };
    }
    return { ok: true, value: { type, requestId, patch: input.patch } };
  }
  return {
    ok: false,
    code: "unknown_type",
    message: `unsupported PI message type: ${String(type)}`,
  };
}

export function responseMatchesRequest(requestId: string, response: PiResponse): boolean {
  return response.requestId === requestId;
}
