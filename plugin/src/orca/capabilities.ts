/**
 * Command capability inspection. Structured reply absence is explicit and fail-closed.
 */
import { runOrcaJson, type OrcaCliOptions } from "./cli.js";
import { decodeStatusEnvelope, type OrcaEnvelope, type OrcaStatusResult } from "./schema.js";

export const STRUCTURED_REPLY_RUNTIME_CAP = "terminal.query-reply-input.v1";

export type CommandSpec = {
  command: string;
  path: string[];
  summary?: string;
  usage?: string;
  flags?: string[];
  aliases?: unknown[];
};

export type StructuredReplyCapability = {
  runtimeAdvertisesQueryReplyInput: boolean;
  publicCliHasTerminalQuery: boolean;
  publicCliHasTerminalReply: boolean;
  usableViaPublicCli: boolean;
  status: "available" | "blocked_missing_public_cli" | "blocked_missing_runtime_cap";
  detail: string;
  futurePublicContract: {
    proposedCommands: ["terminal query", "terminal reply"];
    requiredFlags: string[];
    notes: string[];
  };
};

export type CapabilityBlocker = {
  id: string;
  severity: "blocking" | "warning";
  message: string;
};

export type CapabilityInspection = {
  inspectedAt: string;
  orcaAppVersion?: string;
  runtimeId?: string;
  runtimeCapabilities: string[];
  publicCommands: {
    terminal: string[];
    worktree: string[];
    allTerminalRelated: string[];
  };
  structuredReply: StructuredReplyCapability;
  readOnlyDiscovery: { status: boolean; worktreePs: boolean; terminalList: boolean };
  mutationsAvailable: {
    terminalSend: boolean;
    terminalSwitch: boolean;
    terminalClose: boolean;
    terminalInterrupt: boolean;
  };
  blockers: CapabilityBlocker[];
};

function isCommandSpec(v: unknown): v is CommandSpec {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.command === "string" && Array.isArray(o.path);
}

function extractCommands(json: unknown): CommandSpec[] {
  if (Array.isArray(json)) return json.filter(isCommandSpec);
  if (typeof json === "object" && json !== null) {
    const env = json as OrcaEnvelope<CommandSpec[] | { commands?: CommandSpec[] }>;
    const result = env.result ?? (json as CommandSpec[] | { commands?: CommandSpec[] });
    if (Array.isArray(result)) return result.filter(isCommandSpec);
    if (typeof result === "object" && result !== null && Array.isArray(result.commands)) {
      return result.commands.filter(isCommandSpec);
    }
  }
  return [];
}

export function evaluateStructuredReply(input: {
  runtimeCapabilities: readonly string[];
  publicCommands: readonly string[];
}): StructuredReplyCapability {
  const runtimeAdvertisesQueryReplyInput = input.runtimeCapabilities.includes(
    STRUCTURED_REPLY_RUNTIME_CAP,
  );
  const publicCliHasTerminalQuery = input.publicCommands.some(
    (c) => c === "terminal query" || c.startsWith("terminal query "),
  );
  const publicCliHasTerminalReply = input.publicCommands.some(
    (c) => c === "terminal reply" || c.startsWith("terminal reply "),
  );
  const usableViaPublicCli = publicCliHasTerminalQuery && publicCliHasTerminalReply;

  let status: StructuredReplyCapability["status"];
  let detail: string;
  if (usableViaPublicCli) {
    status = "available";
    detail = "Public CLI exposes terminal query/reply.";
  } else if (runtimeAdvertisesQueryReplyInput) {
    status = "blocked_missing_public_cli";
    detail =
      "Runtime advertises terminal.query-reply-input.v1 but public CLI schema has no terminal query/reply commands. Phase 0B must add a typed public terminal query/reply --json contract before structured option submission can ship.";
  } else {
    status = "blocked_missing_runtime_cap";
    detail =
      "Neither runtime capability terminal.query-reply-input.v1 nor public terminal query/reply commands are available.";
  }

  return {
    runtimeAdvertisesQueryReplyInput,
    publicCliHasTerminalQuery,
    publicCliHasTerminalReply,
    usableViaPublicCli,
    status,
    detail,
    futurePublicContract: {
      proposedCommands: ["terminal query", "terminal reply"],
      requiredFlags: ["--terminal", "--json", "--option-id or equivalent deterministic selector"],
      notes: [
        "Must not rely on raw TUI keystroke sequences.",
        "Must validate pending prompt identity + timestamp unchanged.",
        "Fail closed when preconditions are unmet (Focus required).",
        "orchestration reply is a different subsystem and must not be used as a substitute.",
      ],
    },
  };
}

