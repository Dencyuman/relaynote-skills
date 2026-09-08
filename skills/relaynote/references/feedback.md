# Receive feedback in the originating conversation

Read this when the user wants to continue the SAME conversation after leaving a
Relaynote review. The bridge only observes feedback and delivers an event. It
never runs `codex exec`, `claude -p`, a resume command, or a replacement agent.

## Compatibility, verified 2026-09-08

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
node "$CLI" watch SESSION_UUID --consumer CONVERSATION_WATCHER_ID --events feedback --continuous
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
node "$CLI" start SESSION_UUID --delivery codex --thread ORIGIN_THREAD_UUID --events feedback --continuous
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

The network polling loop reconnects after request timeouts without invoking a
model. No overall watch deadline is imposed by this CLI. A machine restart ends
the process; restart the watcher explicitly. The saved fingerprint avoids
repeating the last successfully queued state. Native queue acceptance is not
proof the model finished its work; check the original conversation.

## Codex inside Orca

When this conversation exposes `ORCA_TERMINAL_HANDLE`, use the host adapter:

```sh
node "$CLI" start SESSION_UUID --delivery orca --events feedback --continuous
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
Codex background-task completion callback. Live idle-turn verification is required
before claiming support in a new host/version.

## Cursor CLI

Use the parent conversation's native background Shell feature to run:

```sh
node "$CLI" watch SESSION_UUID --consumer CONVERSATION_WATCHER_ID --events feedback
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

## Event scope and limits

- Default `--events decisions`: approvals and change requests.
- `--events feedback`: also detects changes to open comments, submitted form
  values and edited tables exposed by `get_session_review`.
- Polls every 3 seconds, locally and without AI inference. This is not WebSocket
  push, and several edits between polls can be coalesced into one latest-state event.
- Empty new AI report rounds do not trigger the model. Existing feedback can be
  delivered immediately when first subscribing. Keep the same consumer ID for
  restarts to retain the saved cursor.
- Authentication denial stops the watcher. Network failures are retried.
- Stdout delivery records writing to the harness pipe, not an acknowledgement
  from the model. Exactly-once processing across crashes is not guaranteed.
- Feedback does not authorize unrelated commits, deployment, or data disclosure.

## Sources

- Claude Code: https://code.claude.com/docs/en/tools-reference#monitor-tool
- Claude hooks: https://code.claude.com/docs/en/hooks#limitations
- Codex: installed `codex queue --help` and real app-server test (0.153.4).
  Async-hook limitation: https://developers.openai.com/codex/hooks#run-hooks-in-the-background
- Cursor: https://cursor.com/docs/agent/tools/terminal and the official CLI
  distribution's background work completion handling (2026.09.02-c22c1a3).
