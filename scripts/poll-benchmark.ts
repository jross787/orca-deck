/**
 * Measure worktree ps / terminal list latency, payload size, and optional CPU.
 * Read-only CLI only. Does not persist terminal content.
 *
 * Failed samples (non-zero exit or envelope.ok !== true) are excluded from
 * success percentiles and reported separately; any failure makes report.ok false.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  READ_ONLY_COMMANDS,
  type OrcaCliOptions,
} from "../plugin/src/orca/cli.js";
import { assertSafeFixtureJson } from "../plugin/src/orca/redact.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export type CpuCost = {
  userSeconds: number;
  systemSeconds: number;
  source: "usr_bin_time_lp";
};

export type BenchSample = {
  command: string;
  durationMs: number;
  stdoutBytes: number;
  exitCode: number | null;
  ok: boolean;
  failureReason?: string;
  cpu?: CpuCost;
};

export type CommandSummary = {
  command: string;
  successCount: number;
  failureCount: number;
  durationMs: { min: number; p50: number; p95: number; max: number } | null;
  stdoutBytes: { min: number; p50: number; max: number } | null;
  cpu?: {
    userSeconds: { min: number; p50: number; max: number };
    systemSeconds: { min: number; p50: number; max: number };
  } | null;
  failures: Array<{ exitCode: number | null; failureReason?: string; durationMs: number }>;
};

export type BenchReport = {
  ok: boolean;
  measuredAt: string;
  iterations: number;
  cadenceMs: number;
  note: string;
  cpuMeasurement: "usr_bin_time_lp" | "unavailable";
  summary: CommandSummary[];
  totals: { samples: number; successes: number; failures: number };
};

function cliOptions(): OrcaCliOptions {
  return {
    executable: process.env.ORCA_EXECUTABLE ?? "orca",
    timeoutMs: Number(process.env.ORCA_CLI_TIMEOUT_MS ?? 12_000),
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function stats(values: number[]): { min: number; p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0]!,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
  };
}

function sizeStats(values: number[]): { min: number; p50: number; max: number } | null {
  const full = stats(values);
  if (!full) return null;
  return { min: full.min, p50: full.p50, max: full.max };
}

/** Parse macOS/BSD `time -lp` stderr for user/sys seconds. */
export function parseTimeLpStderr(stderr: string): CpuCost | undefined {
  const user = stderr.match(/^\s*user\s+([0-9.]+)\s*$/m);
  const sys = stderr.match(/^\s*sys\s+([0-9.]+)\s*$/m);
  if (!user || !sys) return undefined;
  const userSeconds = Number(user[1]);
  const systemSeconds = Number(sys[1]);
  if (!Number.isFinite(userSeconds) || !Number.isFinite(systemSeconds)) return undefined;
  return { userSeconds, systemSeconds, source: "usr_bin_time_lp" };
}

/**
 * Classify a CLI sample. Failures: non-zero exit, empty stdout, invalid JSON,
 * or envelope.ok !== true. Successful percentiles must exclude these.
 */
