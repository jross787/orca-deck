import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HealthAction } from "../../plugin/src/actions/health.js";
import { ConfigStore, defaultConfig } from "../../plugin/src/config/store.js";
import {
  assertSafeDiagnosticEvent,
  commandNameFromArgs,
  RedactedLogger,
  type DiagnosticEvent,
} from "../../plugin/src/diagnostics/logger.js";
import {
  mapHealthSnapshot,
  type HealthSnapshot,
} from "../../plugin/src/health/check.js";
import {
  parsePiRequest,
  responseMatchesRequest,
  type PiResponse,
} from "../../plugin/src/messaging/protocol.js";
import {
  healthSvgDataUrl,
  ImageWriteDebouncer,
  renderHealthSvg,
} from "../../plugin/src/rendering/health-svg.js";
import { SCHEMA_VERSION } from "../../plugin/src/orca/schema.js";
import { buildCapabilityInspection, type CommandSpec } from "../../plugin/src/orca/capabilities.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "dev.onorca.agent-deck.sdPlugin");

describe("PI message requestId round trip", () => {
  it("parses config.get / config.patch / health.refresh", () => {
    const get = parsePiRequest({ type: "config.get", requestId: "r1" });
    assert.equal(get.ok, true);
    if (get.ok) assert.equal(get.value.type, "config.get");

    const patch = parsePiRequest({
      type: "config.patch",
      requestId: "r2",
      patch: { holdToCloseMs: 1600 },
    });
    assert.equal(patch.ok, true);
    if (patch.ok && patch.value.type === "config.patch") {
      assert.equal(patch.value.patch.holdToCloseMs, 1600);
    }

    const health = parsePiRequest({ type: "health.refresh", requestId: "r3" });
    assert.equal(health.ok, true);
  });

  it("rejects missing requestId and unknown types", () => {
    assert.equal(parsePiRequest({ type: "config.get" }).ok, false);
    assert.equal(parsePiRequest({ type: "nope", requestId: "x" }).ok, false);
    assert.equal(parsePiRequest({ type: "config.patch", requestId: "x", patch: 1 }).ok, false);
  });

  it("matches responses by requestId", () => {
    const response: PiResponse = {
      type: "config.snapshot",
      requestId: "abc",
      config: defaultConfig(),
      path: "/tmp/config.json",
      source: "file",
    };
    assert.equal(responseMatchesRequest("abc", response), true);
    assert.equal(responseMatchesRequest("nope", response), false);
  });
});

