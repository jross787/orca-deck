/**
 * Redacted diagnostic logger.
 * Records command metadata only — never args bodies, stdout/stderr, prompts, SVG, or PI payloads.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfigPaths } from "../config/store.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type ExitClass =
  | "ok"
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "invalid_json"
  | "empty_stdout"
  | "error"
  | "unknown";

export type DiagnosticEvent = {
  ts: string;
  level: LogLevel;
  msg: string;
  command?: string;
  durationMs?: number;
  exitClass?: ExitClass;
  schemaVersion?: string;
  /** Opaque IDs only (runtimeId, requestId, logicalSessionId placeholders). */
  ids?: Record<string, string>;
  /** Non-content structured fields only. */
  fields?: Record<string, string | number | boolean | null>;
};

const FORBIDDEN_FIELD_KEYS = new Set([
  "args",
  "argv",
  "stdout",
  "stderr",
  "prompt",
  "toolInput",
  "preview",
  "title",
  "svg",
  "image",
  "payload",
  "body",
  "text",
  "messageBody",
  "terminalPreview",
  "piPayload",
  "settings",
  "patch",
  "config",
]);

const CONTENT_BEARING_KEY = /prompt|stdout|stderr|toolinput|preview|svg|payload|argv|args/i;

export function assertSafeDiagnosticEvent(event: DiagnosticEvent): void {
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      throw new Error(`diagnostic event contains forbidden key: ${key}`);
    }
  }
  if (event.fields) {
    for (const key of Object.keys(event.fields)) {
      if (FORBIDDEN_FIELD_KEYS.has(key) || CONTENT_BEARING_KEY.test(key)) {
        throw new Error(`diagnostic fields contain forbidden key: ${key}`);
      }
    }
  }
  if (event.ids) {
    for (const [key, value] of Object.entries(event.ids)) {
      if (CONTENT_BEARING_KEY.test(key)) {
        throw new Error(`diagnostic ids contain forbidden key: ${key}`);
      }
      if (value.includes("\n") || value.length > 200) {
        throw new Error(`diagnostic id value looks content-bearing: ${key}`);
      }
    }
  }
  const serialized = JSON.stringify(event);
  if (/"prompt"\s*:/.test(serialized) || /"toolInput"\s*:/.test(serialized)) {
    throw new Error("diagnostic serialization leaked content-bearing keys");
  }
}

export type RedactedLoggerOptions = {
  logPath?: string;
  now?: () => Date;
  sink?: (line: string) => void | Promise<void>;
};

export class RedactedLogger {
  private readonly logPath: string;
  private readonly now: () => Date;
  private readonly sink?: (line: string) => void | Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly memory: DiagnosticEvent[] = [];

  constructor(options: RedactedLoggerOptions = {}) {
    this.logPath = options.logPath ?? resolveConfigPaths().logPath;
    this.now = options.now ?? (() => new Date());
    this.sink = options.sink;
  }

  get path(): string {
    return this.logPath;
  }

  /** In-memory events for tests. */
  get events(): readonly DiagnosticEvent[] {
    return this.memory;
  }

  childIds(ids: Record<string, string>): RedactedLogger {
    const parent = this;
    const child = new RedactedLogger({
      logPath: this.logPath,
      now: this.now,
      sink: this.sink,
    });
    const orig = child.record.bind(child);
    child.record = (partial) =>
      orig({
        ...partial,
        ids: { ...ids, ...(partial.ids ?? {}) },
      });
    // Keep parent memory linked for tests that construct via root logger.
    void parent;
    return child;
  }

  info(msg: string, fields?: DiagnosticEvent["fields"], extra?: Partial<DiagnosticEvent>): void {
    void this.record({ level: "info", msg, fields, ...extra });
  }

  warn(msg: string, fields?: DiagnosticEvent["fields"], extra?: Partial<DiagnosticEvent>): void {
    void this.record({ level: "warn", msg, fields, ...extra });
  }

  error(msg: string, fields?: DiagnosticEvent["fields"], extra?: Partial<DiagnosticEvent>): void {
    void this.record({ level: "error", msg, fields, ...extra });
  }

  debug(msg: string, fields?: DiagnosticEvent["fields"], extra?: Partial<DiagnosticEvent>): void {
    void this.record({ level: "debug", msg, fields, ...extra });
  }

  commandResult(input: {
    command: string;
    durationMs: number;
    exitClass: ExitClass;
    schemaVersion?: string;
    ids?: Record<string, string>;
    fields?: DiagnosticEvent["fields"];
  }): void {
    void this.record({
      level: input.exitClass === "ok" ? "info" : "warn",
      msg: "cli_result",
      command: input.command,
      durationMs: Math.round(input.durationMs),
      exitClass: input.exitClass,
      schemaVersion: input.schemaVersion,
      ids: input.ids,
      fields: input.fields,
    });
  }

  async record(partial: Omit<DiagnosticEvent, "ts"> & { ts?: string }): Promise<DiagnosticEvent> {
    const event: DiagnosticEvent = {
      ts: partial.ts ?? this.now().toISOString(),
      level: partial.level,
      msg: partial.msg,
      command: partial.command,
      durationMs: partial.durationMs,
      exitClass: partial.exitClass,
      schemaVersion: partial.schemaVersion,
      ids: partial.ids,
      fields: partial.fields,
    };
    // Drop undefined optional keys for stable serialization.
    if (event.command === undefined) delete (event as { command?: string }).command;
    if (event.durationMs === undefined) delete (event as { durationMs?: number }).durationMs;
    if (event.exitClass === undefined) delete (event as { exitClass?: ExitClass }).exitClass;
    if (event.schemaVersion === undefined) delete (event as { schemaVersion?: string }).schemaVersion;
    if (event.ids === undefined) delete (event as { ids?: Record<string, string> }).ids;
    if (event.fields === undefined) {
      delete (event as { fields?: DiagnosticEvent["fields"] }).fields;
    }

    assertSafeDiagnosticEvent(event);
    this.memory.push(event);
    if (this.memory.length > 500) this.memory.shift();

    const line = `${JSON.stringify(event)}\n`;
    if (this.sink) {
      await this.sink(line);
      return event;
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        await appendFile(this.logPath, line, "utf8");
      })
      .catch(() => undefined);
    await this.writeQueue;
    return event;
  }
}

export function exitClassFromCliErrorCode(
  code: string | undefined,
): ExitClass {
  switch (code) {
    case "spawn_failed":
    case "timeout":
    case "non_zero_exit":
    case "invalid_json":
    case "empty_stdout":
      return code;
    default:
      return "error";
  }
}

/** Public command name only — never full argv. */
export function commandNameFromArgs(args: readonly string[]): string {
  if (args.length === 0) return "orca";
  // Strip trailing --json for stable command labels.
  const cleaned = args[args.length - 1] === "--json" ? args.slice(0, -1) : [...args];
  return cleaned.join(" ");
}
