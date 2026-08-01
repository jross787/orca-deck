/**
 * Retry is enabled only when a deterministic public CLI operation exists for the
 * fresh recognized agent state. Installed Orca has no typed retry RPC / command,
 * and we never guess TUI keystrokes — fail closed.
 */
import type { LogicalSession } from "../orca/discovery.js";
import type { StructuredReplyCapability } from "../orca/capabilities.js";

export type RetrySupport =
  | { supported: true; operation: "public_cli"; commandName: string }
  | {
      supported: false;
      code: "no_public_operation" | "no_session" | "state_not_retryable";
      message: string;
    };

/**
 * Evaluate whether Retry may execute. Always unsupported without a typed public contract.
 * Does not inspect terminal text.
 */
export function evaluateRetrySupport(input: {
  session?: LogicalSession;
  /** Reserved for future public capability inspection. */
  publicRetryCommands?: readonly string[];
  structuredReply?: StructuredReplyCapability;
}): RetrySupport {
  if (!input.session) {
    return {
      supported: false,
      code: "no_session",
      message: "No logical session selected.",
    };
  }
  const cmds = input.publicRetryCommands ?? [];
  const hasPublic =
    cmds.includes("terminal retry") ||
    cmds.some((c) => c === "agent retry" || c.startsWith("agent retry "));
  if (!hasPublic) {
    return {
      supported: false,
      code: "no_public_operation",
      message:
        "No deterministic public retry CLI operation is available. Retry stays disabled (FOCUS REQUIRED); do not send guessed text or keys.",
    };
  }
  // Even if a future public command appears, only recognized error/retry-capable states.
  const st = input.session.state;
  if (st !== "error" && st !== "waiting") {
    return {
      supported: false,
      code: "state_not_retryable",
      message: `Agent state ${st} has no deterministic retry operation.`,
    };
  }
  return {
    supported: true,
    operation: "public_cli",
    commandName: cmds.find((c) => c.includes("retry")) ?? "terminal retry",
  };
}
