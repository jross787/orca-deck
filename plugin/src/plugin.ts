/**
 * Orca Agent Deck — Stream Deck SDK v2 plugin entry.
 * Register actions before connect. Keep SDK logger at info or quieter.
 * One shared DashboardRuntime serves all session + control keys.
 */
import streamDeck from "@elgato/streamdeck";
import {
  AcknowledgeAction,
  FocusAction,
  NextAttentionAction,
} from "./actions/controls.js";
import { HealthAction } from "./actions/health.js";
import { createSessionActions } from "./actions/session.js";
import { ConfigStore } from "./config/store.js";
import { RedactedLogger } from "./diagnostics/logger.js";
import { parsePiRequest, type PiResponse } from "./messaging/protocol.js";
import { DashboardRuntime } from "./state/runtime.js";

// Do NOT enable SDK trace logging — it can record raw protocol messages.
streamDeck.logger.setLevel("info");

const logger = new RedactedLogger();
const configStore = new ConfigStore({
  onChange: (snap) => {
    logger.info("config_changed", {
      source: snap.source,
      hasError: Boolean(snap.lastError),
    });
  },
});

const healthAction = new HealthAction({ configStore, logger });
const dashboardRuntime = new DashboardRuntime({ configStore, logger });
const sessionActions = createSessionActions({ runtime: dashboardRuntime });
const nextAttentionAction = new NextAttentionAction({ runtime: dashboardRuntime });
const focusAction = new FocusAction({ runtime: dashboardRuntime });
const acknowledgeAction = new AcknowledgeAction({ runtime: dashboardRuntime });

async function sendPi(response: PiResponse): Promise<void> {
  try {
    await streamDeck.ui.sendToPropertyInspector(response);
  } catch {
    // No visible inspector — ignore.
  }
}

async function bootstrap(): Promise<void> {
  await configStore.load();
  configStore.startWatching();
  await dashboardRuntime.whenReady();
  logger.info("plugin_start", {
    schemaVersion: configStore.getConfig().schemaVersion,
  });
}

streamDeck.ui.onSendToPlugin(async (ev) => {
  const parsed = parsePiRequest(ev.payload);
  if (!parsed.ok) {
    let requestId = "unknown";
    if (
      ev.payload &&
      typeof ev.payload === "object" &&
      ev.payload !== null &&
      "requestId" in ev.payload &&
      typeof ev.payload.requestId === "string"
    ) {
      requestId = ev.payload.requestId;
    }
    await sendPi({
      type: "error",
      requestId,
      code: parsed.code,
      message: parsed.message,
    });
    return;
  }

  const req = parsed.value;
  logger.info("pi_request", { type: req.type }, { ids: { requestId: req.requestId } });

  try {
    if (req.type === "config.get") {
      const snap = await configStore.load();
      await sendPi({
        type: "config.snapshot",
        requestId: req.requestId,
        config: snap.config,
        path: snap.path,
        source: snap.source,
        lastError: snap.lastError,
      });
      return;
    }

    if (req.type === "config.patch") {
      const snap = await configStore.patch(req.patch);
      await sendPi({
        type: "config.saved",
        requestId: req.requestId,
        config: snap.config,
        path: snap.path,
        source: snap.source,
      });
      void healthAction.refreshAndPaint();
      void dashboardRuntime.refresh();
      return;
    }

    if (req.type === "health.refresh") {
      // One CLI round: refreshAndPaint returns the snapshot used for paint + PI.
      const health = await healthAction.refreshAndPaint();
      await sendPi({
        type: "health.snapshot",
        requestId: req.requestId,
        health,
      });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    logger.error("pi_request_failed", { type: req.type }, { ids: { requestId: req.requestId } });
    await sendPi({
      type: "error",
      requestId: req.requestId,
      code: "request_failed",
      message,
    });
  }
});

// Register actions before connecting.
streamDeck.actions.registerAction(healthAction);
for (const sessionAction of sessionActions) {
  streamDeck.actions.registerAction(sessionAction);
}
streamDeck.actions.registerAction(nextAttentionAction);
streamDeck.actions.registerAction(focusAction);
streamDeck.actions.registerAction(acknowledgeAction);

void bootstrap()
  .catch((err) => {
    logger.error("bootstrap_failed", {
      code: err instanceof Error ? err.name : "error",
    });
  })
  .finally(() => {
    streamDeck.connect();
  });
