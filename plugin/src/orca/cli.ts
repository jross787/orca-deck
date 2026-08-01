/**
 * Public Orca CLI invocation boundary.
 * Always uses execFile/spawn argument arrays — never shell interpolation.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OrcaCliOptions = {
  /** Absolute path or command name. Default: "orca" from PATH. */
  executable?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type OrcaCliResult = {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
};

export type OrcaCliErrorCode =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "invalid_json"
  | "empty_stdout";

export class OrcaCliError extends Error {
  readonly code: OrcaCliErrorCode;
  readonly argv: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    code: OrcaCliErrorCode,
    message: string,
    init: {
      argv: string[];
      exitCode?: number | null;
      stderr?: string;
      timedOut?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "OrcaCliError";
    this.code = code;
    this.argv = init.argv;
    this.exitCode = init.exitCode ?? null;
    this.stderr = init.stderr ?? "";
    this.timedOut = init.timedOut ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run `orca <args...>` with --json forced when not already present.
 * Returns raw stdout text; callers parse/decode.
 */
export async function runOrca(
  args: readonly string[],
  options: OrcaCliOptions = {},
): Promise<OrcaCliResult> {
  const executable = options.executable ?? process.env.ORCA_EXECUTABLE ?? "orca";
  const argv = args.includes("--json") ? [...args] : [...args, "--json"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();

  const execOpts: ExecFileOptions = {
    timeout: timeoutMs,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
    encoding: "utf8",
    env: options.env ?? process.env,
    cwd: options.cwd,
    // Never use a shell.
    shell: false,
    killSignal: "SIGTERM",
  };

  try {
    const { stdout, stderr } = await execFileAsync(executable, argv, execOpts);
    return {
      argv: [executable, ...argv],
      stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
      stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
      exitCode: 0,
      signal: null,
      durationMs: performance.now() - started,
      timedOut: false,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      code?: string | number;
      signal?: NodeJS.Signals;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
    };

    const timedOut =
      e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout ? String(e.stdout) : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? String(e.stderr) : "";
    const exitCode =
      typeof e.status === "number"
        ? e.status
        : typeof e.code === "number"
          ? e.code
          : null;

    if (e.code === "ENOENT") {
      throw new OrcaCliError("spawn_failed", `Orca executable not found: ${executable}`, {
        argv: [executable, ...argv],
        exitCode,
        stderr,
        timedOut: false,
        cause: err,
      });
    }

    if (timedOut) {
      throw new OrcaCliError("timeout", `Orca CLI timed out after ${timeoutMs}ms`, {
        argv: [executable, ...argv],
        exitCode,
        stderr,
        timedOut: true,
        cause: err,
      });
    }

    // Some Orca commands still emit JSON on non-zero; surface raw result if stdout present.
    if (stdout.trim().length > 0) {
      return {
        argv: [executable, ...argv],
        stdout,
        stderr,
        exitCode,
        signal: e.signal ?? null,
        durationMs: performance.now() - started,
        timedOut: false,
      };
    }

    throw new OrcaCliError("non_zero_exit", `Orca CLI exited with code ${String(exitCode)}`, {
      argv: [executable, ...argv],
      exitCode,
      stderr,
      timedOut: false,
      cause: err,
    });
  }
}

export async function runOrcaJson<T = unknown>(
  args: readonly string[],
  options: OrcaCliOptions = {},
): Promise<{ json: T; meta: OrcaCliResult }> {
  const meta = await runOrca(args, options);
  const trimmed = meta.stdout.trim();
  if (trimmed.length === 0) {
    throw new OrcaCliError("empty_stdout", "Orca CLI returned empty stdout", {
      argv: meta.argv,
      exitCode: meta.exitCode,
      stderr: meta.stderr,
    });
  }
  try {
    return { json: JSON.parse(trimmed) as T, meta };
  } catch (cause) {
    throw new OrcaCliError("invalid_json", "Orca CLI stdout was not valid JSON", {
      argv: meta.argv,
      exitCode: meta.exitCode,
      stderr: meta.stderr,
      cause,
    });
  }
}

/** Read-only discovery commands used by Phase 0 polling. */
export const READ_ONLY_COMMANDS = {
  status: ["status"] as const,
  worktreePs: ["worktree", "ps"] as const,
  terminalList: ["terminal", "list"] as const,
  agentContext: ["agent-context"] as const,
};

/** Mutation commands — never invoked by Phase 0 tooling. */
export const MUTATION_COMMANDS = {
  terminalSend: ["terminal", "send"] as const,
  terminalSwitch: ["terminal", "switch"] as const,
  terminalClose: ["terminal", "close"] as const,
  terminalInterrupt: ["terminal", "send", "--interrupt"] as const,
} as const;
