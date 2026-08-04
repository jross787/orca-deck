import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL_EFFORT_UUID,
  USAGE_ACTION_UUIDS,
  USAGE_CLAUDE_UUID,
  USAGE_CODEX_UUID,
  USAGE_OMP_UUID,
} from "../../plugin/src/actions/usage.js";
import { ConfigStore, defaultConfig, resolveConfigPaths, validateConfig } from "../../plugin/src/config/store.js";
import { RedactedLogger } from "../../plugin/src/diagnostics/logger.js";
import { parsePiRequest, responseMatchesRequest } from "../../plugin/src/messaging/protocol.js";
import type { LogicalSession } from "../../plugin/src/orca/discovery.js";
import { joinDiscovery } from "../../plugin/src/orca/discovery.js";
import type { DiscoveryRefreshResult } from "../../plugin/src/orca/refresh.js";
import type { RuntimeTerminalHandle } from "../../plugin/src/orca/schema.js";
import { decodeWorktreePsEnvelope } from "../../plugin/src/orca/schema.js";
import { renderUsageSvg, usageSvgDataUrl } from "../../plugin/src/rendering/usage-svg.js";
import { MetadataStore } from "../../plugin/src/state/metadata-store.js";
import { DashboardRuntime } from "../../plugin/src/state/runtime.js";
import {
  assertSafeDiagnostics,
  buildDiagnosticsExport,
  opaqueSessionToken,
  sanitizeDetailCode,
  stringEmbedsFilesystemPath,
} from "../../plugin/src/usage/diagnostics.js";
import {
  countActiveOmp,
  extractPublicModelFields,
  formatModelEffortPrimary,
} from "../../plugin/src/usage/extract.js";
import {
  CLAUDE_USAGE_PROVENANCE,
  CODEX_USAGE_PROVENANCE,
  officialPayloadProviderUsageAdapter,
  unavailableProviderUsageAdapter,
} from "../../plugin/src/usage/providers.js";
import { buildUsageSnapshot } from "../../plugin/src/usage/snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "dev.onorca.agent-deck.sdPlugin");

function session(
  partial: Partial<LogicalSession> & Pick<LogicalSession, "logicalSessionId" | "worktreeId" | "paneKey">,
): LogicalSession {
  return {
    hostId: "local",
    worktreeUnread: false,
    agentType: "omp",
    rawState: "working",
    state: "working",
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_100,
    toolName: null,
    connected: true,
    writable: true,
    joinHealth: "ok",
    trackedAgentCountInWorktree: 1,
    ompChildCount: 0,
    runtimeHandle: "h1" as RuntimeTerminalHandle,
    repo: "repo",
    displayName: "wt",
    ...partial,
  };
}

describe("public model field extraction", () => {
  it("reads model/effort/contextUsage and leaves missing unavailable", () => {
    const full = extractPublicModelFields({
      model: "gpt-test",
      effort: "high",
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    });
    assert.equal(full.model, "gpt-test");
    assert.equal(full.effort, "high");
    assert.equal(full.contextPercent, 10);
    assert.equal(full.anyPresent, true);

    const empty = extractPublicModelFields({ state: "working", paneKey: "a:b" });
    assert.equal(empty.model, null);
    assert.equal(empty.effort, null);
    assert.equal(empty.anyPresent, false);
    assert.equal(formatModelEffortPrimary(empty), "UNAVAILABLE");
  });

  it("never treats unknown keys as account quota", () => {
    const f = extractPublicModelFields({ quotaRemaining: 99, billingPlan: "pro" });
    assert.equal(f.anyPresent, false);
  });
});

