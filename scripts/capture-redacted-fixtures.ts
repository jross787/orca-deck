/**
 * Capture live Orca status/worktree ps/terminal list, redact, and persist.
 * Read-only CLI only. Never runs focus/send/interrupt/close.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_ONLY_COMMANDS,
  runOrcaJson,
  type OrcaCliOptions,
} from "../plugin/src/orca/cli.js";
import {
  assertSafeFixtureJson,
  buildRedactedFixture,
} from "../plugin/src/orca/redact.js";
import {
  decodeStatusEnvelope,
  decodeTerminalListEnvelope,
  decodeWorktreePsEnvelope,
  type OrcaEnvelope,
  type OrcaStatusResult,
  type OrcaTerminalListResult,
  type OrcaWorktreePsResult,
} from "../plugin/src/orca/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "fixtures", "orca", "observed");

function cliOptions(): OrcaCliOptions {
  return {
    executable: process.env.ORCA_EXECUTABLE ?? "orca",
    timeoutMs: Number(process.env.ORCA_CLI_TIMEOUT_MS ?? 12_000),
  };
}

function scenarioSlug(raw: string | undefined): string {
  const base = (raw ?? `live-${new Date().toISOString()}`).toLowerCase();
  return base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "live";
}

async function main(): Promise<void> {
  const opts = cliOptions();
  const scenario = scenarioSlug(process.env.ORCA_FIXTURE_SCENARIO);

  const statusRaw = await runOrcaJson(READ_ONLY_COMMANDS.status, opts);
  const psRaw = await runOrcaJson(READ_ONLY_COMMANDS.worktreePs, opts);
  const termRaw = await runOrcaJson(READ_ONLY_COMMANDS.terminalList, opts);

  const statusDec = decodeStatusEnvelope(statusRaw.json);
  const psDec = decodeWorktreePsEnvelope(psRaw.json);
  const termDec = decodeTerminalListEnvelope(termRaw.json);

  if (!statusDec.ok) {
    throw new Error(`status decode failed: ${statusDec.issues.map((i) => i.message).join("; ")}`);
  }
  if (!psDec.ok) {
    throw new Error(`worktree ps decode failed: ${psDec.issues.map((i) => i.message).join("; ")}`);
  }
  if (!termDec.ok) {
    throw new Error(
      `terminal list decode failed: ${termDec.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const bundle = buildRedactedFixture({
    provenance: "observed",
    scenario,
    status: statusDec.value as OrcaEnvelope<OrcaStatusResult>,
    worktreePs: psDec.value as OrcaEnvelope<OrcaWorktreePsResult>,
    terminalList: termDec.value as OrcaEnvelope<OrcaTerminalListResult>,
    capturedAt: new Date().toISOString(),
    orcaAppVersion: statusDec.value.result?.runtime?.appVersion,
    notes: [
      "Observed via public read-only CLI (status, worktree ps, terminal list).",
      "Redacted before disk write; handles/paths/prompts stripped.",
      `statusMs=${Math.round(statusRaw.meta.durationMs)} psMs=${Math.round(psRaw.meta.durationMs)} terminalListMs=${Math.round(termRaw.meta.durationMs)}`,
    ],
  });

  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  assertSafeFixtureJson(serialized);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${scenario}.json`);
  await writeFile(outPath, serialized, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        path: path.relative(ROOT, outPath),
        provenance: "observed",
        scenario,
        worktreeCount: bundle.worktreePs.result?.worktrees.length ?? 0,
        terminalCount: bundle.terminalList.result?.terminals.length ?? 0,
        agentCount:
          bundle.worktreePs.result?.worktrees.reduce((n, w) => n + w.agents.length, 0) ?? 0,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
