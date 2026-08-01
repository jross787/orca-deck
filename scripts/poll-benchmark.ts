/**
 * Measure worktree ps / terminal list latency and payload size.
 * Read-only CLI only. Does not persist terminal content.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_ONLY_COMMANDS,
  runOrca,
  type OrcaCliOptions,
} from "../plugin/src/orca/cli.js";
import { assertSafeFixtureJson } from "../plugin/src/orca/redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function cliOptions(): OrcaCliOptions {
  return {
    executable: process.env.ORCA_EXECUTABLE ?? "orca",
    timeoutMs: Number(process.env.ORCA_CLI_TIMEOUT_MS ?? 12_000),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

type Sample = {
  command: string;
  durationMs: number;
  stdoutBytes: number;
  exitCode: number | null;
};

async function sample(args: readonly string[], opts: OrcaCliOptions): Promise<Sample> {
  const result = await runOrca(args, opts);
  return {
    command: args.join(" "),
    durationMs: result.durationMs,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    exitCode: result.exitCode,
  };
}

async function main(): Promise<void> {
  const opts = cliOptions();
  const iterations = Math.max(1, Number(process.env.ORCA_BENCH_ITERS ?? 8));
  const cadenceMs = Math.max(0, Number(process.env.ORCA_BENCH_CADENCE_MS ?? 2000));
  const writeOut = process.env.ORCA_BENCH_WRITE === "1";

  const commands = [
    { name: "status", args: READ_ONLY_COMMANDS.status },
    { name: "worktree ps", args: READ_ONLY_COMMANDS.worktreePs },
    { name: "terminal list", args: READ_ONLY_COMMANDS.terminalList },
  ] as const;

  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i += 1) {
    for (const c of commands) {
      samples.push(await sample(c.args, opts));
    }
    if (i < iterations - 1 && cadenceMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, cadenceMs);
      });
    }
  }

  const byCommand = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = byCommand.get(s.command) ?? [];
    list.push(s);
    byCommand.set(s.command, list);
  }

  const summary = [...byCommand.entries()].map(([command, list]) => {
    const durations = list.map((s) => s.durationMs).sort((a, b) => a - b);
    const sizes = list.map((s) => s.stdoutBytes).sort((a, b) => a - b);
    return {
      command,
      iterations: list.length,
      durationMs: {
        min: durations[0] ?? 0,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations[durations.length - 1] ?? 0,
      },
      stdoutBytes: {
        min: sizes[0] ?? 0,
        p50: percentile(sizes, 50),
        max: sizes[sizes.length - 1] ?? 0,
      },
    };
  });

  const report = {
    ok: true,
    measuredAt: new Date().toISOString(),
    iterations,
    cadenceMs,
    note: "Metadata-only benchmark; stdout content not persisted.",
    summary,
  };

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
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
