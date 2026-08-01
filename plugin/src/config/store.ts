/**
 * External atomic JSON config authority for Orca Agent Deck.
 * Never use Stream Deck setSettings as a second store.
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export const DEFAULT_PRESETS = [
  "Finish the task.",
  "Run relevant checks and fix failures.",
  "Self-review and simplify/fix the diff.",
  "Review, commit, push, and open a PR under repository rules.",
] as const;

export type AgentPresetKey = "omp" | "claude" | "codex" | "unknown";

export type DeckConfig = {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  orcaExecutable?: string;
  polling: {
    workingMs: number;
    idleMs: number;
    unavailableMs: number;
    backoffCapMs: number;
  };
  cliTimeoutMs: number;
  stuckThresholdMinutes: number;
  paletteEnabled: boolean;
  soundEnabled: boolean;
  holdToCloseMs: number;
  presets: Record<AgentPresetKey, [string, string, string, string]>;
  superwhisper?: {
    shortcut?: string;
    mode?: string;
  };
  remoteHostFilters?: string[];
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type ConfigValidationResult =
  | { ok: true; value: DeckConfig }
  | { ok: false; issues: ConfigValidationIssue[] };

export type ConfigSnapshot = {
  config: DeckConfig;
  path: string;
  loadedAt: string;
  source: "default" | "file" | "patch" | "retained";
  lastError?: string;
};

export type ConfigPaths = {
  supportDir: string;
  configPath: string;
  statePath: string;
  logsDir: string;
  logPath: string;
};

const PRESET_KEYS: AgentPresetKey[] = ["omp", "claude", "codex", "unknown"];

export function defaultConfig(): DeckConfig {
  const presets = Object.fromEntries(
    PRESET_KEYS.map((key) => [key, [...DEFAULT_PRESETS] as [string, string, string, string]]),
  ) as DeckConfig["presets"];
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    polling: {
      workingMs: 2_000,
      idleMs: 3_000,
      unavailableMs: 10_000,
      backoffCapMs: 30_000,
    },
    cliTimeoutMs: 8_000,
    stuckThresholdMinutes: 60,
    paletteEnabled: true,
    soundEnabled: true,
    holdToCloseMs: 1_500,
    presets,
  };
}

export function resolveConfigPaths(homeDir: string = os.homedir()): ConfigPaths {
  const supportDir = path.join(homeDir, "Library", "Application Support", "Orca Agent Deck");
  const logsDir = path.join(homeDir, "Library", "Logs", "Orca Agent Deck");
  return {
    supportDir,
    configPath: path.join(supportDir, "config.json"),
    statePath: path.join(supportDir, "state.json"),
    logsDir,
    logPath: path.join(logsDir, "plugin.log"),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function issue(pathName: string, message: string): ConfigValidationIssue {
  return { path: pathName, message };
}

function validatePresetSet(raw: unknown, base: string, issues: ConfigValidationIssue[]): [string, string, string, string] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((x) => typeof x === "string")) {
    issues.push(issue(base, "must be an array of exactly 4 strings"));
    return undefined;
  }
  return raw as [string, string, string, string];
}

/**
 * Validate unknown JSON into DeckConfig. Unknown top-level keys are rejected.
 */