export function buildCapabilityInspection(input: {
  status?: OrcaStatusResult | null;
  commands: readonly CommandSpec[];
  inspectedAt?: string;
}): CapabilityInspection {
  const runtimeCapabilities = input.status?.runtime?.capabilities ?? [];
  const names = input.commands.map((c) => c.command);
  const terminalCmds = names.filter((c) => c === "terminal" || c.startsWith("terminal ")).sort();
  const worktreeCmds = names.filter((c) => c === "worktree" || c.startsWith("worktree ")).sort();
  const allTerminalRelated = names
    .filter(
      (c) =>
        c.includes("terminal") ||
        c.includes("query") ||
        c.includes("reply") ||
        c.startsWith("orchestration"),
    )
    .sort();

  const structuredReply = evaluateStructuredReply({
    runtimeCapabilities,
    publicCommands: names,
  });
  const has = (name: string) => names.includes(name);
  const blockers: CapabilityBlocker[] = [];
  if (!structuredReply.usableViaPublicCli) {
    blockers.push({
      id: "structured_reply_public_cli_missing",
      severity: "blocking",
      message: structuredReply.detail,
    });
  }
  if (!has("worktree ps")) {
    blockers.push({
      id: "worktree_ps_missing",
      severity: "blocking",
      message: "Public CLI missing worktree ps — discovery cannot run.",
    });
  }
  if (!has("terminal list")) {
    blockers.push({
      id: "terminal_list_missing",
      severity: "blocking",
      message: "Public CLI missing terminal list — join cannot run.",
    });
  }

  return {
    inspectedAt: input.inspectedAt ?? new Date().toISOString(),
    orcaAppVersion: input.status?.runtime?.appVersion,
    runtimeId: input.status?.runtime?.runtimeId,
    runtimeCapabilities: [...runtimeCapabilities],
    publicCommands: { terminal: terminalCmds, worktree: worktreeCmds, allTerminalRelated },
    structuredReply,
    readOnlyDiscovery: {
      status: has("status"),
      worktreePs: has("worktree ps"),
      terminalList: has("terminal list"),
    },
    mutationsAvailable: {
      terminalSend: has("terminal send"),
      terminalSwitch: has("terminal switch") || has("terminal focus"),
      terminalClose: has("terminal close"),
      terminalInterrupt: has("terminal send"),
    },
    blockers,
  };
}

export async function inspectLiveCapabilities(
  options: OrcaCliOptions = {},
): Promise<CapabilityInspection> {
  const statusRaw = await runOrcaJson(["status"], options);
  const statusDecoded = decodeStatusEnvelope(statusRaw.json);
  const status = statusDecoded.ok ? statusDecoded.value.result : undefined;
  const ctxRaw = await runOrcaJson(["agent-context"], options);
  return buildCapabilityInspection({ status, commands: extractCommands(ctxRaw.json) });
}

export type StructuredReplyRequest = {
  terminalHandle: string;
  optionId: string;
  promptIdentity: string;
  promptStartedAt: number;
};

export function createStructuredReplyClient(
  inspection: Pick<CapabilityInspection, "structuredReply">,
) {
  return {
    isAvailable() {
      return inspection.structuredReply.usableViaPublicCli;
    },
    async reply(_req: StructuredReplyRequest): Promise<never> {
      throw new Error(
        `structured_reply_unavailable: ${inspection.structuredReply.status} — ${inspection.structuredReply.detail}`,
      );
    },
  };
}
