# Stream Deck XL ↔ Agent (OMP / Claude Code / Codex / Orca) Integration — Research Note

**Status:** Research / feasibility only. No implementation.
**Date:** 2026-07-26
**Scope:** How a Stream Deck XL plugin can (a) launch commands, (b) receive state updates, (c) use dial/touch where relevant, (d) talk to a local macOS service, and (e) drive OMP / Claude Code / Codex sessions that run primarily through Orca. Classify each control as public/stable API vs. CLI vs. process inspection vs. AppleScript/accessibility vs. unsupported. Record SD XL hardware constraints for layout.
**Primary sources:** Elgato Stream Deck SDK docs, Elgato product pages, Orca docs (`onorca.dev`) + `stablyai/orca` repo, OMP docs source (`omp://…`, the `omp.sh/docs/source` tree).

---

## 0. Reading convention: Fact vs. Inference

- **[FACT]** = directly stated by a first-party source cited inline.
- **[INFERENCE]** = reasoned from first-party facts but not literally stated; treat as a design hypothesis to validate.
- **[OBSERVED]** = verified against the installed local binary/runtime named in the note; useful for this personal build, but re-check after Orca updates.
- Tables mark each control's **Surface** class:
  - `STABLE API` — documented, versioned, intended for external use.
  - `CLI` — a shipped command-line intended for scripting (stable contract, but a process boundary, not a library API).
  - `PROCESS INSPECTION` — reading state from files / PTY / runtime artifacts not promised stable.
  - `APPLESCRIPT / AX` — driving UI via AppleScript / macOS Accessibility.
  - `UNSUPPORTED` — internals with no stability promise.

---

## 1. Executive summary