describe("usage snapshot unavailable/stale/value/source", () => {
  const t0 = 1_000_000;

  it("OMP count from public sessions; model only when present", () => {
    const sessions = [
      session({ logicalSessionId: "w:a", worktreeId: "w", paneKey: "a", agentType: "omp", model: "omp-m" }),
      session({ logicalSessionId: "w:b", worktreeId: "w", paneKey: "b", agentType: "claude" }),
      session({ logicalSessionId: "w:c", worktreeId: "w", paneKey: "c", agentType: "omp" }),
    ];
    assert.equal(countActiveOmp(sessions), 2);
    const snap = buildUsageSnapshot({
      sessions,
      selectedLogicalSessionId: "w:a",
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0 + 100,
      staleAfterMs: 5_000,
    });
    assert.equal(snap.faces.omp.freshness, "fresh");
    assert.match(snap.faces.omp.primary, /2/);
    assert.match(snap.faces.omp.primary, /omp-m/);
    assert.equal(snap.faces.omp.sourceObservedAtMs, t0);
    assert.notEqual(snap.faces.omp.metricKind, "provider_usage");
  });

  it("marks STALE when source observation is older than threshold", () => {
    const sessions = [session({ logicalSessionId: "w:a", worktreeId: "w", paneKey: "a" })];
    const snap = buildUsageSnapshot({
      sessions,
      selectedLogicalSessionId: "w:a",
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0 + 20_000,
      staleAfterMs: 5_000,
    });
    assert.equal(snap.faces.omp.freshness, "stale");
    assert.match(snap.faces.omp.secondary, /STALE/i);
    assert.equal(snap.faces.omp.sourceObservedAtMs, t0);
  });

  it("Claude/Codex fail closed UNAVAILABLE with provenance", () => {
    const snap = buildUsageSnapshot({
      sessions: [],
      selectedLogicalSessionId: null,
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0,
      providerUsage: unavailableProviderUsageAdapter,
    });
    assert.equal(snap.faces.claude.freshness, "unavailable");
    assert.equal(snap.faces.claude.primary, "UNAVAILABLE");
    assert.equal(snap.faces.claude.provenance, CLAUDE_USAGE_PROVENANCE);
    assert.equal(snap.faces.claude.sourceObservedAtMs, null);
    assert.equal(snap.faces.codex.freshness, "unavailable");
    assert.equal(snap.faces.codex.provenance, CODEX_USAGE_PROVENANCE);
  });

  it("model/effort display-only; missing stays UNAVAILABLE", () => {
    const withModel = buildUsageSnapshot({
      sessions: [
        session({
          logicalSessionId: "w:a",
          worktreeId: "w",
          paneKey: "a",
          agentType: "claude",
          model: "sonnet",
          effort: "max",
          updatedAt: t0,
        }),
      ],
      selectedLogicalSessionId: "w:a",
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0 + 50,
      staleAfterMs: 10_000,
    });
    assert.equal(withModel.faces["model-effort"].freshness, "fresh");
    assert.match(withModel.faces["model-effort"].primary, /sonnet/);
    assert.match(withModel.faces["model-effort"].primary, /max/);
    assert.equal(withModel.faces["model-effort"].metricKind, "model_effort");

    const none = buildUsageSnapshot({
      sessions: [session({ logicalSessionId: "w:a", worktreeId: "w", paneKey: "a" })],
      selectedLogicalSessionId: "w:a",
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0,
    });
    assert.equal(none.faces["model-effort"].freshness, "unavailable");
    assert.equal(none.faces["model-effort"].primary, "UNAVAILABLE");
  });

  it("context_window metric never labeled as account quota", () => {
    const snap = buildUsageSnapshot({
      sessions: [
        session({
          logicalSessionId: "w:a",
          worktreeId: "w",
          paneKey: "a",
          agentType: "omp",
          contextPercent: 42,
        }),
      ],
      selectedLogicalSessionId: "w:a",
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0,
    });
    assert.equal(snap.faces.omp.metricKind, "context_window");
    assert.match(snap.faces.omp.secondary, /ctx/i);
    assert.equal(/quota/i.test(snap.faces.omp.primary + snap.faces.omp.secondary), false);
  });

  it("official adapter can supply provider usage without inventing timestamps", () => {
    const adapter = officialPayloadProviderUsageAdapter({
      provider: "claude",
      primary: "40%",
      secondary: "official",
      sourceObservedAtMs: t0,
      provenance: "test_official",
    });
    const snap = buildUsageSnapshot({
      sessions: [],
      selectedLogicalSessionId: null,
      orcaReady: true,
      topologyReliable: true,
      discoveryCapturedAtMs: t0,
      evaluatedAtMs: t0 + 100,
      providerUsage: adapter,
    });
    assert.equal(snap.faces.claude.freshness, "fresh");
    assert.equal(snap.faces.claude.primary, "40%");
    assert.equal(snap.faces.claude.sourceObservedAtMs, t0);
    assert.equal(snap.faces.codex.freshness, "unavailable");
  });
});

