/**
 * Urgent sound engine: waiting / error / stuck only; one sound per event version.
 * macOS-only child process argument arrays — never shell.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AlertEvent, EventVersion } from "./types.js";
import { sameEventVersion } from "./types.js";

export type AlertPlayer = {
  play: (soundPath: string) => Promise<void>;
};

export type AlertEngineOptions = {
  enabled: boolean;
  /** Absolute path to bundled short sound asset. */
  soundPath?: string;
  player?: AlertPlayer;
  /** Platform gate; defaults to process.platform. */
  platform?: NodeJS.Platform;
};

const DEFAULT_SOUND = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../dev.onorca.agent-deck.sdPlugin/imgs/sounds/urgent.wav");
  } catch {
    return "imgs/sounds/urgent.wav";
  }
})();

export function defaultAfplayPlayer(): AlertPlayer {
  return {
    play(soundPath: string): Promise<void> {
      return new Promise((resolve, reject) => {
        execFile("/usr/bin/afplay", [soundPath], { timeout: 5_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

export class AlertEngine {
  private enabled: boolean;
  private readonly soundPath: string;
  private readonly player: AlertPlayer;
  private readonly platform: NodeJS.Platform;
  private readonly emitted = new Map<string, EventVersion>();

  constructor(options: AlertEngineOptions) {
    this.enabled = options.enabled;
    this.soundPath = options.soundPath ?? DEFAULT_SOUND;
    this.player = options.player ?? defaultAfplayPlayer();
    this.platform = options.platform ?? process.platform;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Play at most one urgent sound per (logicalSessionId, event version).
   * Returns the alerts that were newly emitted.
   */
  async handle(alerts: readonly AlertEvent[]): Promise<AlertEvent[]> {
    if (!this.enabled || this.platform !== "darwin") return [];
    const played: AlertEvent[] = [];
    for (const alert of alerts) {
      if (alert.kind !== "waiting" && alert.kind !== "error" && alert.kind !== "stuck") continue;
      const key = alert.logicalSessionId;
      const prev = this.emitted.get(key);
      if (prev && sameEventVersion(prev, alert.event)) continue;
      try {
        await this.player.play(this.soundPath);
        this.emitted.set(key, alert.event);
        played.push(alert);
      } catch {
        // Sound failure must not break dashboard refresh.
      }
    }
    return played;
  }

  /** Test helper / restart hydrate. */
  markEmitted(logicalSessionId: string, event: EventVersion): void {
    this.emitted.set(logicalSessionId, event);
  }
}
