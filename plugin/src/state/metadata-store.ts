/**
 * Atomic persistence for dashboard metadata only.
 * Never stores runtime handles, prompts, previews, or terminal output.
 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveConfigPaths, type ConfigPaths } from "../config/store.js";
import {
  assertNoHandlesInPersisted,
  SLOT_COUNT,
  type EventVersion,
  type PersistedDashboardState,
} from "./types.js";

export const METADATA_SCHEMA_VERSION = 1 as const;

export function emptyPersistedState(): PersistedDashboardState {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    selectedLogicalSessionId: null,
    slotByLogicalId: {},
    sessions: {},
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asEventVersion(raw: unknown): EventVersion | null {
  if (!isObject(raw)) return null;
  const logicalSessionId = raw.logicalSessionId;
  const state = raw.state;
  const stateStartedAt = raw.stateStartedAt;
  if (typeof logicalSessionId !== "string" || typeof state !== "string") return null;
  if (typeof stateStartedAt !== "number" || !Number.isFinite(stateStartedAt)) return null;
  return {
    logicalSessionId,
    state: state as EventVersion["state"],
    stateStartedAt,
  };
}

export function parsePersistedState(input: unknown): PersistedDashboardState {
  if (!isObject(input)) return emptyPersistedState();
  const selected =
    typeof input.selectedLogicalSessionId === "string" || input.selectedLogicalSessionId === null
      ? (input.selectedLogicalSessionId as string | null)
      : null;

  const slotByLogicalId: Record<string, number> = {};
  if (isObject(input.slotByLogicalId)) {
    for (const [id, slot] of Object.entries(input.slotByLogicalId)) {
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT) {
        slotByLogicalId[id] = slot;
      }
    }
  }

  const sessions: PersistedDashboardState["sessions"] = {};
  if (isObject(input.sessions)) {
    for (const [id, raw] of Object.entries(input.sessions)) {
      if (!isObject(raw)) continue;
      sessions[id] = {
        ackedEvent: asEventVersion(raw.ackedEvent),
        unreadEvent: asEventVersion(raw.unreadEvent),
        worktreeUnreadSeeded: raw.worktreeUnreadSeeded === true,
        stateChangedAt:
          typeof raw.stateChangedAt === "number" && Number.isFinite(raw.stateChangedAt)
            ? raw.stateChangedAt
            : 0,
        workingSince:
          typeof raw.workingSince === "number" && Number.isFinite(raw.workingSince)
            ? raw.workingSince
            : null,
        lastAlertEvent: asEventVersion(raw.lastAlertEvent),
        lastAlertAt:
          typeof raw.lastAlertAt === "number" && Number.isFinite(raw.lastAlertAt)
            ? raw.lastAlertAt
            : null,
      };
    }
  }

  const value: PersistedDashboardState = {
    schemaVersion: METADATA_SCHEMA_VERSION,
    selectedLogicalSessionId: selected,
    slotByLogicalId,
    sessions,
  };
  assertNoHandlesInPersisted(value);
  return value;
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

export type MetadataStoreOptions = {
  paths?: ConfigPaths;
};

/**
 * File-backed metadata store at Application Support/.../state.json.
 */
export class MetadataStore {
  readonly paths: ConfigPaths;
  private snapshot: PersistedDashboardState;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(options: MetadataStoreOptions = {}) {
    this.paths = options.paths ?? resolveConfigPaths();
    this.snapshot = emptyPersistedState();
  }

  getSnapshot(): PersistedDashboardState {
    return this.snapshot;
  }

  async load(): Promise<PersistedDashboardState> {
    await mkdir(this.paths.supportDir, { recursive: true });
    try {
      const raw = await readFile(this.paths.statePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        this.snapshot = emptyPersistedState();
        return this.snapshot;
      }
      this.snapshot = parsePersistedState(parsed);
      return this.snapshot;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.snapshot = emptyPersistedState();
        return this.snapshot;
      }
      this.snapshot = emptyPersistedState();
      return this.snapshot;
    }
  }

  async save(next: PersistedDashboardState): Promise<void> {
    assertNoHandlesInPersisted(next);
    const value: PersistedDashboardState = {
      schemaVersion: METADATA_SCHEMA_VERSION,
      selectedLogicalSessionId: next.selectedLogicalSessionId,
      slotByLogicalId: { ...next.slotByLogicalId },
      sessions: { ...next.sessions },
    };
    // Fail closed if any session blob looks like it contains handles/content keys.
    const blob = JSON.stringify(value);
    if (/(prompt|preview|stdout|stderr|runtimeHandle|"handle")/i.test(blob)) {
      throw new Error("refusing to persist content-bearing dashboard metadata");
    }
    this.snapshot = value;
    const op = this.writeLock.then(() => atomicWriteJson(this.paths.statePath, value));
    this.writeLock = op.catch(() => undefined);
    await op;
  }
}
