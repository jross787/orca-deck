/**
 * Public Orca health/capability checks for the Phase 1 Health action.
 * Unknown/incompatible schema → visible disabled health, never idle/ready.
 */
import {
  buildCapabilityInspection,
  type CapabilityInspection,
  type CommandSpec,
} from "../orca/capabilities.js";
import {
  OrcaCliError,
  READ_ONLY_COMMANDS,
  runOrcaJson,
  type OrcaCliOptions,
  type OrcaCliResult,
} from "../orca/cli.js";
import {
  decodeStatusEnvelope,
  SCHEMA_VERSION,
  type OrcaStatusResult,
} from "../orca/schema.js";
import {
  commandNameFromArgs,
  exitClassFromCliErrorCode,
  type ExitClass,
  type RedactedLogger,
} from "../diagnostics/logger.js";

export type HealthState = "ready" | "unavailable" | "incompatible" | "error";

export type HealthCheckResult = {
  id: string;
  label: string;
  ok: boolean | null;
  detail: string;
  durationMs?: number;
  exitClass?: ExitClass;
};

export type HealthSnapshot = {
  state: HealthState;
  detail: string;
  checkedAt: string;
  schemaVersion: string;
  orcaAppVersion?: string;
  runtimeId?: string;
  runtimeState?: string;
  checks: HealthCheckResult[];
  capability?: Pick<
    CapabilityInspection,
    "structuredReply" | "readOnlyDiscovery" | "blockers" | "runtimeCapabilities"
  >;
  configError?: string;
};