describe("discovery copies public model fields", () => {
  it("joinDiscovery overlays model/effort when present on agent", () => {
    const decoded = decodeWorktreePsEnvelope({
      ok: true,
      id: "x",
      result: {
        worktrees: [
          {
            worktreeId: "wt1",
            hostId: "local",
            repo: "r",
            displayName: "d",
            agents: [
              {
                paneKey: "t:l",
                parentPaneKey: null,
                state: "working",
                agentType: "omp",
                model: "m1",
                thinkingLevel: "low",
                contextUsage: { tokens: 1, contextWindow: 10, percent: 10 },
                updatedAt: 50,
              },
            ],
          },
        ],
      },
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    const worktreePs = decoded.value.result;
    assert.ok(worktreePs);
    const snap = joinDiscovery({
      worktreePs,
      terminalList: {
        terminals: [
          {
            handle: "h",
            worktreeId: "wt1",
            tabId: "t",
            leafId: "l",
            connected: true,
            writable: true,
          },
        ],
      },
      nowMs: 100,
    });
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0]!.model, "m1");
    assert.equal(snap.sessions[0]!.effort, "low");
    assert.equal(snap.sessions[0]!.contextPercent, 10);
  });
});

describe("shared refresh — no per-key usage CLI", () => {
  it("usage faces rebuild from one dashboard refresh call", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oad-p5-"));
    let refreshCalls = 0;
    try {
      const paths = resolveConfigPaths(tmp);
      const configStore = new ConfigStore({ paths, watch: false });
      await configStore.load();
      const logger = new RedactedLogger({
        logPath: path.join(tmp, "p.log"),
        sink: async () => undefined,
      });
      const live = [
        session({
          logicalSessionId: "w:a",
          worktreeId: "w",
          paneKey: "a",
          agentType: "omp",
          model: "m",
        }),
      ];
      const runtime = new DashboardRuntime({
        configStore,
        logger,
        metadataStore: new MetadataStore({ paths }),
        nowMs: () => 5_000,
        refresh: async (): Promise<DiscoveryRefreshResult> => {
          refreshCalls += 1;
          return {
            ok: true,
            durationMs: 1,
            snapshot: {
              capturedAtMs: 4_000,
              orcaReady: true,
              sessions: live,
              ignoredShellCount: 0,
              ambiguousCount: 0,
              issues: [],
              capabilities: [],
            },
          };
        },
      });
      await runtime.whenReady();
      await runtime.refresh();
      const u1 = runtime.getUsageSnapshot();
      assert.equal(u1.faces.omp.freshness, "fresh");
      assert.match(u1.faces.omp.primary, /1/);
      assert.equal(u1.faces.claude.primary, "UNAVAILABLE");
      await runtime.selectSession("w:a");
      const u2 = runtime.getUsageSnapshot();
      assert.match(u2.faces.omp.primary, /m/);
      assert.equal(u2.faces["model-effort"].primary.includes("m") || u2.faces["model-effort"].primary === "m", true);
      // One discovery refresh for refresh(); select does not call discovery.
      assert.equal(refreshCalls, 1);
      runtime.stop();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("usage SVG faces", () => {
  it("renders provider and freshness labels", () => {
    const snap = buildUsageSnapshot({
      sessions: [],
      selectedLogicalSessionId: null,
      orcaReady: false,
      topologyReliable: false,
      discoveryCapturedAtMs: null,
      evaluatedAtMs: 1,
    });
    const svg = renderUsageSvg(snap.faces.claude);
    assert.match(svg, /UNAVAILABLE/);
    assert.match(svg, /CLAUDE/);
    assert.match(usageSvgDataUrl(snap.faces.omp), /^data:image\/svg\+xml,/);
    const fontSizes = [...svg.matchAll(/font-size="(\d+)"/g)].map((match) =>
      Number(match[1]),
    );
    assert.ok(
      fontSizes.every((size) => size >= 20),
      `Usage key contains type smaller than 20px: ${fontSizes.join(", ")}`,
    );
    assert.match(svg, /rx="22"/);
  });
});

describe("PI protocol polish", () => {
  it("parses sound.test and diagnostics.export with requestId", () => {
    const s = parsePiRequest({ type: "sound.test", requestId: "s1" });
    assert.equal(s.ok, true);
    const d = parsePiRequest({ type: "diagnostics.export", requestId: "d1" });
    assert.equal(d.ok, true);
    assert.equal(
      responseMatchesRequest("s1", {
        type: "sound.tested",
        requestId: "s1",
        played: false,
        detail: "x",
      }),
      true,
    );
  });

  it("config.patch presets still validate via existing protocol", () => {
    const p = parsePiRequest({
      type: "config.patch",
      requestId: "p1",
      patch: {
        presets: {
          omp: ["a", "b", "c", "d"],
          claude: ["a", "b", "c", "d"],
          codex: ["a", "b", "c", "d"],
          unknown: ["a", "b", "c", "d"],
        },
      },
    });
    assert.equal(p.ok, true);
  });
});

describe("diagnostics redaction", () => {
  it("export omits prompts presets draft handles paths and raw session ids", () => {
    const cfg = defaultConfig();
    cfg.presets.omp = ["SECRET PRESET BODY", "b", "c", "d"];
    const pathBearingId = "repo-id::/Users/frank/secret-project:tab:leaf";
    const exp = buildDiagnosticsExport({
      config: cfg,
      configSource: "file",
      configLastError: undefined,
      health: {
        state: "error",
        detail: "spawn /Users/x/bin/orca ENOENT",
        checkedAt: "2026-08-01T00:00:00.000Z",
        schemaVersion: "x",
        checks: [
          {
            id: "status",
            label: "status",
            ok: false,
            detail: "spawn /home/x/.local/bin/orca failed",
          },
        ],
      },
      dashboard: {
        capturedAtMs: 1,
        orcaReady: true,
        cards: [],
        slots: [],
        hidden: [],
        metaById: {},
        selectedLogicalSessionId: pathBearingId,
        alerts: [],
        control: {
          selectedLogicalSessionId: pathBearingId,
          selectedCard: null,
          nextTargetId: null,
          overflowCount: 0,
          focusHighlighted: false,
          focusEnabled: false,
          ackEnabled: false,
          mutationEnabled: false,
          presetKey: "unknown",
          presetsEnabled: false,
          retryEnabled: false,
          retryDetail: "FOCUS REQUIRED",
          interruptEnabled: false,
          structuredReplyEnabled: false,
          structuredReplyDetail: "REPLY UNAVAILABLE",
          draftOpen: false,
          draftUi: "empty",
          draftCharacters: 0,
          draftReady: false,
          draftAmbiguous: false,
          draftDetail: "open",
          newAgentEnabled: false,
          orcaReady: true,
          urgency: "empty",
          issues: ["ambiguous_join:repo-id::/Users/frank/secret-project:tab:leaf:count=2"],
        },
      },
      usage: buildUsageSnapshot({
        sessions: [],
        selectedLogicalSessionId: null,
        orcaReady: false,
        topologyReliable: false,
        discoveryCapturedAtMs: null,
        evaluatedAtMs: 1,
      }),
    });
    assertSafeDiagnostics(exp);
    const raw = JSON.stringify(exp);
    assert.equal(raw.includes("SECRET PRESET BODY"), false);
    assert.equal(raw.includes("/Users/"), false);
    assert.equal(raw.includes("/home/"), false);
    assert.equal(raw.includes(pathBearingId), false);
    assert.equal(raw.includes("secret-project"), false);
    assert.equal("presets" in (exp.configFlags ?? {}), false);
    assert.equal("selectedLogicalSessionId" in (exp.dashboard ?? {}), false);
    assert.equal(exp.dashboard?.selectedSessionToken, opaqueSessionToken(pathBearingId));
    assert.equal(exp.health?.detailCode, "spawn_failed");
    assert.equal(exp.health?.checks[0]?.detailCode, "spawn_failed");
    assert.ok(exp.configFlags?.presetSlotCounts.omp === 4);
  });

  it("assertSafeDiagnostics rejects embedded macOS and Linux user paths", () => {
    assert.equal(stringEmbedsFilesystemPath("repo-id::/Users/frank/secret-project:tab:leaf"), true);
    assert.equal(stringEmbedsFilesystemPath("spawn /Users/x/bin/orca ENOENT"), true);
    assert.equal(stringEmbedsFilesystemPath("spawn /home/x/.local/bin/orca failed"), true);
    assert.equal(stringEmbedsFilesystemPath("Library/Application Support/Orca"), true);
    assert.equal(stringEmbedsFilesystemPath("ready"), false);

    assert.throws(() =>
      assertSafeDiagnostics({
        note: "repo-id::/Users/frank/secret-project:tab:leaf",
      }),
    );
    assert.throws(() =>
      assertSafeDiagnostics({
        err: "spawn /Users/x/bin/orca ENOENT",
      }),
    );
    assert.throws(() =>
      assertSafeDiagnostics({
        err: "spawn /home/x/.local/bin/orca failed",
      }),
    );
    // Must not require logging the rejected content — throw message is key-path only.
    try {
      assertSafeDiagnostics({ leak: "/Users/frank/secret" });
      assert.fail("expected throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.equal(msg.includes("/Users/frank/secret"), false);
      assert.match(msg, /filesystem path/);
    }
  });

  it("sanitizeDetailCode never returns path-bearing input", () => {
    assert.equal(sanitizeDetailCode("spawn /Users/x/bin/orca ENOENT"), "spawn_failed");
    assert.equal(sanitizeDetailCode("spawn /home/x/bin/orca failed"), "spawn_failed");
    assert.equal(stringEmbedsFilesystemPath(sanitizeDetailCode("spawn /Users/x/bin/orca ENOENT")), false);
  });
});

describe("config usageStaleAfterMs", () => {
  it("defaults and validates range", () => {
    const d = defaultConfig();
    assert.equal(d.usageStaleAfterMs, 10_000);
    const ok = validateConfig({ ...d, usageStaleAfterMs: 8_000 });
    assert.equal(ok.ok, true);
    const bad = validateConfig({ ...d, usageStaleAfterMs: 10 });
    assert.equal(bad.ok, false);
    const legacy = { ...d } as Record<string, unknown>;
    delete legacy.usageStaleAfterMs;
    const back = validateConfig(legacy);
    assert.equal(back.ok, true);
    if (back.ok) assert.equal(back.value.usageStaleAfterMs, 10_000);
  });
});

describe("manifest usage actions and assets", () => {
  it("registers four stable UUIDs with assets and keypad controllers", async () => {
    const manifest = JSON.parse(await readFile(path.join(BUNDLE, "manifest.json"), "utf8")) as {
      Version: string;
      Nodejs: { Version: string };
      OS: Array<{ Platform: string }>;
      Actions: Array<{ UUID: string; Controllers: string[]; States: Array<{ Image: string }>; Icon: string }>;
    };
    assert.equal(manifest.Version.startsWith("0.5"), true);
    assert.equal(manifest.Nodejs.Version, "24");
    assert.ok(manifest.OS.some((o) => o.Platform === "mac"));
    const uuids = new Set(manifest.Actions.map((a) => a.UUID));
    for (const u of USAGE_ACTION_UUIDS) {
      assert.ok(uuids.has(u), u);
    }
    assert.ok(uuids.has(USAGE_OMP_UUID));
    assert.ok(uuids.has(USAGE_CLAUDE_UUID));
    assert.ok(uuids.has(USAGE_CODEX_UUID));
    assert.ok(uuids.has(MODEL_EFFORT_UUID));
    for (const u of USAGE_ACTION_UUIDS) {
      const action = manifest.Actions.find((a) => a.UUID === u)!;
      assert.deepEqual(action.Controllers, ["Keypad"]);
      const img = path.join(BUNDLE, `${action.States[0]!.Image}.png`);
      const icon = path.join(BUNDLE, `${action.Icon}.png`);
      await readFile(img);
      await readFile(icon);
    }
    const pi = await readFile(path.join(BUNDLE, "ui/property-inspector.html"), "utf8");
    assert.match(pi, /Save presets/);
    assert.match(pi, /Test sound/);
    assert.match(pi, /Export diagnostics/);
    assert.match(pi, /RENDER_PALETTE/);
    assert.match(pi, /sound\.test/);
    assert.match(pi, /diagnostics\.export/);
  });
});
