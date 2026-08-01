import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeStatusEnvelope,
  decodeTerminalListEnvelope,
  decodeWorktreePsEnvelope,
  normalizeAgentState,
  normalizeAgentType,
  paneKeyFromTerminal,
  SCHEMA_VERSION,
} from "../../plugin/src/orca/schema.js";
import { assertSafeFixtureJson, buildRedactedFixture } from "../../plugin/src/orca/redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../fixtures/orca");

async function loadJson(rel: string): Promise<unknown> {
  const raw = await readFile(path.join(FIXTURE_ROOT, rel), "utf8");
  return JSON.parse(raw) as unknown;
}

describe("normalizeAgentState / type", () => {
  it("maps known states and interrupted→error", () => {
    assert.equal(normalizeAgentState("working"), "working");
    assert.equal(normalizeAgentState("WAITING"), "waiting");
    assert.equal(normalizeAgentState("interrupted"), "error");
    assert.equal(normalizeAgentState("compiling_widgets"), "unknown");
    assert.equal(normalizeAgentState(""), "unknown");
    assert.equal(normalizeAgentState(null), "unknown");
  });

  it("normalizes known agent types and preserves unknowns", () => {
    assert.equal(normalizeAgentType("OMP"), "omp");
    assert.equal(normalizeAgentType("claude"), "claude");
    assert.equal(normalizeAgentType("codex"), "codex");
    assert.equal(normalizeAgentType("future-bot"), "future-bot");
    assert.equal(normalizeAgentType(""), "unknown");
  });

  it("builds pane keys as tabId:leafId", () => {
    assert.equal(paneKeyFromTerminal("tab_a", "leaf_w"), "tab_a:leaf_w");
  });
});

describe("fixture inventory and safety", () => {
  it("manifest lists synthetic fixtures with explicit provenance", async () => {
    const manifest = (await loadJson("manifest.json")) as {
      schemaVersion: string;
      fixtures: Array<{ path: string; provenance: string; scenario: string }>;
    };
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.ok(manifest.fixtures.length >= 5);
    for (const f of manifest.fixtures) {
      assert.equal(f.provenance, "synthetic");
      const body = (await loadJson(f.path)) as {
        meta: { provenance: string; scenario: string; schemaVersion: string };
      };
      assert.equal(body.meta.provenance, "synthetic");
      assert.equal(body.meta.scenario, f.scenario);
      assert.equal(body.meta.schemaVersion, SCHEMA_VERSION);
      const serialized = JSON.stringify(body);
      assertSafeFixtureJson(serialized);
      assert.equal(/"prompt"\s*:/.test(serialized), false);
      assert.equal(/"toolInput"\s*:/.test(serialized), false);
      assert.equal(/\/Users\//.test(serialized), false);
    }
  });

  it("synthetic directory only contains redacted bundles", async () => {
    const dir = path.join(FIXTURE_ROOT, "synthetic");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 5);
    for (const file of files) {
      const raw = await readFile(path.join(dir, file), "utf8");
      assertSafeFixtureJson(raw);
    }
  });
});

