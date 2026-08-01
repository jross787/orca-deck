import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import {
  ConfigStore,
  defaultConfig,
  mergeConfigPatch,
  resolveConfigPaths,
  validateConfig,
  writeRawConfigFile,
} from "../../plugin/src/config/store.js";

describe("config defaults and validation", () => {
  it("defaultConfig validates", () => {
    const d = defaultConfig();
    const v = validateConfig(d);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value.schemaVersion, 1);
      assert.equal(v.value.holdToCloseMs, 1500);
      assert.equal(v.value.presets.omp.length, 4);
    }
  });

  it("rejects unknown fields and bad ranges", () => {
    const bad = validateConfig({
      ...defaultConfig(),
      cliTimeoutMs: 10,
      extra: true,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.issues.some((i) => i.path === "extra"));
      assert.ok(bad.issues.some((i) => i.path === "cliTimeoutMs"));
    }
  });

  it("mergeConfigPatch applies nested polling", () => {
    const merged = mergeConfigPatch(defaultConfig(), {
      polling: { workingMs: 2500 },
      holdToCloseMs: 2000,
    });
    assert.equal(merged.ok, true);
    if (merged.ok) {
      assert.equal(merged.value.polling.workingMs, 2500);
      assert.equal(merged.value.polling.idleMs, 3000);
      assert.equal(merged.value.holdToCloseMs, 2000);
    }
  });
});

describe("config store atomic save and last-valid", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function tempStore(): Promise<{ store: ConfigStore; dir: string; configPath: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orca-deck-cfg-"));
    dirs.push(dir);
    const paths = resolveConfigPaths(dir);
    // resolveConfigPaths uses homeDir/Library/... — point home at temp root.
    const home = dir;
    const store = new ConfigStore({
      paths: resolveConfigPaths(home),
      watch: false,
    });
    return { store, dir: home, configPath: resolveConfigPaths(home).configPath };
  }

  it("creates default config on first load", async () => {
    const { store, configPath } = await tempStore();
    const snap = await store.load();
    assert.equal(snap.source, "default");
    assert.equal(snap.config.schemaVersion, 1);
    const disk = JSON.parse(await readFile(configPath, "utf8")) as { schemaVersion: number };
    assert.equal(disk.schemaVersion, 1);
  });

  it("atomically saves patches", async () => {
    const { store } = await tempStore();
    await store.load();
    const snap = await store.patch({ holdToCloseMs: 1800, orcaExecutable: "/usr/local/bin/orca" });
    assert.equal(snap.source, "patch");
    assert.equal(snap.config.holdToCloseMs, 1800);
    assert.equal(snap.config.orcaExecutable, "/usr/local/bin/orca");
    const again = await store.load();
    assert.equal(again.config.holdToCloseMs, 1800);
  });

  it("retains last valid snapshot on invalid external change", async () => {
    const { store, configPath } = await tempStore();
    await store.load();
    await store.patch({ holdToCloseMs: 1700 });
    await writeRawConfigFile(configPath, { nope: true });
    const snap = await store.load();
    assert.equal(snap.config.holdToCloseMs, 1700);
    assert.equal(snap.source, "retained");
    assert.ok(snap.lastError);
  });

  it("retains last valid on corrupt JSON", async () => {
    const { store, configPath } = await tempStore();
    await store.load();
    await store.patch({ cliTimeoutMs: 9000 });
    await writeFile(configPath, "{not-json", "utf8");
    const snap = await store.load();
    assert.equal(snap.config.cliTimeoutMs, 9000);
    assert.equal(snap.source, "retained");
    assert.match(snap.lastError ?? "", /not valid JSON/);
  });
});