describe("health mapping ready/unavailable/incompatible", () => {
  const readyStatus = {
    app: { running: true },
    runtime: {
      state: "ready",
      reachable: true,
      runtimeId: "rt_1",
      appVersion: "1.4.159",
      capabilities: ["runtime.status.compat.v1"],
    },
  };

  const discoveryCommands: CommandSpec[] = [
    { command: "status", path: ["status"] },
    { command: "worktree ps", path: ["worktree", "ps"] },
    { command: "terminal list", path: ["terminal", "list"] },
    { command: "agent-context", path: ["agent-context"] },
  ];

  it("maps ready runtime to ready", () => {
    const inspection = buildCapabilityInspection({
      status: readyStatus,
      commands: discoveryCommands,
    });
    const snap = mapHealthSnapshot({
      status: readyStatus,
      statusOk: true,
      statusDecodeOk: true,
      hooks: { ok: true, enabled: true, decodeOk: true },
      inspection,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(snap.state, "ready");
    assert.equal(snap.runtimeId, "rt_1");
  });

  it("maps missing/unreachable runtime to unavailable, never idle", () => {
    const a = mapHealthSnapshot({
      status: null,
      statusOk: false,
      statusDecodeOk: true,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(a.state, "unavailable");
    assert.equal(a.detail.includes("idle"), false);

    const b = mapHealthSnapshot({
      status: {
        app: { running: false },
        runtime: { state: "stopped", reachable: false },
      },
      statusOk: true,
      statusDecodeOk: true,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(b.state, "unavailable");
  });

  it("maps decode failure and missing discovery to incompatible", () => {
    const decodeFail = mapHealthSnapshot({
      status: readyStatus,
      statusOk: true,
      statusDecodeOk: false,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(decodeFail.state, "incompatible");

    const inspection = buildCapabilityInspection({
      status: readyStatus,
      commands: [{ command: "status", path: ["status"] }],
    });
    const missing = mapHealthSnapshot({
      status: readyStatus,
      statusOk: true,
      statusDecodeOk: true,
      hooks: { ok: true, decodeOk: true },
      inspection,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(missing.state, "incompatible");
  });

  it("surfaces config errors as error state", () => {
    const snap = mapHealthSnapshot({
      configError: "invalid config retained last valid",
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(snap.state, "error");
    assert.ok(snap.configError);
  });
});

describe("health refresh single CLI round", () => {
  it("refreshAndPaint invokes checkHealth once for PI response+paint", async () => {
    let rounds = 0;
    const snapshot: HealthSnapshot = {
      state: "ready",
      detail: "ok",
      checkedAt: "2026-08-01T00:00:00.000Z",
      schemaVersion: SCHEMA_VERSION,
      checks: [],
    };
    const store = new ConfigStore({
      paths: {
        supportDir: "/tmp/orca-deck-unused",
        configPath: "/tmp/orca-deck-unused/config.json",
        statePath: "/tmp/orca-deck-unused/state.json",
        logsDir: "/tmp/orca-deck-unused-logs",
        logPath: "/tmp/orca-deck-unused-logs/plugin.log",
      },
      watch: false,
    });
    const action = new HealthAction({
      configStore: store,
      logger: new RedactedLogger({ sink: () => undefined }),
      checkHealth: async () => {
        rounds += 1;
        return snapshot;
      },
    });

    // Mirrors plugin.ts health.refresh: one refreshAndPaint supplies PI + paint.
    const health = await action.refreshAndPaint();
    assert.equal(rounds, 1);
    assert.equal(health.state, "ready");
    assert.equal(action.getLastHealth()?.state, "ready");
    action.stopPolling();
  });
  it("paints the appearing Health key before the global action registry catches up", async () => {
    const store = new ConfigStore({
      paths: {
        supportDir: "/tmp/orca-deck-unused",
        configPath: "/tmp/orca-deck-unused/config.json",
        statePath: "/tmp/orca-deck-unused/state.json",
        logsDir: "/tmp/orca-deck-unused-logs",
        logPath: "/tmp/orca-deck-unused-logs/plugin.log",
      },
      watch: false,
    });
    const action = new HealthAction({
      configStore: store,
      logger: new RedactedLogger({ sink: () => undefined }),
      checkHealth: async () => ({
        state: "ready",
        detail: "ok",
        checkedAt: "2026-08-01T00:00:00.000Z",
        schemaVersion: SCHEMA_VERSION,
        checks: [],
      }),
    });
    const images: string[] = [];

    await action.onWillAppear({
      action: {
        id: "health-1",
        setImage: async (image: string) => {
          images.push(image);
        },
      },
    } as unknown as Parameters<HealthAction["onWillAppear"]>[0]);

    assert.equal(images.length, 1);
    assert.match(decodeURIComponent(images[0] ?? ""), /font-size="28"/);
    action.stopPolling();
  });
});


describe("log redaction", () => {
  it("accepts metadata-only events and rejects content keys", async () => {
    const lines: string[] = [];
    const logger = new RedactedLogger({
      sink: (line) => {
        lines.push(line);
      },
    });
    await logger.record({
      level: "info",
      msg: "cli_result",
      command: "status",
      durationMs: 12,
      exitClass: "ok",
      schemaVersion: SCHEMA_VERSION,
      ids: { runtimeId: "rt_x" },
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as DiagnosticEvent;
    assert.equal(parsed.command, "status");
    assert.equal("stdout" in parsed, false);
    assert.equal("argv" in parsed, false);

    assert.throws(() =>
      assertSafeDiagnosticEvent({
        ts: new Date().toISOString(),
        level: "info",
        msg: "bad",
        fields: { prompt: "secret" as unknown as string },
      } as DiagnosticEvent),
    );
  });

  it("commandNameFromArgs strips trailing --json and never invents bodies", () => {
    assert.equal(commandNameFromArgs(["status", "--json"]), "status");
    assert.equal(commandNameFromArgs(["agent", "hooks", "status"]), "agent hooks status");
  });
});

describe("SVG output and write debounce", () => {
  it("renders labeled state colors and data URLs", () => {
    for (const state of ["ready", "unavailable", "incompatible", "error"] as const) {
      const svg = renderHealthSvg({
        state,
        detail: `detail for ${state}`,
        orcaAppVersion: "1.4.159",
        runtimeState: state === "ready" ? "ready" : state,
      });
      assert.match(svg, /<svg /);
      assert.match(svg, new RegExp(state === "unavailable" ? "UNAVAIL" : state === "incompatible" ? "INCOMPAT" : state.toUpperCase()));
      assert.equal(svg.includes("prompt"), false);
      const url = healthSvgDataUrl({ state, detail: "x" });
      assert.ok(url.startsWith("data:image/svg+xml,"));
    }
  });

  it("keeps every Health key label legible on physical hardware", () => {
    const svg = renderHealthSvg({
      state: "ready",
      detail: "runtime available and responding",
      orcaAppVersion: "1.4.167",
      runtimeState: "ready",
    });
    const fontSizes = [...svg.matchAll(/font-size="(\d+)"/g)].map((match) =>
      Number(match[1]),
    );

    assert.ok(fontSizes.length > 0);
    assert.ok(
      fontSizes.every((size) => size >= 20),
      `Health key contains type smaller than 20px: ${fontSizes.join(", ")}`,
    );
    assert.equal(svg.includes("runtime available"), false);
  });

  it("includes sonar animation only for ready without reduced motion", () => {
    const animated = renderHealthSvg({ state: "ready", detail: "ok" }, { reducedMotion: false });
    assert.match(animated, /<animate /);
    const still = renderHealthSvg({ state: "ready", detail: "ok" }, { reducedMotion: true });
    assert.equal(/<animate /.test(still), false);
    const unavail = renderHealthSvg({ state: "unavailable", detail: "down" });
    assert.equal(/<animate /.test(unavail), false);
  });

  it("debounces identical image writes per action", () => {
    const d = new ImageWriteDebouncer();
    assert.equal(d.shouldWrite("a1", "img-1"), true);
    assert.equal(d.shouldWrite("a1", "img-1"), false);
    assert.equal(d.shouldWrite("a1", "img-2"), true);
    assert.equal(d.shouldWrite("a2", "img-2"), true);
    d.clear("a1");
    assert.equal(d.shouldWrite("a1", "img-2"), true);
  });
});

describe("manifest schema and package layout", () => {
  it("manifest targets Node 24, macOS, Keypad, health UUID, no Profiles", async () => {
    const manifest = JSON.parse(await readFile(path.join(BUNDLE, "manifest.json"), "utf8")) as {
      UUID: string;
      SDKVersion: number;
      Software: { MinimumVersion: string };
      OS: Array<{ Platform: string; MinimumVersion: string }>;
      Nodejs: { Version: string };
      CodePath: string;
      Actions: Array<{
        UUID: string;
        Controllers: string[];
        PropertyInspectorPath: string;
        Icon: string;
        States: Array<{ Image: string }>;
      }>;
      Profiles?: unknown;
    };
    assert.equal(manifest.UUID, "dev.onorca.agent-deck");
    assert.equal(manifest.SDKVersion, 3);
    assert.equal(manifest.Software.MinimumVersion, "7.1");
    assert.equal(manifest.Nodejs.Version, "24");
    assert.equal(manifest.CodePath, "bin/plugin.js");
    assert.ok(manifest.OS.every((o) => o.Platform === "mac"));
    assert.equal("Profiles" in manifest, false);
    const health = manifest.Actions.find((a) => a.UUID === "dev.onorca.agent-deck.health");
    assert.ok(health);
    assert.deepEqual(health!.Controllers, ["Keypad"]);
    assert.equal(health!.PropertyInspectorPath, "ui/property-inspector.html");
    assert.equal(health!.Icon.endsWith(".png"), false);
    assert.equal(health!.States[0]?.Image.endsWith(".png"), false);
  });

  it("bundle ships local sdpi-components v4 and static icons", async () => {
    const sdpi = await readFile(path.join(BUNDLE, "ui/sdpi-components.js"), "utf8");
    assert.match(sdpi, /sdpi-components v4/);
    const pi = await readFile(path.join(BUNDLE, "ui/property-inspector.html"), "utf8");
    assert.match(pi, /src="sdpi-components\.js"/);
    assert.equal(pi.includes("https://sdpi-components.dev"), false);
    assert.equal(pi.includes("setting="), false);

    for (const rel of [
      "imgs/plugin/marketplace.png",
      "imgs/plugin/marketplace@2x.png",
      "imgs/plugin/category-icon.png",
      "imgs/plugin/category-icon@2x.png",
      "imgs/actions/health/icon.png",
      "imgs/actions/health/icon@2x.png",
      "imgs/actions/health/key.png",
      "imgs/actions/health/key@2x.png",
    ]) {
      const buf = await readFile(path.join(BUNDLE, rel));
      assert.ok(buf.byteLength > 0, rel);
    }
  });

  it("package engines require Node >=24 and pin SDK packages", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string | undefined>;
    };
    assert.equal(pkg.engines?.node, ">=24");
    assert.equal(pkg.dependencies?.["@elgato/streamdeck"], "2.1.0");
    assert.equal(pkg.devDependencies?.["@elgato/cli"], "1.7.4");
    const buildScript = pkg.scripts?.build;
    assert.ok(typeof buildScript === "string" && buildScript.includes("rollup"));
  });

  it("config schema file exists", async () => {
    const schema = JSON.parse(
      await readFile(path.join(ROOT, "schema/config.schema.json"), "utf8"),
    ) as { properties: { schemaVersion: { const: number } } };
    assert.equal(schema.properties.schemaVersion.const, 1);
  });
});