export function classifyBenchSample(input: {
  command: string;
  durationMs: number;
  stdout: string;
  exitCode: number | null;
  cpu?: CpuCost;
}): BenchSample {
  const stdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const base = {
    command: input.command,
    durationMs: input.durationMs,
    stdoutBytes,
    exitCode: input.exitCode,
    cpu: input.cpu,
  };

  if (input.exitCode !== 0 && input.exitCode !== null) {
    return { ...base, ok: false, failureReason: `non_zero_exit:${String(input.exitCode)}` };
  }
  if (input.exitCode === null) {
    return { ...base, ok: false, failureReason: "null_exit_code" };
  }

  const trimmed = input.stdout.trim();
  if (trimmed.length === 0) {
    return { ...base, ok: false, failureReason: "empty_stdout" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ...base, ok: false, failureReason: "invalid_json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...base, ok: false, failureReason: "envelope_not_object" };
  }

  const envelope = parsed as { ok?: unknown };
  if (envelope.ok !== true) {
    return { ...base, ok: false, failureReason: "envelope_ok_not_true" };
  }

  return { ...base, ok: true };
}

export function aggregateBenchSamples(input: {
  samples: readonly BenchSample[];
  iterations: number;
  cadenceMs: number;
  measuredAt?: string;
  cpuMeasurement: BenchReport["cpuMeasurement"];
}): BenchReport {
  const byCommand = new Map<string, BenchSample[]>();
  for (const s of input.samples) {
    const list = byCommand.get(s.command) ?? [];
    list.push(s);
    byCommand.set(s.command, list);
  }

  const summary: CommandSummary[] = [...byCommand.entries()].map(([command, list]) => {
    const successes = list.filter((s) => s.ok);
    const failures = list.filter((s) => !s.ok);
    const cpuUsers = successes.map((s) => s.cpu?.userSeconds).filter((n): n is number => n != null);
    const cpuSys = successes.map((s) => s.cpu?.systemSeconds).filter((n): n is number => n != null);
    let cpu: CommandSummary["cpu"] = null;
    if (cpuUsers.length > 0 && cpuSys.length > 0) {
      const u = sizeStats(cpuUsers);
      const sy = sizeStats(cpuSys);
      if (u && sy) cpu = { userSeconds: u, systemSeconds: sy };
    }
    return {
      command,
      successCount: successes.length,
      failureCount: failures.length,
      durationMs: stats(successes.map((s) => s.durationMs)),
      stdoutBytes: sizeStats(successes.map((s) => s.stdoutBytes)),
      cpu,
      failures: failures.map((f) => ({
        exitCode: f.exitCode,
        failureReason: f.failureReason,
        durationMs: f.durationMs,
      })),
    };
  });

  const successes = input.samples.filter((s) => s.ok).length;
  const failures = input.samples.length - successes;

  return {
    ok: failures === 0,
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    iterations: input.iterations,
    cadenceMs: input.cadenceMs,
    note:
      "Metadata-only benchmark; stdout content not persisted. Failures excluded from success percentiles.",
    cpuMeasurement: input.cpuMeasurement,
    summary,
    totals: { samples: input.samples.length, successes, failures },
  };
}

async function runTimedSample(
  executable: string,
  args: readonly string[],
  opts: OrcaCliOptions,
  preferTimeLp: boolean,
): Promise<{ stdout: string; exitCode: number | null; durationMs: number; cpu?: CpuCost }> {
  const argv = args.includes("--json") ? [...args] : [...args, "--json"];
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const started = performance.now();

  if (preferTimeLp) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "/usr/bin/time",
        ["-lp", executable, ...argv],
        {
          timeout: timeoutMs,
          maxBuffer: opts.maxBufferBytes ?? 8 * 1024 * 1024,
          encoding: "utf8",
          env: opts.env ?? process.env,
          cwd: opts.cwd,
          shell: false,
          killSignal: "SIGTERM",
        },
      );
      return {
        stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
        exitCode: 0,
        durationMs: performance.now() - started,
        cpu: parseTimeLpStderr(typeof stderr === "string" ? stderr : String(stderr ?? "")),
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        killed?: boolean;
        code?: string | number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        status?: number | null;
      };
      if (e.code === "ENOENT") {
        // /usr/bin/time missing — fall through to direct exec.
      } else {
        const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout ? String(e.stdout) : "";
        const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? String(e.stderr) : "";
        const exitCode =
          typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : null;
        return {
          stdout,
          exitCode,
          durationMs: performance.now() - started,
          cpu: parseTimeLpStderr(stderr),
        };
      }
    }
  }

  try {
    const { stdout } = await execFileAsync(executable, argv, {
      timeout: timeoutMs,
      maxBuffer: opts.maxBufferBytes ?? 8 * 1024 * 1024,
      encoding: "utf8",
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: false,
      killSignal: "SIGTERM",
    });
    return {
      stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
      exitCode: 0,
      durationMs: performance.now() - started,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string | Buffer;
      status?: number | null;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout ? String(e.stdout) : "";
    const exitCode =
      typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : null;
    return { stdout, exitCode, durationMs: performance.now() - started };
  }
}

async function main(): Promise<void> {
  const opts = cliOptions();
  const executable = opts.executable ?? "orca";
  const iterations = Math.max(1, Number(process.env.ORCA_BENCH_ITERS ?? 8));
  const cadenceMs = Math.max(0, Number(process.env.ORCA_BENCH_CADENCE_MS ?? 2000));
  const writeOut = process.env.ORCA_BENCH_WRITE === "1";
  const preferTimeLp = process.env.ORCA_BENCH_NO_TIME !== "1";

  const commands = [
    { name: "status", args: READ_ONLY_COMMANDS.status },
    { name: "worktree ps", args: READ_ONLY_COMMANDS.worktreePs },
    { name: "terminal list", args: READ_ONLY_COMMANDS.terminalList },
  ] as const;

  const samples: BenchSample[] = [];
  let sawCpu = false;

  for (let i = 0; i < iterations; i += 1) {
    for (const c of commands) {
      const raw = await runTimedSample(executable, c.args, opts, preferTimeLp);
      if (raw.cpu) sawCpu = true;
      samples.push(
        classifyBenchSample({
          command: c.args.join(" "),
          durationMs: raw.durationMs,
          stdout: raw.stdout,
          exitCode: raw.exitCode,
          cpu: raw.cpu,
        }),
      );
    }
    if (i < iterations - 1 && cadenceMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, cadenceMs);
      });
    }
  }

  const report = aggregateBenchSamples({
    samples,
    iterations,
    cadenceMs,
    cpuMeasurement: sawCpu ? "usr_bin_time_lp" : "unavailable",
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assertSafeFixtureJson(serialized);
  // eslint-disable-next-line no-console
  console.log(serialized.trimEnd());

  if (writeOut) {
    const outDir = path.join(ROOT, ".benchmark-out");
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `poll-${Date.now()}.json`);
    await writeFile(outPath, serialized, "utf8");
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ wrote: path.relative(ROOT, outPath) }));
  }

  if (!report.ok) process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  });
}
