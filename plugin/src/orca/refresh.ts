/**
 * One shared discovery refresh: status + worktree ps + terminal list.
 * Decode with Phase 0 modules; join fail-closed.
 */

import {
  commandNameFromArgs,
  exitClassFromCliErrorCode,
  type RedactedLogger,
} from "../diagnostics/logger.js";
import {
  OrcaCliError,
  READ_ONLY_COMMANDS,
  runOrcaJson,
  type OrcaCliOptions,
} from "./cli.js";
import { joinDiscovery, type DiscoverySnapshot } from "./discovery.js";
import {
  decodeStatusEnvelope,
  decodeTerminalListEnvelope,
  decodeWorktreePsEnvelope,
  type OrcaStatusResult,
  type OrcaTerminalListResult,
  type OrcaWorktreePsResult,
} from "./schema.js";

export type DiscoveryRefreshResult =
  | { ok: true; snapshot: DiscoverySnapshot; durationMs: number }
  | {
      ok: false;
      snapshot: DiscoverySnapshot;
      durationMs: number;
      errorCode: string;
      detail: string;
    };

export type DiscoveryRefreshOptions = {
  cli?: OrcaCliOptions;
  logger?: RedactedLogger;
  nowMs?: () => number;
  /** Injected for tests. */
  runJson?: typeof runOrcaJson;
};

function emptySnapshot(nowMs: number, issues: string[]): DiscoverySnapshot {
  return {
    capturedAtMs: nowMs,
    orcaReady: false,
    capabilities: [],
    sessions: [],
    ignoredShellCount: 0,
    ambiguousCount: 0,
    issues,
  };
}

/**
 * Run the three read-only discovery commands and join.
 */
export async function refreshDiscovery(
  options: DiscoveryRefreshOptions = {},
): Promise<DiscoveryRefreshResult> {
  const nowMs = options.nowMs?.() ?? Date.now();
  const runJson = options.runJson ?? runOrcaJson;
  const cli = options.cli ?? {};
  const started = performance.now();
  const issues: string[] = [];

  let statusResult: OrcaStatusResult | null = null;
  let worktreePs: OrcaWorktreePsResult | null = null;
  let terminalList: OrcaTerminalListResult | null = null;

  const logMeta = (
    args: readonly string[],
    durationMs: number,
    exitClass: string,
  ): void => {
    options.logger?.info(
      "discovery_command",
      { durationMs, exitClass },
      { command: commandNameFromArgs(args) },
    );
  };

  try {
    const statusArgs = READ_ONLY_COMMANDS.status;
    try {
      const { json, meta } = await runJson([...statusArgs], cli);
      logMeta(statusArgs, meta.durationMs, "ok");
      const decoded = decodeStatusEnvelope(json);
      if (decoded.ok && decoded.value.result) statusResult = decoded.value.result;
      else {
        issues.push("status_decode_failed");
        options.logger?.warn("discovery_decode_failed", { command: "status" });
      }
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      logMeta(statusArgs, 0, exitClassFromCliErrorCode(code));
      issues.push(`status_${code}`);
    }

    const psArgs = READ_ONLY_COMMANDS.worktreePs;
    try {
      const { json, meta } = await runJson([...psArgs], cli);
      logMeta(psArgs, meta.durationMs, "ok");
      const decoded = decodeWorktreePsEnvelope(json);
      if (decoded.ok && decoded.value.result) worktreePs = decoded.value.result;
      else {
        issues.push("worktree_ps_decode_failed");
      }
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      logMeta(psArgs, 0, exitClassFromCliErrorCode(code));
      issues.push(`worktree_ps_${code}`);
    }

    const listArgs = READ_ONLY_COMMANDS.terminalList;
    try {
      const { json, meta } = await runJson([...listArgs], cli);
      logMeta(listArgs, meta.durationMs, "ok");
      const decoded = decodeTerminalListEnvelope(json);
      if (decoded.ok && decoded.value.result) terminalList = decoded.value.result;
      else {
        issues.push("terminal_list_decode_failed");
      }
    } catch (err) {
      const code = err instanceof OrcaCliError ? err.code : "error";
      logMeta(listArgs, 0, exitClassFromCliErrorCode(code));
      issues.push(`terminal_list_${code}`);
    }

    const durationMs = performance.now() - started;

    if (!worktreePs || !terminalList) {
      const snap = emptySnapshot(nowMs, issues);
      return {
        ok: false,
        snapshot: snap,
        durationMs,
        errorCode: "discovery_incomplete",
        detail: issues.join(",") || "discovery incomplete",
      };
    }

    const snapshot = joinDiscovery({
      status: statusResult,
      worktreePs,
      terminalList,
      nowMs,
    });
    snapshot.issues = [...snapshot.issues, ...issues];
    const ok = issues.length === 0 && snapshot.orcaReady;
    if (!ok) {
      return {
        ok: false,
        snapshot,
        durationMs,
        errorCode: snapshot.orcaReady ? "discovery_issues" : "orca_unavailable",
        detail: snapshot.issues.join(",") || "discovery issues",
      };
    }
    return { ok: true, snapshot, durationMs };
  } catch (err) {
    const durationMs = performance.now() - started;
    const detail = err instanceof Error ? err.message : "discovery failed";
    return {
      ok: false,
      snapshot: emptySnapshot(nowMs, [detail]),
      durationMs,
      errorCode: "discovery_failed",
      detail,
    };
  }
}