export function validateConfig(input: unknown): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  if (!isObject(input)) {
    return { ok: false, issues: [issue("", "config must be an object")] };
  }

  const allowed = new Set([
    "schemaVersion",
    "orcaExecutable",
    "polling",
    "cliTimeoutMs",
    "stuckThresholdMinutes",
    "paletteEnabled",
    "soundEnabled",
    "holdToCloseMs",
    "presets",
    "superwhisper",
    "remoteHostFilters",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) issues.push(issue(key, "unknown field"));
  }

  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(issue("schemaVersion", `must equal ${CONFIG_SCHEMA_VERSION}`));
  }

  let orcaExecutable: string | undefined;
  // null = explicit unset (PATH default); omit = leave for validate of full docs only.
  if (input.orcaExecutable !== undefined && input.orcaExecutable !== null) {
    if (typeof input.orcaExecutable !== "string" || input.orcaExecutable.trim().length === 0) {
      issues.push(issue("orcaExecutable", "must be a non-empty string when set"));
    } else {
      orcaExecutable = input.orcaExecutable.trim();
    }
  }

  const pollingRaw = input.polling;
  let polling: DeckConfig["polling"] | undefined;
  if (!isObject(pollingRaw)) {
    issues.push(issue("polling", "must be an object"));
  } else {
    const workingMs = asInt(pollingRaw.workingMs);
    const idleMs = asInt(pollingRaw.idleMs);
    const unavailableMs = asInt(pollingRaw.unavailableMs);
    const backoffCapMs = asInt(pollingRaw.backoffCapMs);
    const check = (name: string, value: number | undefined, min: number, max: number) => {
      if (value === undefined) issues.push(issue(`polling.${name}`, "must be an integer"));
      else if (value < min || value > max) issues.push(issue(`polling.${name}`, `must be ${min}..${max}`));
      return value;
    };
    const w = check("workingMs", workingMs, 500, 60_000);
    const i = check("idleMs", idleMs, 500, 120_000);
    const u = check("unavailableMs", unavailableMs, 1_000, 120_000);
    const b = check("backoffCapMs", backoffCapMs, 1_000, 300_000);
    if (w !== undefined && i !== undefined && u !== undefined && b !== undefined) {
      polling = { workingMs: w, idleMs: i, unavailableMs: u, backoffCapMs: b };
    }
  }

  const cliTimeoutMs = asInt(input.cliTimeoutMs);
  if (cliTimeoutMs === undefined || cliTimeoutMs < 1_000 || cliTimeoutMs > 60_000) {
    issues.push(issue("cliTimeoutMs", "must be integer 1000..60000"));
  }
  const stuckThresholdMinutes = asInt(input.stuckThresholdMinutes);
  if (
    stuckThresholdMinutes === undefined ||
    stuckThresholdMinutes < 1 ||
    stuckThresholdMinutes > 1_440
  ) {
    issues.push(issue("stuckThresholdMinutes", "must be integer 1..1440"));
  }
  if (typeof input.paletteEnabled !== "boolean") {
    issues.push(issue("paletteEnabled", "must be boolean"));
  }
  if (typeof input.soundEnabled !== "boolean") {
    issues.push(issue("soundEnabled", "must be boolean"));
  }
  const holdToCloseMs = asInt(input.holdToCloseMs);
  if (holdToCloseMs === undefined || holdToCloseMs < 500 || holdToCloseMs > 10_000) {
    issues.push(issue("holdToCloseMs", "must be integer 500..10000"));
  }

  const presetsRaw = input.presets;
  let presets: DeckConfig["presets"] | undefined;
  if (!isObject(presetsRaw)) {
    issues.push(issue("presets", "must be an object"));
  } else {
    const next: Partial<DeckConfig["presets"]> = {};
    for (const key of PRESET_KEYS) {
      const set = validatePresetSet(presetsRaw[key], `presets.${key}`, issues);
      if (set) next[key] = set;
    }
    if (PRESET_KEYS.every((k) => next[k])) {
      presets = next as DeckConfig["presets"];
    }
  }

  let superwhisper: DeckConfig["superwhisper"] | undefined;
  if (input.superwhisper !== undefined) {
    if (!isObject(input.superwhisper)) {
      issues.push(issue("superwhisper", "must be an object"));
    } else {
      const sw: DeckConfig["superwhisper"] = {};
      if (input.superwhisper.shortcut !== undefined) {
        if (typeof input.superwhisper.shortcut !== "string") {
          issues.push(issue("superwhisper.shortcut", "must be a string"));
        } else {
          sw.shortcut = input.superwhisper.shortcut;
        }
      }
      if (input.superwhisper.mode !== undefined) {
        if (typeof input.superwhisper.mode !== "string") {
          issues.push(issue("superwhisper.mode", "must be a string"));
        } else {
          sw.mode = input.superwhisper.mode;
        }
      }
      superwhisper = sw;
    }
  }

  let remoteHostFilters: string[] | undefined;
  if (input.remoteHostFilters !== undefined) {
    if (
      !Array.isArray(input.remoteHostFilters) ||
      !input.remoteHostFilters.every((x) => typeof x === "string" && x.length > 0)
    ) {
      issues.push(issue("remoteHostFilters", "must be an array of non-empty strings"));
    } else {
      remoteHostFilters = [...input.remoteHostFilters];
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const value: DeckConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    polling: polling!,
    cliTimeoutMs: cliTimeoutMs!,
    stuckThresholdMinutes: stuckThresholdMinutes!,
    paletteEnabled: input.paletteEnabled as boolean,
    soundEnabled: input.soundEnabled as boolean,
    holdToCloseMs: holdToCloseMs!,
    presets: presets!,
  };
  if (orcaExecutable !== undefined) value.orcaExecutable = orcaExecutable;
  if (superwhisper !== undefined) value.superwhisper = superwhisper;
  if (remoteHostFilters !== undefined) value.remoteHostFilters = remoteHostFilters;
  return { ok: true, value };
}

