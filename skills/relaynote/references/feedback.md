# Receive feedback in the originating conversation

Read this when the user wants to continue the SAME conversation after submitting a final
Relaynote decision. The bridge only observes feedback and delivers an event. It
never runs `codex exec`, `claude -p`, a resume command, or a replacement agent.

New host recipes and their conditions are in [agents.md](agents.md). Monitoring requires a WebSocket Hibernation server (v3 delivery protocol); older servers are rejected.

## Protocol 3 live verification, 2026-09-09

Codex in Orca 1.4.158, local Relaynote using real MCP and WebSocket Hibernation:
- A final decision was submitted while the originating conversation was busy.
- The CLI retained the decision until that same pinned conversation became idle;
  no other conversation or agent process was started.
- The notification resumed the originating conversation. The AI read the exact
  decision and called `acknowledge_review` with its delivery ID; the server stored
  `received`. Transport acceptance and AI receipt had separate timestamps.
- Separate browser/CLI integration verified that comments stay silent, final
  decisions deliver once, foreign conversation bindings are rejected, and receipt
  updates do not trigger a second event. Desktop and mobile status displays checked.
- Other adapters retain their earlier host evidence below; protocol 3 has not
  been independently exercised in every host. Do not claim those hosts were retested.

## Historical host evidence, 2026-09-08

| Harness | Delivery | Evidence |
| --- | --- | --- |
| Claude Code 2.1.258, interactive | Native `Monitor` with `persistent: true`; CLI emits JSON lines | Actual idle conversation resumed after a delayed event; actual local Relaynote comment and decision reached the same conversation |
| Codex CLI 0.153.4 / app-server | `codex queue --thread UUID`, optional local `--remote` | Actual completed turn resumed on the identical thread ID, retaining its original context; tested with actual local Relaynote MCP |
| Cursor CLI 2026.09.02-c22c1a3 | Native background Shell; CLI emits one event and exits | Actual interactive conversation resumed after a 65-second delayed task completion, then received an actual local Relaynote comment in the same conversation |
| Codex inside Orca 1.4.158 | Pinned original terminal via `terminal wait` + `terminal send` | Actual production Relaynote decision resumed this same conversation after its final response |
| Codex embedded in other apps, Cursor editor, other agents | Host-specific | Not verified by testing a standalone CLI; run the host's own delayed-event probe first |

A background shell existing is NOT proof that finishing it wakes an idle model.
A non-interactive `-p` run is also not equivalent to an interactive conversation.
Do not silently substitute a new conversation when the host is unsupported.

## Authentication

`CLI` below means the absolute path to `scripts/relaynote-feedback.mjs` alongside
this skill. Node.js 22+ is required. Authenticate this bridge itself:

```sh
node "$CLI" login
```

It uses OAuth discovery, PKCE and a local browser callback; access and refresh
tokens are stored privately under `~/.local/share/relaynote-feedback`. Do not read
or export a different client's token store. Existing API-key users can provide a
key through stdin with `login --api-key-stdin`, never a command argument or chat.
`RELAYNOTE_HOME` selects an isolated bridge data directory for tests.

## Claude Code

1. Ensure `Monitor` is actually available; it is not offered on every provider
   or installation. Load it through tool discovery if needed.
2. Start the command below USING `Monitor`, with `persistent: true`. Choose one
   unique consumer ID for this conversation's watcher and retain it when
   restarting that watcher. Do not detach the process with `nohup` or `&`.

```sh
node "$CLI" watch SESSION_UUID --consumer CONVERSATION_WATCHER_ID --events decisions --continuous
```

3. Share the review URL and finish the response. The monitor remains active;
   it emits only changed feedback, without an LLM polling loop.
4. On a `relaynote.feedback` event, read the current review through MCP and
   continue the authorized work in this same conversation. A monitor preview
   may truncate a JSON line: use its output file or MCP for the full content.
5. Cancel using the native monitor/task stop control. Ending the Claude session
   also ends the monitor. This does not promise to survive closing the harness.

Do not use ordinary `async` hooks for wake-up: their output can wait until the
next user turn. `asyncRewake` exists, but has a hook timeout; the persistent
Monitor path is the verified choice here.

## Codex

Get the exact originating thread UUID from the harness, for example its
`CODEX_THREAD_ID` environment variable. Never use `--last`, a title search, or
an arbitrary transcript. For an embedded client, establish which app-server
owns that thread before enabling this path.

```sh
node "$CLI" start SESSION_UUID --delivery codex --thread ORIGIN_THREAD_UUID --events decisions --continuous
node "$CLI" status
```

When the thread belongs to a known local remote server, also supply
`--remote ws://127.0.0.1:PORT` or `--remote unix:///ABSOLUTE/SOCKET`.
The CLI's `start` detaches ONLY the lightweight Node monitor. It has no OS
service installer and does not start an agent. The originating app-server must
remain available. A missing destination or ambiguous queue failure stops the
watcher and records failure; inspect the original thread before retrying.

