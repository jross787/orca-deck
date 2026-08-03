/**
 * Exact public Orca argv builders for draft send and new-agent launch.
 * Never shell-interpolate. Never activate / terminal switch.
 */
import type { LaunchProvider } from "./protocol.js";

/** Exact selected-session send: fresh handle only, no switch/focus. */
export function buildDraftSendArgs(terminalHandle: string, draft: string): string[] {
  return ["terminal", "send", "--terminal", terminalHandle, "--text", draft, "--enter"];
}

export type LaunchTarget =
  | { kind: "projectHostSetup"; projectHostSetupId: string }
  | { kind: "repo"; repoId: string };

/**
 * Exact worktree create argv.
 * Prefer project-host-setup when discovery supplies it; else repo id.
 * Never --activate. Agent IDs are exact lowercase omp|claude|codex.
 */
export function buildWorktreeCreateArgs(input: {
  target: LaunchTarget;
  name: string;
  agent: LaunchProvider;
  prompt: string;
  parentWorktreeId: string;
}): string[] {
  const args: string[] = ["worktree", "create"];
  if (input.target.kind === "projectHostSetup") {
    args.push("--project-host-setup", input.target.projectHostSetupId);
  } else {
    args.push("--repo", `id:${input.target.repoId}`);
  }
  args.push(
    "--name",
    input.name,
    "--agent",
    input.agent,
    "--prompt",
    input.prompt,
    "--setup",
    "inherit",
    "--parent-worktree",
    `worktree:${input.parentWorktreeId}`,
  );
  return args;
}

export function isLaunchProvider(value: string): value is LaunchProvider {
  return value === "omp" || value === "claude" || value === "codex";
}