export function mergeConfigPatch(
  base: DeckConfig,
  patch: Record<string, unknown>,
): ConfigValidationResult {
  const merged: Record<string, unknown> = {
    ...base,
    ...patch,
    polling: isObject(patch.polling) ? { ...base.polling, ...patch.polling } : base.polling,
    presets: isObject(patch.presets) ? { ...base.presets, ...patch.presets } : base.presets,
    superwhisper:
      patch.superwhisper === undefined
        ? base.superwhisper
        : patch.superwhisper === null
          ? undefined
          : isObject(patch.superwhisper)
            ? { ...(base.superwhisper ?? {}), ...patch.superwhisper }
            : patch.superwhisper,
  };
  // Explicit null unsets optional keys (PI clear → PATH default).
  if (patch.orcaExecutable === null || merged.orcaExecutable === undefined) {
    delete merged.orcaExecutable;
  }
  if (patch.superwhisper === null || merged.superwhisper === undefined) {
    delete merged.superwhisper;
  }
  if (patch.remoteHostFilters === null || merged.remoteHostFilters === undefined) {
    delete merged.remoteHostFilters;
  }
  return validateConfig(merged);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export type ConfigStoreOptions = {
  paths?: ConfigPaths;
  watch?: boolean;
  watchIntervalMs?: number;
  onChange?: (snapshot: ConfigSnapshot) => void;
};

/**
 * File-backed config store with atomic writes, hot-reload, and last-valid retention.
 */
export class ConfigStore {
  readonly paths: ConfigPaths;
  private snapshot: ConfigSnapshot;
  private readonly watchIntervalMs: number;
  private readonly onChange?: (snapshot: ConfigSnapshot) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastMtimeMs: number | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(options: ConfigStoreOptions = {}) {
    this.paths = options.paths ?? resolveConfigPaths();
    this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
    this.onChange = options.onChange;
    this.snapshot = {
      config: defaultConfig(),
      path: this.paths.configPath,
      loadedAt: new Date().toISOString(),
      source: "default",
    };
    if (options.watch !== false) {
      // Watch starts after explicit load so constructors stay side-effect light in tests.
    }
  }

  getSnapshot(): ConfigSnapshot {
    return this.snapshot;
  }

  getConfig(): DeckConfig {
    return this.snapshot.config;
  }

  async ensureSupportDirs(): Promise<void> {
    await mkdir(this.paths.supportDir, { recursive: true });
    await mkdir(this.paths.logsDir, { recursive: true });
  }

  async load(): Promise<ConfigSnapshot> {
    await this.ensureSupportDirs();
    try {
      const rawText = await readFile(this.paths.configPath, "utf8");
      const st = await stat(this.paths.configPath);
      this.lastMtimeMs = st.mtimeMs;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        this.snapshot = {
          ...this.snapshot,
          loadedAt: new Date().toISOString(),
          source: "retained",
          lastError: "config.json is not valid JSON; retained last valid snapshot",
        };
        this.emit();
        return this.snapshot;
      }
      const validated = validateConfig(parsed);
      if (!validated.ok) {
        this.snapshot = {
          ...this.snapshot,
          loadedAt: new Date().toISOString(),
          source: "retained",
          lastError: `invalid config retained last valid: ${validated.issues
            .map((i) => `${i.path || "<root>"}: ${i.message}`)
            .join("; ")}`,
        };
        this.emit();
        return this.snapshot;
      }
      this.snapshot = {
        config: validated.value,
        path: this.paths.configPath,
        loadedAt: new Date().toISOString(),
        source: "file",
      };
      this.emit();
      return this.snapshot;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const fresh = defaultConfig();
        await atomicWriteJson(this.paths.configPath, fresh);
        const st = await stat(this.paths.configPath);
        this.lastMtimeMs = st.mtimeMs;
        this.snapshot = {
          config: fresh,
          path: this.paths.configPath,
          loadedAt: new Date().toISOString(),
          source: "default",
        };
        this.emit();
        return this.snapshot;
      }
      this.snapshot = {
        ...this.snapshot,
        loadedAt: new Date().toISOString(),
        source: "retained",
        lastError: `failed to read config: ${code ?? "error"}`,
      };
      this.emit();
      return this.snapshot;
    }
  }

  async save(next: DeckConfig): Promise<ConfigSnapshot> {
    const validated = validateConfig(next);
    if (!validated.ok) {
      throw new Error(
        `refusing to save invalid config: ${validated.issues
          .map((i) => `${i.path || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    await this.queueWrite(async () => {
      await this.ensureSupportDirs();
      await atomicWriteJson(this.paths.configPath, validated.value);
      const st = await stat(this.paths.configPath);
      this.lastMtimeMs = st.mtimeMs;
      this.snapshot = {
        config: validated.value,
        path: this.paths.configPath,
        loadedAt: new Date().toISOString(),
        source: "patch",
      };
    });
    this.emit();
    return this.snapshot;
  }

  async patch(patch: Record<string, unknown>): Promise<ConfigSnapshot> {
    const merged = mergeConfigPatch(this.snapshot.config, patch);
    if (!merged.ok) {
      throw new Error(
        `invalid config patch: ${merged.issues
          .map((i) => `${i.path || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return this.save(merged.value);
  }

  startWatching(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollExternalChange();
    }, this.watchIntervalMs);
    this.timer.unref?.();
  }

  stopWatching(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollExternalChange(): Promise<void> {
    try {
      const st = await stat(this.paths.configPath);
      if (this.lastMtimeMs !== null && st.mtimeMs === this.lastMtimeMs) return;
      // Skip our own in-flight writes by re-reading under the write lock.
      await this.queueWrite(async () => {
        const latest = await stat(this.paths.configPath);
        if (this.lastMtimeMs !== null && latest.mtimeMs === this.lastMtimeMs) return;
        const rawText = await readFile(this.paths.configPath, "utf8");
        this.lastMtimeMs = latest.mtimeMs;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          this.snapshot = {
            ...this.snapshot,
            loadedAt: new Date().toISOString(),
            source: "retained",
            lastError: "external config change is not valid JSON; retained last valid snapshot",
          };
          this.emit();
          return;
        }
        const validated = validateConfig(parsed);
        if (!validated.ok) {
          this.snapshot = {
            ...this.snapshot,
            loadedAt: new Date().toISOString(),
            source: "retained",
            lastError: `external config invalid; retained last valid: ${validated.issues
              .map((i) => `${i.path || "<root>"}: ${i.message}`)
              .join("; ")}`,
          };
          this.emit();
          return;
        }
        this.snapshot = {
          config: validated.value,
          path: this.paths.configPath,
          loadedAt: new Date().toISOString(),
          source: "file",
        };
        this.emit();
      });
    } catch {
      // Missing file mid-watch is non-fatal; next save recreates it.
    }
  }

  private emit(): void {
    this.onChange?.(this.snapshot);
  }

  private queueWrite(fn: () => Promise<void>): Promise<void> {
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Test helper: write JSON without going through ConfigStore validation. */
export async function writeRawConfigFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteJson(filePath, value);
}