```sh
node "$CLI" stop WATCHER_ID
```

The WebSocket stays connected across local wait deadlines without invoking a model; a stop request closes it immediately. No overall
watch deadline is imposed by this CLI. A machine restart ends
the process; restart the watcher explicitly. The saved fingerprint avoids
repeating the last successfully queued state. Native queue acceptance is not
proof the model finished its work; check the original conversation.

## Codex inside Orca

When this conversation exposes `ORCA_TERMINAL_HANDLE`, use the host adapter:

```sh
node "$CLI" start SESSION_UUID --delivery orca --events decisions --continuous
```

The detached Node watcher uses Orca's public `terminal wait` and `terminal send`
commands. It waits for the original terminal to become idle, then submits a
labelled automatic notification to that terminal. A tool-output notification
alone did not wake the model in this host; do not use detached stdout/`notify`
as its wake-up adapter.

This path captures the originating terminal handle, incarnation, runtime,
workspace, tab, Codex thread ID, and ancestor Codex process identity. It checks
the terminal and process again before each send, and stops on replacement or
closure. It does not select the active terminal, create an agent, or fall back
to another conversation. Do not switch conversations inside that terminal while
watching. This adapter submits terminal input; it is host-specific, not a native
Codex background-task completion callback. Label new host/version recipes as documentation-based until their live behavior is confirmed.

## Cursor CLI

Use the parent conversation's native background Shell feature to run:

```sh
node "$CLI" watch SESSION_UUID --consumer CONVERSATION_WATCHER_ID --events decisions
```

The command stays alive without AI inference until feedback changes, prints
one JSON event, and exits. The harness should deliver its background-task
completion to the original conversation. Do not add `&`, `nohup`, spawn a new
`agent`, or use `--resume`. After processing the event, arm the next native
background task using the SAME consumer ID. Do not use `--continuous` here:
Cursor's adapter relies on process completion, not Monitor line delivery.

Verified in interactive Cursor CLI 2026.09.02-c22c1a3 with Auto-review. The editor
UI is a separate surface: verify its delayed task-completion behavior before
enabling automatic reception there. Use the main conversation's Shell tool,
not a subagent or a detached shell command.

## Final decisions and delivery receipts

- Comments, edits, forms, table saves and report uploads never trigger the agent.
  The reviewer must submit final approval or request changes. `--events decisions`
  is the only behavior; the legacy `--events feedback` argument is normalized to decisions.
- Publish only after all content is uploaded: `publish_session(session_id, round)`.
  For follow-ups use `begin_revision(session_id, round)` before adding content.
- The watcher binds one review to one opaque conversation identity on the server.
  A different conversation is rejected, even when it shares the account or folder.
  `--replace-binding` is only for an explicitly requested move to THIS conversation;
  never use it to work around an unexplained conflict. Existing delivery attempts
  are not replayed into the replacement destination.
- Delivery is claimed by final decision ID. Orca waits for the pinned terminal to
  become idle, then checks the current round/decision and server binding before send.
  Queue-capable hosts enqueue to the exact original thread. None starts an agent.
- Relaynote displays pending, waiting, sending, sent, received and failure states.
  Writing to stdout or a hook/queue is transport acceptance only. The AI must call
  `acknowledge_review(session_id, decision_id, delivery_id)` from the notification
  after verifying `get_session_review`. Only that receipt means the original AI
  has started responding. A status is last confirmed evidence, not a heartbeat.
- A crash or ambiguous send is not automatically replayed. Check the original
  conversation before attempting recovery. A later valid AI receipt can confirm
  a send that the CLI could not confirm. New decisions have separate delivery IDs.
- The server is notified when a watcher connects or stops. Abrupt machine loss
  may leave the last known status: the timestamp is shown, not a fabricated live state.
- Subscriptions use WebSocket Hibernation only. They read snapshots on connection
  and pushed change, plus one validation at the actual send point. No idle polling.
  Auto-response ping/pong does not wake the Durable Object. Reconnects use backoff.
- A native one-shot background task must be rearmed for the next review using the
  same consumer. Continuous monitors stay active across published rounds.
- A stopped/closed destination is never replaced by another terminal or process.

## Sources

- Claude Code: https://code.claude.com/docs/en/tools-reference#monitor-tool
- Claude hooks: https://code.claude.com/docs/en/hooks#limitations
- Codex: installed `codex queue --help` and real app-server test (0.153.4).
  Async-hook limitation: https://developers.openai.com/codex/hooks#run-hooks-in-the-background
- Cursor: https://cursor.com/docs/agent/tools/terminal and the official CLI
  distribution's background work completion handling (2026.09.02-c22c1a3).
