/**
 * Inspect public Orca CLI capabilities. Read-only. Never mutates terminals.
 */
import { inspectLiveCapabilities } from "../plugin/src/orca/capabilities.js";
import type { OrcaCliOptions } from "../plugin/src/orca/cli.js";

function cliOptions(): OrcaCliOptions {
  return {
    executable: process.env.ORCA_EXECUTABLE ?? "orca",
    timeoutMs: Number(process.env.ORCA_CLI_TIMEOUT_MS ?? 12_000),
  };
}

async function main(): Promise<void> {
  const inspection = await inspectLiveCapabilities(cliOptions());
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(inspection, null, 2));
  if (inspection.blockers.some((b) => b.severity === "blocking")) {
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