- The Stream Deck plugin **application-layer is a local Node.js process** ([FACT], [plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)). That single fact unlocks the whole product: the plugin *is* the "local macOS service," and it can shell out to the `orca`, `omp`, `claude`, and `codex` CLIs, host a local socket/HTTP endpoint, and run `osascript` ([INFERENCE], but mechanically certain — Node stdlib is unrestricted; the SDK documents no sandbox).
- For agents **run through Orca** (the stated primary case), the documented, stable integration surface is the **`orca` CLI** with `--json` output ([FACT], [Orca CLI reference](https://www.onorca.dev/docs/cli/reference)). It covers worktrees, terminals (send/read/wait), the embedded browser, native computer-use, multi-agent orchestration, scheduled automations, and the notifications/inbox state feed.
- For **OMP run standalone** (not via Orca), OMP exposes a first-class **RPC mode** (`omp --mode rpc`, newline-delimited JSON over stdio) with full prompt/steer/state/event control, plus a **hooks** event bus for push ([FACT], [omp://rpc.md](omp://rpc.md), [omp://hooks.md](omp://hooks.md)).
- **Dial/touch are not available on the Stream Deck XL** — they belong to Stream Deck + only ([FACT], [SD XL product page](https://www.elgato.com/us/en/p/stream-deck-xl), [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)). The XL is a 32-key surface; design layout around keys, not encoders. Dial/touch only matters if the same plugin also declares `Encoder` controllers for an SD+ variant.
- State push to the device has no generic "subscribe" channel from outside; the plugin **polls** (`orca … --json`, OMP `get_state`) and writes results to keys via `setTitle`/`setImage` ([FACT] for the SDK setters; [INFERENCE] for the polling cadence). Orca's agent-finished notifications + Dock badge are the existing "agent done" signal ([FACT], [Notifications](https://www.onorca.dev/docs/notifications)).

---

## 2. Stream Deck XL — hardware constraints relevant to layout

**[FACT]** from the [Stream Deck XL product page](https://www.elgato.com/us/en/p/stream-deck-xl):

| Attribute | Value | Layout implication |
|---|---|---|
| Keys | **32 customizable LCD keys** in an **8 × 4 grid** | Primary/only interactive surface. Plan a fixed 32-slot map. |
| Key type | Classic (membrane) **or** scissor keys | Tactile only; no pressure/axis data. |
| Per-key display | LCD, static **or** dynamic icons; "instant visual feedback" | Each key can show live state (agent status, spinner, token %). |
| Dials | **None** | No encoder/rotate affordance on this device. |
| Touchscreen | **None** | No touchstrip/tap/long-touch. |
| Stand | Removable magnetic; fixed angle | Physical placement is the user's choice, not scriptable. |
| Cable | 1.5 m (5 ft), USB | Wired; plugin runs on the host Mac over USB. |
| Dimensions / weight | 34 × 182 × 112 mm; 690 g (with stand) | Desk footprint only. |
| Price | $249.99 (USD) | — |

**[FACT]** The SDK's manifest `Profiles[].DeviceType` enum distinguishes devices; examples annotate `DeviceType: 2` as "Stream Deck XL" and `DeviceType: 7` as "Stream Deck +" ([manifest reference](https://docs.elgato.com/streamdeck/sdk/references/manifest/)). Bundled profiles can auto-install per device type.

**[FACT]** Two controller types exist: `Keypad` (keys/pedals/G-keys) and `Encoder` (a dial **plus a portion of the touchscreen**, SD+ only). An action declares which controllers it supports ([Actions guide](https://docs.elgato.com/streamdeck/sdk/guides/actions/), [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)). On the XL, only `Keypad` actions are physically usable.

> **Implication:** target the XL as a 32-key surface. If a dial/touch variant is wanted, declare the *same* action UUID with `Controllers: ["Keypad", "Encoder"]` and branch at runtime with `ev.action.isDial()` ([FACT], [Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)). Do not assume the XL has any encoder.

---

## 3. Stream Deck SDK — integration surface

### 3.1 Plugin architecture (what actually runs on the Mac)

**[FACT]** ([plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)) A plugin is "hosted entirely on the user's local machine," architected like a web app:

| Layer | Runtime | Role |
|---|---|---|
| Application-layer (backend) | **Node.js** | Main logic; handles events from Stream Deck. |
| Presentation-layer ("property inspector") | **Chromium** (DOM) | HTML config UI rendered inside the Stream Deck app. |

**[FACT]** Runtime versions (Stream Deck 7.1+): Node.js **20.20.0 / 24.13.1**, Chromium **130**; from SD 7.1 Node is auto-updated ([plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)). SDK current version is **2.0.0**; requires Stream Deck **7.1+** and Node **24+** for development ([Getting Started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/)). Manifest sets `SDKVersion: 2`, `Software.MinimumVersion` (examples use `6.6`), `Nodejs.Version` (`20`), and `OS` (e.g. `mac` `MinimumVersion` `10.15`–`13`) ([manifest reference](https://docs.elgato.com/streamdeck/sdk/references/manifest/)).

**[FACT]** Stream Deck manages plugin lifecycle and provides automatic failure recovery ([plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)).

**[INFERENCE — mechanically certain]** Because the backend is an ordinary Node.js process and the SDK documents no sandbox, the plugin has the full Node stdlib: `child_process` (spawn `orca`/`omp`/`claude`/`codex`/`osascript`), `net`/`http`/`https` (host or call a local service), `fs`, timers, WebSockets. **This is the load-bearing capability for the whole product:** the plugin does not need a separate "local macOS service" — it *is* one — but it may still choose to talk to a long-lived helper daemon (see §3.5).

### 3.2 Launching commands (key press → action)

**[FACT]** Actions are `SingletonAction` subclasses that override event handlers, e.g. `onKeyDown(ev)`, registered before `streamDeck.connect()` ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)). The canonical "press a key → do something" handler is `onKeyDown` (named in the Actions guide prose alongside `onDialRotate`).

**[FACT]** Other lifecycle/input events on `SingletonAction`: `onWillAppear`/`onWillDisappear`, `onDidReceiveSettings`, `onSendToPlugin` (message from property inspector), `onTitleParametersDidChange`, `onPropertyInspectorDidAppear/Disappear`, `onDidReceiveResources` ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)).

**[INFERENCE]** A "launch command" key therefore maps to: `onKeyDown` → `child_process.execFile("orca", […], …)` (or `omp`/`claude`/`codex`/`osascript`). The SDK offers no first-party "run a shell command" action helper in the v2 TypeScript API; spawning is the app's job.

### 3.3 Receiving state updates (feedback to keys)

**[FACT]** Action instances expose setters to update what the device shows: `setTitle`, `setImage` (incl. SVG), `showAlert` / `showOk`, `setState`, `getSettings`/`setSettings`, and (for SD+) `setFeedback`/`setFeedbackLayout`/`setTriggerDescription` ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/), [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)). `streamDeck.actions.forEach(...)` lets you iterate **your plugin's** visible actions and mutate them outside of events (e.g. after a background task finishes) ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)). You **cannot** access or control actions owned by other plugins ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)).

**[FACT]** Property inspector ↔ plugin messaging is bidirectional: `Action.sendToPropertyInspector` and the `onSendToPlugin` event ([Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/)) — useful for a config UI that binds keys to worktrees/agents.

**[INFERENCE]** There is no generic Stream Deck "external push" channel the outside world can subscribe to. State updates therefore follow a **poll/refresh loop inside the plugin**: periodically call `orca … --json` (or OMP `get_state`) and call `setTitle`/`setImage` on the matching key. A dedicated background agent-status key can use `setImage` to a generated SVG that reflects running/idle/error + token/context %.

### 3.4 Dial / touch (Stream Deck + only — noted for completeness, **not on XL**)

**[FACT]** ([Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)) An "Encoder" = a dial + a segment of the SD+ touch strip. Events include `onDialUp`/`onDialDown` (the page shows `DialUpEvent`) and `onDialRotate` (named in the [Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/) prose); the `touchTap` event was added for SD+ per the [WebSocket API changelog](https://docs.elgato.com/streamdeck/sdk/references/websocket/changelog/). `TriggerDescription` documents four triggers: **Push / Rotate / Touch / LongTouch** ([manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/), [Dials](https://docs.elgato.com/streamdeck/sdk/guides/dials/)).

**[FACT]** SD+ feedback is driven by **layouts** (built-in `$X1`,`$A0`,`$A1`,`$B1`,`$B2`,`$C1`, or custom JSON on a **200 × 100 px** canvas) updated via `setFeedback`/`setFeedbackLayout` ([Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)). `title` and `icon` are reserved keys the user can override.

> **For an XL product this section is informational.** If the same plugin later targets SD+, dials map naturally to continuous controls (e.g. dial = steer/interrupt sensitivity, context-window target; touch = pick worktree). On the XL, equivalent "continuous" intents must be encoded as multiple keys or key long-press, since the hardware has no axis.

### 3.5 Communicating with a local macOS service

Two viable topologies; both rest on §3.1:

1. **Plugin *is* the service (recommended starting point).** The Node backend holds connection state, runs the poll loop, and shells out on key press. Simplest; no IPC; survives because Stream Deck restarts the plugin on crash ([FACT] lifecycle recovery, [plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)).
2. **Plugin ↔ separate daemon.** Useful if state must outlive the plugin process or be shared with other surfaces (e.g. the Orca mobile companion). The plugin opens a Unix socket / localhost HTTP / WebSocket to a daemon that brokers `orca`/`omp` calls. **[INFERENCE]** No first-party SD transport is prescribed; pick plain Node `net`/`http`/`ws`. Keep secrets out of the plugin package ([FACT] secrets warning, [plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)).

### 3.6 macOS requirements & distribution

- **[FACT]** Plugin runs on macOS (manifest `OS` `mac`, `MinimumVersion` `10.15` in the getting-started manifest and `13` in the manifest-reference examples) ([getting-started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/), [manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/)).
- **[FACT]** Plugins are packaged as a `*.sdPlugin` directory (with `manifest.json`, `bin/`, `ui/`, etc.) and installed/registered by the Stream Deck app; the app must **not** run with elevated privileges at first install or the plugin won't appear ([getting-started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/)).
- **[FACT]** If an action should react to app focus, the manifest supports `ApplicationsToMonitor` (mac = bundle IDs, windows = exe names) ([manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/)) — e.g. monitor Orca's bundle ID to auto-switch profiles when Orca is frontmost. **[INFERENCE]** exact Orca bundle ID must be confirmed from the installed app.
- **[INFERENCE]** Distributing a *helper binary* alongside the plugin would be subject to macOS notarization; OMP itself documents signing/notarization (`omp://macos-signing-notarization.md`), suggesting this is a real concern for any signed+notarized companion executable. Pure-Node plugins executed by the Stream Deck app's bundled Node avoid a separate signing step.

---

## 4. Orca — the primary integration surface for agents run through Orca

Orca is the "worktree IDE for AI coding agents" — it runs any CLI agent (Claude Code, Codex, OMP, …) each in an isolated git worktree, with terminals, an embedded browser, diff review, and real-time agent status ([FACT], [stablyai/orca](https://github.com/stablyai/orca)). Orca lists **OMP** as a supported agent with "Auto-setup, hooks, status," and Claude Code / Codex with deeper integration (usage, hot-swap) ([FACT], [Supported agents](https://www.onorca.dev/docs/agents/supported)).

### 4.1 The `orca` CLI — contract and shape

**[FACT]** ([CLI overview](https://www.onorca.dev/docs/cli/overview), [CLI reference](https://www.onorca.dev/docs/cli/reference)):

- Ships with the desktop app; **register under Settings → Experimental → CLI**; verify with `command -v orca` then `orca status --json`.
- Talks to the **running Orca runtime**; almost every command supports `--json` for machine parsing and a `--worktree <selector>` for explicit targeting.
- Selectors: `active`/`current` (resolve from shell cwd/terminal context), `id:`, `path:`, `branch:`, `issue:`, `repo id:<repoId>::<abs-worktree-path>` (remote).
- **Terminal handles are runtime-scoped** and must be re-acquired after an Orca restart (`orca terminal list --json`) ([FACT], [CLI reference](https://www.onorca.dev/docs/cli/reference)).

### 4.2 Command map relevant to a Stream Deck companion

| Deck intent | Orca CLI (all `--json`) | Surface | Notes |
|---|---|---|---|
| Is Orca up? | `orca status --json` | STABLE API | First call; tells you the runtime is reachable. |
| List worktrees / current | `orca worktree ps` / `current` / `show --worktree active` | STABLE API | Populate "switch worktree" keys. |
| Spin up an agent | `orca worktree create --repo id:<id> --name <n> --agent claude\|codex --prompt "…" --setup run\|skip\|inherit` | STABLE API | `--agent` launches the agent in the first terminal; `--prompt` seeds it. |
| Send a prompt / keystroke to an agent TUI | `orca terminal send --terminal <h> --text "continue" --enter` | STABLE API | "Read before sending when you are not sure what the terminal is waiting for" ([reference](https://www.onorca.dev/docs/cli/reference)). |
| Read terminal output on demand | `orca terminal read --terminal <h>` (with `--cursor`/`--limit`, `nextCursor` paging) | STABLE API | Use immediately before a mutating send; do not make full terminal reads the main status poll. |
| Wait for idle | `orca terminal wait --terminal <h> --for tui-idle --timeout-ms …` | STABLE API | Useful for bounded workflows, not the dashboard's primary polling loop. |
| Read agent state + unread | `orca worktree ps --json` | STABLE API | **[OBSERVED on Orca 1.4.156]** Returns worktree `unread` plus per-pane `agents[]` records with `state`, `agentType`, prompt/tool metadata, timestamps, and interruption state. |
| Resolve/focus a terminal | `orca terminal list` + `orca terminal switch --terminal <h>` | STABLE API | **[OBSERVED on Orca 1.4.156]** `terminal list` exposes `tabId`/`leafId`; joining those to `agents[].paneKey` yields the runtime-scoped handle, and `terminal switch` focuses that tab in Orca's UI. |
| Interrupt / close | `orca terminal send --terminal <h> --interrupt`; `orca terminal close --terminal <h>` | STABLE API | **[OBSERVED on Orca 1.4.156]** Supports a graceful interrupt and an explicit close path without foreground typing. |
| Open files / diffs | `orca file open`, `file diff`, `file open-changed` | STABLE API | "Open the diff" key. |
| Embedded browser | `goto`, `snapshot`, `click`, `fill`, `wait`, `screenshot`, `tab …`, `set device` | STABLE API | Drives Orca's **built-in** browser tab (not Chrome/Safari/Orca UI). |
| Native desktop (fallback) | `orca computer list-apps / get-app-state / click / set-value / type-text / press-key / hotkey / paste-text / scroll / drag` | STABLE API (Beta) | Needs **Accessibility** and (macOS) **Screen Recording** permission ([Computer use](https://www.onorca.dev/docs/cli/computer-use)). |
| Multi-agent coordination | `orca orchestration …` (tasks, dispatch, `worker_done`/`escalation`/`decision_gate`/`heartbeat`, `inbox`, `ask`, `run`) | STABLE API (Experimental) | Enable under Settings → Experimental ([Orchestration](https://www.onorca.dev/docs/cli/orchestration)). |
| Schedule a prompt | `orca automations …` | STABLE API | Recurring prompts against a repo/worktree ([Automations](https://www.onorca.dev/docs/cli/automations)). |

**[INFERENCE, grounded by the installed runtime]** The Stream Deck companion's live-status loop should poll `orca worktree ps --json`, join each `agents[].paneKey` to `terminal list`'s `tabId:leafId`, and update keys from normalized agent state. Use `terminal read` only before mutation or for diagnostics. Orca's worktree-level `unread` is the primary unread source; local per-terminal transition metadata fills the granularity gap when multiple agents share a worktree.

**[FACT]** Orchestration messages support group addresses `@all`, `@idle`, `@codex`, `@cursor`, `@grok`, `@droid`, `@worktree:<id>` ([Orchestration](https://www.onorca.dev/docs/cli/orchestration)) — useful for "ping all Codex agents" keys.

**[FACT]** Agents in Orca are launched with their permission-bypass flags pre-filled (`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex, `--yolo` for others) because worktrees are disposable ([Supported agents](https://www.onorca.dev/docs/agents/supported)). **[INFERENCE]** a "panic / take control" deck key that flips an agent to manual approval would need Orca-level support; not exposed as a single CLI flag today.

### 4.3 What is *not* a clean Orca API

- **[FACT]** The browser commands control Orca's embedded browser only — "They do not control Chrome, Safari, or the Orca desktop UI" ([CLI reference](https://www.onorca.dev/docs/cli/reference)). **[OBSERVED on Orca 1.4.156]** Exact terminal focus is nevertheless public through `orca terminal switch`; AppleScript/Accessibility is only a fallback for unrelated Orca chrome not covered by typed CLI commands.
- **[FACT]** Terminal handles are runtime-scoped and can go stale on restart ([CLI reference](https://www.onorca.dev/docs/cli/reference)) → the plugin must handle `terminal_handle_stale` by re-running `terminal list` and rejoining by pane identity.
- **[INFERENCE]** No documented Orca WebSocket/event stream is exposed to third-party plugins. The dashboard remains poll-driven even though Orca's own managed hooks populate the state returned by `worktree ps`.

---

## 5. OMP — integration surface when run standalone (not via Orca)

OMP ("Oh My Pi") is a terminal coding agent ([FACT], [omp.sh](https://omp.sh)). When a user runs OMP directly (not inside Orca), two first-party surfaces exist:

### 5.1 RPC mode — full control + state + events over stdio

**[FACT]** ([omp://rpc.md](omp://rpc.md)) `omp --mode rpc` runs a newline-delimited JSON protocol over stdio:

- Startup emits `{"type":"ready"}`; stdin = commands; stdout = responses, **agent/session events**, extension-UI requests, host-tool/URI requests.
- **Prompting:** `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`.
- **State:** `get_state` returns `{ model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, interruptMode, sessionFile/Id/Name, messageCount, queuedMessageCount, todoPhases, contextUsage:{tokens,contextWindow,percent}, … }` — i.e. everything a status key needs.
- **Model/thinking:** `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`.
- **Queue modes:** `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` (`all` vs `one-at-a-time`; `immediate` vs `wait`).
- **Compaction/retry/bash/session:** `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `branch`, `handoff`, `set_session_name`, `get_messages`.
- **Event stream** (forwarded from `AgentSession.subscribe`): `agent_start`, `agent_end`, `turn_start/end`, `message_*`, `tool_execution_*`, `auto_compaction_*`, `auto_retry_*`, `ttsr_triggered`, `todo_reminder`. Subagent frames gated by `set_subagent_subscription`.
- **Host tools / host URI schemes:** the host (i.e. the Stream Deck plugin) can register custom tools (`set_host_tools`) and virtual URL schemes (`set_host_uri_schemes`) that OMP calls back into over the same transport — a clean way to give the agent "press a deck key" or "read deck state" as a tool.
- `prompt` is **acknowledged immediately**; completion is signaled by `agent_end` / `prompt_result` / `data.agentInvoked:false` ([FACT], [omp://rpc.md](omp://rpc.md)). Responses correlate by `id`; concurrent commands may arrive out of order — clients MUST match on `id`.

> **[INFERENCE]** RPC mode is the right surface for a "dedicated OMP console" key group when OMP runs outside Orca. The plugin spawns `omp --mode rpc` once, holds the child, and drives the whole session bidirectionally.

### 5.2 Hooks — push events inside a session

**[FACT]** ([omp://hooks.md](omp://hooks.md)) A hook module default-exports a factory `hook(pi)` and registers `pi.on(event, …)` handlers. Event surfaces include `session_*` (start/switch/branch/compact/tree/shutdown), `before_agent_start`, `agent_start`, `agent_end`, `turn_start/end`, `auto_compaction_*`, `auto_retry_*`, `tool_call`/`tool_result` (pre/post, can block/override), `context`, `ttsr_triggered`, `todo_reminder`. Hooks can `pi.exec(...)` shell commands, `pi.sendMessage(...)`, `pi.registerCommand(...)`, and `pi.appendEntry(...)`.

**[INFERENCE]** A hook can be the **push side** of the bridge: on `agent_end`/`tool_result`/`todo_reminder`, `pi.exec` writes a small JSON line to a Unix socket / file the deck plugin watches — giving the device sub-second state changes without the plugin polling `get_state`. This is in-session only; it does not control OMP.

### 5.3 Claude Code / Codex standalone (secondary)

**[FACT]** Both are CLI agents Orca supports ([Supported agents](https://www.onorca.dev/docs/agents/supported), vendor docs: [Claude Code](https://docs.anthropic.com/claude/docs/claude-code), [Codex](https://github.com/openai/codex)). **[INFERENCE]** each ships a non-interactive/headless mode suitable for one-shot deck actions (e.g. Claude Code's print mode, Codex's `exec`), but the exact flags/contracts must be verified against current vendor docs before relying on them. Prefer routing through Orca (§4) or, for OMP, RPC (§5.1).

---

## 6. Capability classification (the matrix the product plan needs)

| Desired control | Best surface | Class | Source |
|---|---|---|---|
| Press key → launch/spawn an agent worktree | `orca worktree create --agent …` | STABLE API (CLI) | [CLI ref](https://www.onorca.dev/docs/cli/reference) |
| Press key → send prompt/keystroke to agent TUI | `orca terminal send --text … --enter` | STABLE API (CLI) | [CLI ref](https://www.onorca.dev/docs/cli/reference) |
| Read agent output / status | `orca terminal read` (+cursor) | STABLE API (CLI) | [CLI ref](https://www.onorca.dev/docs/cli/reference) |
| Detect agent idle/done | `orca terminal wait --for tui-idle`; Orca notification | STABLE API (CLI + OS notif) | [CLI ref](https://www.onorca.dev/docs/cli/reference), [Notifications](https://www.onorca.dev/docs/notifications) |
| Live OMP state (model/streaming/context %) | `omp --mode rpc` → `get_state` | STABLE API (RPC) | [omp://rpc.md](omp://rpc.md) |
| Push state from inside an OMP session | OMP hooks (`pi.on`, `pi.exec`) | STABLE API (hook) | [omp://hooks.md](omp://hooks.md) |
| Multi-agent dispatch / fan-out | `orca orchestration …` | STABLE API (Experimental) | [Orchestration](https://www.onorca.dev/docs/cli/orchestration) |
| Scheduled / recurring prompts | `orca automations …` | STABLE API (CLI) | [Automations](https://www.onorca.dev/docs/cli/automations) |
| Open file/diff in Orca | `orca file open/diff/open-changed` | STABLE API (CLI) | [CLI ref](https://www.onorca.dev/docs/cli/reference) |
| Drive embedded browser / Design Mode | `orca goto/snapshot/click/fill/…` | STABLE API (CLI) | [CLI ref](https://www.onorca.dev/docs/cli/reference) |
| Continuous control (sensitivity, %, scroll) | **Dial/encoder (SD+ only)**; on XL → multi-key | STABLE API (device-gated) | [Dials](https://docs.elgato.com/streamdeck/sdk/guides/dials/), [SD XL](https://www.elgato.com/us/en/p/stream-deck-xl) |
| Render rich status on a key | `setTitle` / `setImage(SVG)` | STABLE API (SDK) | [Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/) |
| Render rich status on SD+ touchstrip | `setFeedback` + layout JSON | STABLE API (SDK, SD+) | [Dials](https://docs.elgato.com/streamdeck/sdk/guides/dials/) |
| Drive the **Orca desktop UI** (focus pane, Jump Palette) | none documented → AppleScript / AX via `orca computer …` | APPLESCRIPT / AX (Beta) | [Computer use](https://www.onorca.dev/docs/cli/computer-use) |
| Inspect agent internals / PTY directly | reading OMP session files / PTY | PROCESS INSPECTION (no stability promise) | [omp://session.md](omp://session.md), [omp://natives-shell-pty-process.md](omp://natives-shell-pty-process.md) |
| Read Orca's internal DB/state files | not documented | UNSUPPORTED | — |
| Cross-plugin action control | impossible by design | UNSUPPORTED | [Actions](https://docs.elgato.com/streamdeck/sdk/guides/actions/) |

---

## 7. Risk table

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `orca` CLI lives behind **Settings → Experimental → CLI**; users may not have registered it | Med | High (whole Orca path breaks) | Detect `command -v orca` + `orca status --json` on plugin start; show `showAlert` + setup instructions on a dedicated key. |
| R2 | **Terminal handles are runtime-scoped** and go stale after Orca restart | Med | Med | Cache handles ephemerally; on any stale-handle error, re-run `orca terminal list --json`. |
| R3 | No Orca **push** event stream → status key lag / extra polling load | High | Low-Med | Poll `terminal read` (cursor-paged) + `wait --for tui-idle` on a modest interval; treat Orca's notification as the authoritative "done" edge. |
| R4 | `terminal send` is **typed into a TUI** — wrong window state sends keystrokes to the wrong prompt | Med | High | Always `terminal read` before send; gate sends behind a confirm; prefer `orchestration dispatch` for tracked work. |
| R5 | `orca computer` (AX fallback) needs **Accessibility + Screen Recording** and is **Beta** — flag names may shift | Med | Med | Use only for UI not reachable via CLI; surface a permissions check (`orca computer permissions --json`) and degrade gracefully. |
| R6 | OMP **RPC mode resets** workflow settings (todos, async, memory backend, etc.) to defaults on startup | Med | Med | Re-apply intended settings via `set_*` commands after `ready`; document the reset in onboarding. |
| R7 | OMP RPC `prompt` is **acknowledged before completion**; out-of-order responses | Low | Med | Correlate strictly on `id`; treat `agent_end`/`prompt_result` as completion, not the ack. |
| R8 | Bundling **secrets** in the plugin package | Low | High | Keep keys/tokens in the user's environment/daemon, never in `.sdPlugin` ([FACT] warning, [plugin-environment](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment)). |
| R9 | Stream Deck app **elevated-privilege** first-run blocks plugin load | Low | Low | Onboard users to restart the SD app post-install ([FACT], [getting-started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/)). |
| R10 | Assuming **dial/touch** exist on the XL | Med (design) | Med | XL = 32 keys only; gate any `Encoder` code behind `isDial()` and device-type checks ([Dials](https://docs.elgato.com/streamdeck/sdk/guides/dials/)). |
| R11 | macOS **notarization** for a helper binary | Med (if shipping binary) | Med | Prefer pure-Node plugin executed by SD's bundled Node; if a helper is unavoidable, notarize (cf. `omp://macos-signing-notarization.md`). |
| R12 | Orca **Orchestration / Computer use** are Experimental / Beta — breaking changes | Med | Med | Pin features behind capability checks (`orca status --json`, `orca computer capabilities --json`); isolate those code paths. |

---

## 8. Product-plan implications

1. **The plugin's Node backend is the integration core.** It shells to `orca` (primary), and optionally to `omp --mode rpc` / `claude` / `codex` for standalone sessions. No separate "agent bridge" daemon is required for v1; add one only if state must outlive the plugin or feed the Orca mobile companion too ([INFERENCE] from §3.1/§3.5).
2. **Design two experience tiers:**
   - *Orca-mode (default):* keys map to `orca` CLI commands; status comes primarily from `worktree ps`, joined to `terminal list` for exact handles. Covers OMP, Claude Code, and Codex uniformly because Orca abstracts them.
   - *Direct-OMP-mode:* for users running OMP outside Orca; one key group owns an `omp --mode rpc` child for live `get_state` + `prompt`/`steer` + push via hooks.
3. **Layout around 32 keys**, not dials. Reserve key slots by function class: terminal cards, selected-session control, launch/draft, and usage/health.
4. **Use bundled, auto-installing profiles per `DeviceType`** so an XL profile ships out of the box, with an optional SD+ profile that reuses the same action UUIDs (`Controllers: ["Keypad","Encoder"]`) and adds dial/touch mappings ([FACT] manifest profiles, [FACT] shared controllers).
5. **Polling architecture:** one backend scheduler calls `worktree ps` and `terminal list`, joins pane identities to ephemeral handles, and debounces `setTitle`/`setImage` writes — never poll once per key.
6. **Fail-safe UX:** every key that mutates agent state should refresh `worktree ps`, verify the pane-to-handle join, then use the typed `terminal send`/`switch`/`close` command. Stale handles auto-recover via `terminal list`.
7. **Permissions onboarding:** register the Orca CLI. Accessibility/Screen Recording is optional because exact terminal focus is available through `terminal switch`; request those permissions only for later desktop-UI fallbacks.
8. **Extensibility hook:** OMP host-tools (`set_host_tools`) let the agent itself call back into the deck plugin — enabling "agent presses a deck key" / "agent reads deck state" as a real tool, not just human→agent.

---

## 9. Open product decisions

1. **Resolved for this build:** Orca-only v1; standalone OMP/Claude/Codex integration is deferred.
2. **Resolved:** target 2–3 second convergence using one adaptive `worktree ps` + `terminal list` scheduler; measure real CPU/CLI load during implementation.
3. **Resolved:** `worktree ps.agents[].state` is the state source and worktree `unread` is the primary unread source; local per-terminal transition metadata fills the multi-agent granularity gap.
4. **Resolved:** exact focus uses `terminal switch`; no Orca bundle-ID automation is load-bearing.
5. **Still feasibility-gated:** state-safe structured approval/question replies must be proven per agent. Refuse blind input and fall back to Focus when the mapping is not fresh and exact.
6. **Resolved:** one Mac + Stream Deck XL only; no SD+ profile in v1.
7. **Resolved:** plugin backend is the service. Add only an on-demand native overlay helper when the draft/Superwhisper phase begins.

---

## 10. Sources (first-party)

**Stream Deck SDK (Elgato)**
- Getting Started — https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/
- Plugin Environment — https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment
- Actions — https://docs.elgato.com/streamdeck/sdk/guides/actions/
- Dials & Touch Strip — https://docs.elgato.com/streamdeck/sdk/guides/dials/
- Manifest reference — https://docs.elgato.com/streamdeck/sdk/references/manifest/
- WebSocket API changelog (touchTap) — https://docs.elgato.com/streamdeck/sdk/references/websocket/changelog/

**Stream Deck hardware (Elgato)**
- Stream Deck XL product page — https://www.elgato.com/us/en/p/stream-deck-xl

**Orca (Stably)**
- Repository — https://github.com/stablyai/orca
- Orca CLI overview — https://www.onorca.dev/docs/cli/overview
- Orca CLI reference — https://www.onorca.dev/docs/cli/reference
- Orchestration — https://www.onorca.dev/docs/cli/orchestration
- Computer use — https://www.onorca.dev/docs/cli/computer-use
- Scheduled automations — https://www.onorca.dev/docs/cli/automations
- Notifications & Inbox — https://www.onorca.dev/docs/notifications
- Supported agents — https://www.onorca.dev/docs/agents/supported

**OMP (omp.sh / docs source)**
- Project site — https://omp.sh
- RPC protocol reference — `omp://rpc.md`
- Hooks — `omp://hooks.md`
- (Related, referenced for risk/context) Session — `omp://session.md`; Shell PTY — `omp://natives-shell-pty-process.md`; macOS signing/notarization — `omp://macos-signing-notarization.md`

**Agent vendor docs (linked from Orca, for standalone paths)**
- Claude Code — https://docs.anthropic.com/claude/docs/claude-code
- Codex — https://github.com/openai/codex