describe("tolerant decoders", () => {
  it("decodes unknown-field raw payloads and maps unknown state", () => {
    const status = decodeStatusEnvelope({
      ok: true,
      id: "env_status_unknown",
      result: {
        app: { running: true, pid: 1, desktopWindowStatus: "visible", newAppField: true },
        runtime: {
          state: "ready",
          reachable: true,
          runtimeId: "rt_synth_unknown",
          appVersion: "1.4.159",
          capabilities: ["terminal.query-reply-input.v1", "future.cap.v9"],
          futureRuntimeFlag: 42,
        },
        graph: { state: "ready" },
        extraTop: "tolerate-me",
      },
    });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.ok(
      status.unknownFieldPaths.some(
        (p) => p.includes("futureRuntimeFlag") || p.includes("extraTop") || p.includes("newAppField"),
      ),
    );

    const ps = decodeWorktreePsEnvelope({
      ok: true,
      id: "env_ps_unknown",
      result: {
        worktrees: [
          {
            worktreeId: "future-repo::main",
            hostId: "local",
            repo: "future-repo",
            futureWorktreeField: "x",
            agents: [
              {
                paneKey: "tab_f:leaf_1",
                state: "compiling_widgets",
                agentType: "omp",
                futureAgentField: 1,
                stateStartedAt: 1754000500000,
                updatedAt: 1754000500500,
              },
            ],
          },
        ],
        totalCount: 1,
        futurePsField: true,
      },
    });
    assert.equal(ps.ok, true);
    if (!ps.ok) return;
    const agent = ps.value.result?.worktrees[0]?.agents?.[0];
    assert.ok(agent);
    assert.equal(normalizeAgentState(agent!.state), "unknown");
    assert.ok(ps.unknownFieldPaths.some((p) => p.includes("future")));

    const terms = decodeTerminalListEnvelope({
      ok: true,
      id: "env_term_unknown",
      result: {
        terminals: [
          {
            handle: "fixture_handle_0",
            worktreeId: "future-repo::main",
            tabId: "tab_f",
            leafId: "leaf_1",
            connected: true,
            writable: true,
            futureTerminalField: "y",
          },
        ],
        futureListField: [],
      },
    });
    assert.equal(terms.ok, true);
    if (!terms.ok) return;
    assert.equal(terms.value.result?.terminals[0]?.tabId, "tab_f");
    assert.ok(terms.unknownFieldPaths.some((p) => p.includes("future")));
  });

  it("buildRedactedFixture strips content-bearing fields", () => {
    const bundle = buildRedactedFixture({
      provenance: "synthetic",
      scenario: "unit-redact",
      status: {
        ok: true,
        id: "secret-id",
        result: {
          app: { running: true, pid: 9 },
          runtime: {
            state: "ready",
            reachable: true,
            runtimeId: "rt",
            appVersion: "1.4.159",
            capabilities: ["terminal.query-reply-input.v1"],
          },
        },
      },
      worktreePs: {
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: "demo::main",
              hostId: "local",
              path: "/Users/someone/secret-project",
              preview: "SECRET PREVIEW",
              agents: [
                {
                  paneKey: "t:l",
                  state: "waiting",
                  agentType: "omp",
                  prompt: "do not store",
                  toolInput: { cmd: "rm -rf" },
                  lastAssistantMessage: "nope",
                },
              ],
            },
          ],
        },
      },
      terminalList: {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_live_abc",
              worktreeId: "demo::main",
              tabId: "t",
              leafId: "l",
              title: "secret title",
              preview: "terminal text",
              worktreePath: "/Users/someone/secret-project",
              connected: true,
              writable: true,
            },
          ],
        },
      },
    });

    const serialized = JSON.stringify(bundle);
    assertSafeFixtureJson(serialized);
    assert.equal(bundle.meta.provenance, "synthetic");
    assert.equal(bundle.worktreePs.result?.worktrees[0]?.agents[0]?.hasPrompt, true);
    assert.equal(bundle.worktreePs.result?.worktrees[0]?.agents[0]?.hasToolInput, true);
    assert.match(bundle.worktreePs.result?.worktrees[0]?.pathPlaceholder ?? "", /redacted-path/);
    assert.match(bundle.terminalList.result?.terminals[0]?.handlePlaceholder ?? "", /redacted-handle/);
    assert.equal(/"prompt"\s*:/.test(serialized), false);
    assert.equal(/term_live_/.test(serialized), false);
    assert.equal(/\/Users\//.test(serialized), false);
  });

  it("maps path-bearing worktreeIds so capture serialization stays safe and joins match", () => {
    const rawWorktreeId = "repo-id::/Users/frank/secret-project";
    const bundle = buildRedactedFixture({
      provenance: "synthetic",
      scenario: "path-bearing-worktree-id",
      worktreePs: {
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: rawWorktreeId,
              hostId: "local",
              repo: "/Users/frank/secret-project",
              path: "/Users/frank/secret-project",
              displayName: "/Users/frank/secret-project",
              agents: [
                {
                  paneKey: "tab_p:leaf_1",
                  state: "working",
                  agentType: "omp",
                },
              ],
            },
          ],
        },
      },
      terminalList: {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_live_path",
              worktreeId: rawWorktreeId,
              tabId: "tab_p",
              leafId: "leaf_1",
              connected: true,
              writable: true,
              worktreePath: "/Users/frank/secret-project",
            },
          ],
        },
      },
    });

    const wtId = bundle.worktreePs.result?.worktrees[0]?.worktreeId;
    const termId = bundle.terminalList.result?.terminals[0]?.worktreeId;
    assert.equal(typeof wtId, "string");
    assert.equal(wtId, termId);
    assert.equal(wtId, "wt_0");
    assert.notEqual(wtId, rawWorktreeId);

    const serialized = JSON.stringify(bundle);
    assertSafeFixtureJson(serialized);
    assert.equal(serialized.includes("/Users/"), false);
    assert.equal(serialized.includes(rawWorktreeId), false);
    assert.match(bundle.worktreePs.result?.worktrees[0]?.pathPlaceholder ?? "", /^<redacted-path:#0>$/);
  });
});