export type HealthCheckOptions = {
  cli?: OrcaCliOptions;
  logger?: RedactedLogger;
  configError?: string;
  now?: () => Date;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractCommands(json: unknown): CommandSpec[] {
  if (Array.isArray(json)) {
    return json.filter(
      (v): v is CommandSpec =>
        isObject(v) && typeof v.command === "string" && Array.isArray(v.path),
    );
  }
  if (isObject(json)) {
    const result = "result" in json ? json.result : json;
    if (Array.isArray(result)) {
      return result.filter(
        (v): v is CommandSpec =>
          isObject(v) && typeof v.command === "string" && Array.isArray(v.path),
      );
    }
    if (isObject(result) && Array.isArray(result.commands)) {
      return result.commands.filter(
        (v): v is CommandSpec =>
          isObject(v) && typeof v.command === "string" && Array.isArray(v.path),
      );
    }
  }
  return [];
}

type CliAttempt<T> =
  | { ok: true; json: T; meta: OrcaCliResult; command: string }
  | {
      ok: false;
      command: string;
      exitClass: ExitClass;
      durationMs: number;
      detail: string;
      code?: string;
    };

async function attemptJson(
  args: readonly string[],
  options: OrcaCliOptions,
  logger: RedactedLogger | undefined,
): Promise<CliAttempt<unknown>> {
  const command = commandNameFromArgs(args);
  const started = performance.now();
  try {
    const { json, meta } = await runOrcaJson(args, options);
    logger?.commandResult({
      command,
      durationMs: meta.durationMs,
      exitClass: "ok",
      schemaVersion: SCHEMA_VERSION,
    });
    return { ok: true, json, meta, command };
  } catch (err) {
    const durationMs = performance.now() - started;
    if (err instanceof OrcaCliError) {
      const exitClass = exitClassFromCliErrorCode(err.code);
      logger?.commandResult({
        command,
        durationMs,
        exitClass,
        schemaVersion: SCHEMA_VERSION,
        fields: { errorCode: err.code },
      });
      return {
        ok: false,
        command,
        exitClass,
        durationMs,
        detail: err.message,
        code: err.code,
      };
    }
    logger?.commandResult({
      command,
      durationMs,
      exitClass: "error",
      schemaVersion: SCHEMA_VERSION,
    });
    return {
      ok: false,
      command,
      exitClass: "error",
      durationMs,
      detail: "unexpected CLI failure",
    };
  }
}

/**
 * Map Orca status + hooks + agent-context into a HealthSnapshot.
 * Pure mapping helper for tests (no CLI).
 */
export function mapHealthSnapshot(input: {
  status?: OrcaStatusResult | null;
  statusOk?: boolean;
  statusDecodeOk?: boolean;
  hooks?: {
    ok: boolean;
    enabled?: boolean;
    detail?: string;
    decodeOk?: boolean;
  } | null;
  inspection?: CapabilityInspection | null;
  configError?: string;
  checkedAt?: string;
  checks?: HealthCheckResult[];
}): HealthSnapshot {
  const checks = input.checks ?? [];
  const checkedAt = input.checkedAt ?? new Date().toISOString();

  if (input.configError) {
    return {
      state: "error",
      detail: input.configError,
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      checks,
      configError: input.configError,
      capability: input.inspection
        ? {
            structuredReply: input.inspection.structuredReply,
            readOnlyDiscovery: input.inspection.readOnlyDiscovery,
            blockers: input.inspection.blockers,
            runtimeCapabilities: input.inspection.runtimeCapabilities,
          }
        : undefined,
    };
  }

  if (input.statusDecodeOk === false || input.hooks?.decodeOk === false) {
    return {
      state: "incompatible",
      detail: "Orca JSON schema is unknown or incompatible with this plugin.",
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      orcaAppVersion: input.status?.runtime?.appVersion,
      runtimeId: input.status?.runtime?.runtimeId,
      runtimeState: input.status?.runtime?.state,
      checks,
      capability: input.inspection
        ? {
            structuredReply: input.inspection.structuredReply,
            readOnlyDiscovery: input.inspection.readOnlyDiscovery,
            blockers: input.inspection.blockers,
            runtimeCapabilities: input.inspection.runtimeCapabilities,
          }
        : undefined,
    };
  }

  if (!input.status || input.statusOk === false) {
    return {
      state: "unavailable",
      detail: "Orca runtime is unavailable.",
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      checks,
      capability: input.inspection
        ? {
            structuredReply: input.inspection.structuredReply,
            readOnlyDiscovery: input.inspection.readOnlyDiscovery,
            blockers: input.inspection.blockers,
            runtimeCapabilities: input.inspection.runtimeCapabilities,
          }
        : undefined,
    };
  }

  const runtime = input.status.runtime;
  const reachable = runtime?.reachable === true;
  const state = (runtime?.state ?? "").toLowerCase();
  const appRunning = input.status.app?.running === true;
  const ready = reachable && appRunning && (state === "ready" || state === "running");

  if (!ready) {
    return {
      state: "unavailable",
      detail:
        runtime?.state != null
          ? `Orca runtime state is ${runtime.state}.`
          : "Orca runtime is not ready.",
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      orcaAppVersion: runtime?.appVersion,
      runtimeId: runtime?.runtimeId,
      runtimeState: runtime?.state,
      checks,
      capability: input.inspection
        ? {
            structuredReply: input.inspection.structuredReply,
            readOnlyDiscovery: input.inspection.readOnlyDiscovery,
            blockers: input.inspection.blockers,
            runtimeCapabilities: input.inspection.runtimeCapabilities,
          }
        : undefined,
    };
  }

  // Hooks are diagnostic, not a hard gate for ready — but surface failures.
  const hooksOk = input.hooks == null ? true : input.hooks.ok;
  if (!hooksOk) {
    return {
      state: "error",
      detail: input.hooks?.detail ?? "Orca agent hooks status failed.",
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      orcaAppVersion: runtime?.appVersion,
      runtimeId: runtime?.runtimeId,
      runtimeState: runtime?.state,
      checks,
      capability: input.inspection
        ? {
            structuredReply: input.inspection.structuredReply,
            readOnlyDiscovery: input.inspection.readOnlyDiscovery,
            blockers: input.inspection.blockers,
            runtimeCapabilities: input.inspection.runtimeCapabilities,
          }
        : undefined,
    };
  }

  const inspection = input.inspection;
  const discovery = inspection?.readOnlyDiscovery;
  if (
    inspection &&
    discovery &&
    (!discovery.status || !discovery.worktreePs || !discovery.terminalList)
  ) {
    return {
      state: "incompatible",
      detail: "Required public discovery commands are missing from agent-context.",
      checkedAt,
      schemaVersion: SCHEMA_VERSION,
      orcaAppVersion: runtime?.appVersion ?? inspection.orcaAppVersion,
      runtimeId: runtime?.runtimeId ?? inspection.runtimeId,
      runtimeState: runtime?.state,
      checks,
      capability: {
        structuredReply: inspection.structuredReply,
        readOnlyDiscovery: inspection.readOnlyDiscovery,
        blockers: inspection.blockers,
        runtimeCapabilities: inspection.runtimeCapabilities,
      },
    };
  }

  return {
    state: "ready",
    detail: "Orca runtime is ready.",
    checkedAt,
    schemaVersion: SCHEMA_VERSION,
    orcaAppVersion: runtime?.appVersion ?? input.inspection?.orcaAppVersion,
    runtimeId: runtime?.runtimeId ?? input.inspection?.runtimeId,
    runtimeState: runtime?.state,
    checks,
    capability: input.inspection
      ? {
          structuredReply: input.inspection.structuredReply,
          readOnlyDiscovery: input.inspection.readOnlyDiscovery,
          blockers: input.inspection.blockers,
          runtimeCapabilities: input.inspection.runtimeCapabilities,
        }
      : undefined,
  };
}

function decodeHooksStatus(json: unknown): {
  decodeOk: boolean;
  ok: boolean;
  enabled?: boolean;
  detail: string;
} {
  if (!isObject(json)) {
    return {
      decodeOk: false,
      ok: false,
      detail: "hooks status payload is not an object",
    };
  }
  if (typeof json.ok !== "boolean") {
    return {
      decodeOk: false,
      ok: false,
      detail: "hooks status missing boolean ok",
    };
  }
  const result = isObject(json.result) ? json.result : undefined;
  let enabled: boolean | undefined;
  if (result && typeof result.enabled === "boolean") {
    enabled = result.enabled;
  } else if (result && typeof result.installed === "boolean") {
    enabled = result.installed;
  }
  if (!json.ok) {
    return {
      decodeOk: true,
      ok: false,
      enabled,
      detail: "orca agent hooks status reported failure",
    };
  }
  return {
    decodeOk: true,
    ok: true,
    enabled,
    detail:
      enabled === false
        ? "Orca-managed hooks are not enabled."
        : enabled === true
          ? "Orca-managed hooks are enabled."
          : "Orca agent hooks status returned ok.",
  };
}

/**
 * Run live health checks via the shared Phase 0 CLI boundary.
 */
export async function checkOrcaHealth(options: HealthCheckOptions = {}): Promise<HealthSnapshot> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const checks: HealthCheckResult[] = [];
  const cli = options.cli ?? {};

  if (options.configError) {
    return mapHealthSnapshot({
      configError: options.configError,
      checkedAt,
      checks: [
        {
          id: "config",
          label: "Config",
          ok: false,
          detail: options.configError,
        },
      ],
    });
  }

  const statusAttempt = await attemptJson(READ_ONLY_COMMANDS.status, cli, options.logger);
  let status: OrcaStatusResult | null = null;
  let statusOk = false;
  let statusDecodeOk = true;

  if (!statusAttempt.ok) {
    checks.push({
      id: "status",
      label: "orca status",
      ok: false,
      detail: statusAttempt.detail,
      durationMs: Math.round(statusAttempt.durationMs),
      exitClass: statusAttempt.exitClass,
    });
  } else {
    const decoded = decodeStatusEnvelope(statusAttempt.json);
    statusDecodeOk = decoded.ok;
    statusOk = decoded.ok && decoded.value.ok === true;
    status = decoded.ok ? (decoded.value.result ?? null) : null;
    checks.push({
      id: "status",
      label: "orca status",
      ok: statusOk && statusDecodeOk,
      detail: !statusDecodeOk
        ? "status JSON failed schema decode"
        : statusOk
          ? `runtime ${status?.runtime?.state ?? "unknown"}`
          : "status envelope ok=false",
      durationMs: Math.round(statusAttempt.meta.durationMs),
      exitClass: "ok",
    });
  }

  const hooksAttempt = await attemptJson(
    READ_ONLY_COMMANDS.agentHooksStatus,
    cli,
    options.logger,
  );
  let hooks: {
    ok: boolean;
    enabled?: boolean;
    detail?: string;
    decodeOk?: boolean;
  } | null = null;

  if (!hooksAttempt.ok) {
    checks.push({
      id: "hooks",
      label: "orca agent hooks status",
      ok: false,
      detail: hooksAttempt.detail,
      durationMs: Math.round(hooksAttempt.durationMs),
      exitClass: hooksAttempt.exitClass,
    });
    hooks = {
      ok: false,
      decodeOk: true,
      detail: hooksAttempt.detail,
    };
  } else {
    const decodedHooks = decodeHooksStatus(hooksAttempt.json);
    hooks = decodedHooks;
    checks.push({
      id: "hooks",
      label: "orca agent hooks status",
      ok: decodedHooks.ok && decodedHooks.decodeOk,
      detail: decodedHooks.detail,
      durationMs: Math.round(hooksAttempt.meta.durationMs),
      exitClass: "ok",
    });
  }

  const ctxAttempt = await attemptJson(READ_ONLY_COMMANDS.agentContext, cli, options.logger);
  let inspection: CapabilityInspection | null = null;
  if (!ctxAttempt.ok) {
    checks.push({
      id: "agent-context",
      label: "orca agent-context",
      ok: false,
      detail: ctxAttempt.detail,
      durationMs: Math.round(ctxAttempt.durationMs),
      exitClass: ctxAttempt.exitClass,
    });
  } else {
    const commands = extractCommands(ctxAttempt.json);
    inspection = buildCapabilityInspection({
      status,
      commands,
      inspectedAt: checkedAt,
    });
    checks.push({
      id: "agent-context",
      label: "orca agent-context",
      ok: true,
      detail: `${commands.length} public commands`,
      durationMs: Math.round(ctxAttempt.meta.durationMs),
      exitClass: "ok",
    });
    checks.push({
      id: "structured-reply",
      label: "structured reply",
      ok: inspection.structuredReply.usableViaPublicCli,
      detail: inspection.structuredReply.status,
    });
  }

  if (!statusAttempt.ok) {
    return mapHealthSnapshot({
      status: null,
      statusOk: false,
      statusDecodeOk: true,
      hooks,
      inspection,
      checkedAt,
      checks,
    });
  }

  return mapHealthSnapshot({
    status,
    statusOk,
    statusDecodeOk,
    hooks,
    inspection,
    checkedAt,
    checks,
  });
}
