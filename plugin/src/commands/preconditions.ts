/**
 * Mutation preconditions — fail closed. Phase 0 contract only; no CLI side effects.
 */
import { canMutateSession, type LogicalSession } from "../orca/discovery.js";
import type { StructuredReplyCapability } from "../orca/capabilities.js";
import { evaluateRetrySupport } from "./retry.js";

export type MutationKind =
  | "focus"
  | "preset_send"
  | "draft_send"
  | "interrupt"
  | "close"
  | "retry"
  | "structured_reply";

export type PreconditionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function checkMutationPreconditions(input: {
  session: LogicalSession | undefined;
  kind: MutationKind;
  structuredReply?: StructuredReplyCapability;
  publicRetryCommands?: readonly string[];
  orcaReady?: boolean;
  /** Empty preset text is blocked before send. */
  presetText?: string;
}): PreconditionResult {
  if (input.orcaReady === false) {
    return { ok: false, code: "orca_unavailable", message: "Orca runtime is not ready." };
  }
  if (!input.session) {
    return { ok: false, code: "no_session", message: "No logical session selected." };
  }
  const gate = canMutateSession(input.session);
  if (!gate.allowed) {
    return {
      ok: false,
      code: gate.reason ?? "join_blocked",
      message: `Mutation blocked: join health is ${gate.reason ?? "unknown"}.`,
    };
  }

  if (input.kind === "structured_reply") {
    const sr = input.structuredReply;
    if (!sr || !sr.usableViaPublicCli) {
      return {
        ok: false,
        code: "structured_reply_unavailable",
        message: sr?.detail ?? "Structured reply public CLI contract is unavailable.",
      };
    }
  }

  if (input.kind === "retry") {
    const retry = evaluateRetrySupport({
      session: input.session,
      publicRetryCommands: input.publicRetryCommands,
      structuredReply: input.structuredReply,
    });
    if (!retry.supported) {
      return { ok: false, code: retry.code, message: retry.message };
    }
  }

  if (input.kind === "preset_send" || input.kind === "draft_send") {
    if (typeof input.presetText !== "string" || input.presetText.length === 0) {
      return { ok: false, code: "empty_preset", message: "Preset text is empty." };
    }
  }

  return { ok: true };
}
