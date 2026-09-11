# Register this conversation and start its listener

## Contents

- Terms
- Prerequisites
- Common steps (every host)
- Claude Code
- Codex CLI
- Codex inside Orca
- Cursor CLI
- Other hosts
- Verify before ending the turn
- Every later report
- Failures
- Runtime lifecycle: update, stop, revoked device

## Terms

- **runtime**: one local process per server account, installed once under
  `~/.local/share/relaynote/runtime/`. It holds the single WebSocket Hibernation
  connection and forwards events to registered conversations.
- **listener**: the receiver for THIS conversation. On hosts with a native
  background task (Claude Code) it is a foreground command you keep running;
  on queue-capable hosts (Codex, Orca) the runtime delivers directly.
- **brand**: the AI client name (`claude-code`, `codex`, `cursor-cli`, …), never
  the skill name. It selects the icon and the host recipe.
- `RUNTIME` = `~/.local/share/relaynote/runtime/relaynote-runtime.mjs` after setup.
  `CLI` = `~/.local/share/relaynote/runtime/relaynote-feedback.mjs`.
  `SKILL` = this skill's directory.

Run the commands exactly as written. Do not substitute `wait_for_review`,
a polling loop, a detached `&` process, or a new agent.

## Prerequisites

- MCP is connected and `get_reporting_guide` returned `agent_runtime_protocol: 1`.
  Otherwise use [legacy.md](legacy.md).
- The user consented to installing the runtime (the onboarding prompt usually says so).
- CLI authentication exists for this server. Check first:

```
node SKILL/scripts/relaynote-runtime.mjs profiles
```

If a profile for this server and account is listed, reuse it: do not log in again.
Only when none exists, run the method the user selected:

```
node SKILL/scripts/relaynote-feedback.mjs login --server ORIGIN            # browser
node SKILL/scripts/relaynote-feedback.mjs login --device --server ORIGIN   # phone / remote
node SKILL/scripts/relaynote-feedback.mjs login --api-key-stdin --server ORIGIN   # key via stdin
```

`login` for an already-connected origin prints "Already connected" and exits 0.
It is safe to run. It refuses only a different origin or an OAuth→API-key switch
while runtimes are live.

## Common steps (every host)

Exactly this order. Each command prints a `next` field; follow it.

```
1. node SKILL/scripts/relaynote-runtime.mjs setup --accept-install
   → prints the RUNTIME path
2. node RUNTIME register --adapter ADAPTER --brand BRAND --thread THREAD [--setup-id SETUP_ID]
   → prints conversation_id, generation, pairing_code (10 min)
3. MCP: register_agent(conversation_id, pairing_code)
   → paired: true
4. host step below (Claude Code and Cursor need it; Codex/Orca do not)
5. verify (section below)
```

Keep `conversation_id` and `generation`. Pass both to `create_session` and
`attach_agent_session`. Pass `--setup-id` only during onboarding. Add
`--no-discussions` only if the user asked for final decisions only; by default
the reviewer's submitted comments reach this conversation too.

| Host | ADAPTER | BRAND | THREAD |
| --- | --- | --- | --- |
| Claude Code | `host-task` | `claude-code` | `$CLAUDE_CODE_SESSION_ID` |
| Codex CLI | `codex` | `codex` | `$CODEX_THREAD_ID` |
| Codex inside Orca | `orca` | `codex` | captured automatically |
| Cursor CLI | `host-task` | `cursor-cli` | the conversation id from the host |

`node CLI describe` auto-detects the host and prints the adapter to use.

## Claude Code

After step 3, start the listener with the native `Monitor` tool,
`persistent: true`. Load `Monitor` through tool discovery if it is not listed.

```
node RUNTIME listen --conversation CONVERSATION_ID
```

Wait for the first line `{"type":"relaynote.runtime.listening"}` before ending
the turn. Do not run this through a plain background shell, `nohup`, or `&`.
Ending the Claude Code session ends the listener; a resumed session must run
it again (registration and pairing survive).

## Codex CLI

Steps 1–3 only. The runtime queues to the exact thread with `codex queue`.
`register` verifies `codex queue --help` first. Never use `exec` or `resume`.
When the thread belongs to a known local app-server, add `--remote ws://…` or
`--remote unix:///…` to `register`.

## Codex inside Orca

Steps 1–3 only, with `--adapter orca`. Requires `ORCA_TERMINAL_HANDLE` and
`CODEX_THREAD_ID` set in THIS terminal. The runtime pins the conversation
(incarnation, tab, worktree and thread), re-resolves the terminal before every
send, waits for idle, and submits the notification there. Restarting Codex or
reconnecting Orca does not break it. If `CLAUDECODE` is set, the host is
Claude Code even inside Orca: use the Claude Code recipe.

## Cursor CLI

After step 3, run the listener as the conversation's native background Shell.
`--once` prints the first event and exits, so the host's task-completion wakes
the conversation. Re-arm it after handling each event.

```
node RUNTIME listen --conversation CONVERSATION_ID --once
```

This runtime route is documented from Cursor's background-task behavior; the
live evidence in [legacy.md](legacy.md) was collected with the per-review
watcher. Say so if the user asks whether it was tested.

## Other hosts

```
node CLI describe            # detects the host
node CLI describe HOST_ID    # prerequisites for a named host
```

Hosts with a same-conversation HTTP API or ACP stream are documented in
[legacy.md](legacy.md) ("HTTP APIs", "ACP and Amp stdin bridge"). If `describe`
reports no verified route, say so; do not improvise polling or a new agent.

## Verify before ending the turn

```
node RUNTIME status                                  → connected: true
node RUNTIME current --adapter ADAPTER --thread THREAD  → this conversation_id
```

On Claude Code and Cursor CLI, the listener's `relaynote.runtime.listening`
line must also have appeared. If any check fails, return to the common steps.

## Every later report

- `create_session(..., conversation_id, generation)` attaches the new session.
- A session created without those ids: `attach_agent_session(session_id, conversation_id, generation)`.
- After a verified restart of the same logical conversation, register and pair
  again, then `attach_agent_session(..., replace_generation: true)` for open sessions.
- Owner-assigned tasks arrive as sessions: `get_agent_task(session_id, conversation_id, generation)`,
  verify, then call again with `acknowledge: true`, and work in that session.

## Failures

| Symptom | Do |
| --- | --- |
| `register` prints a different `conversation_id` than before | The thread changed. Use the new ids; do not reuse old ones. |
| `register_agent` rejects the code | It expired (10 min). Run `register` again. |
| `status` shows `connected: false` | `node RUNTIME start`, then verify again. |
| `listen` prints `{"error":"not_registered"}` | This conversation was never registered on this account. Run the common steps again. |
| `listen` prints `{"error":"wrong_adapter"}` | This conversation uses `codex`, `orca`, `http` or `bridge`; it needs no listener. |
| `listen` prints `{"error":"already_listening"}` | Another listener is attached. `node RUNTIME status`, then retry. |
| 403 on upload | Run `login` again; the grant predates the upload scope. |
| Session page says the AI is not receiving | The listener is not running. Start it; do not open a new conversation. |

`node RUNTIME status` prints one row per conversation with `state`, `listener`,
`lastError` and `lastErrorAt`; every failure also writes one line to
`~/.local/share/relaynote/accounts/*/runtime.log`. The `lastError` starts with
the reason:

| Reason | Means | Do |
| --- | --- | --- |
| `identity` | The originating Orca terminal (incarnation, tab or worktree) is gone, or no Codex runs in its worktree. Nothing was sent. | Reopen the original terminal, or register and pair this conversation again. |
| `busy` | The terminal never accepted input within 10 minutes. Nothing was sent. | Leave the terminal idle; the server re-sends. |
| `transport_unknown` | Bytes may have reached the conversation. Never replayed automatically. | Read the original conversation before doing anything. |
| `listener_absent` | No listener was attached; the delivery stayed `waiting`. | `node RUNTIME listen --conversation CONVERSATION_ID` again. |
| `auth` | The stored grant is dead. The runtime stopped reconnecting and set every conversation to `auth_required`. | `node CLI login --server ORIGIN`, then `node RUNTIME start`, register and pair again. |

A re-register from the same Orca terminal keeps the same `generation`, even
after Codex restarted or Orca re-issued the terminal handle: already attached
sessions stay attached. The `generation` changes only when the conversation
itself changes (different tab, incarnation, worktree or thread).

## Runtime lifecycle: update, stop, revoked device

- **Update** (only after the user approves the pinned release):
  install the skill at the recommended revision, then
  `node RUNTIME stop` (pauses every registered conversation on this account),
  `node NEW_SKILL/scripts/relaynote-runtime.mjs setup --accept-update --from-version OLD`,
  `node RUNTIME start`, then register, pair, and start the listener again for
  THIS conversation. Other conversations resume by themselves.
- **Stop**: `node RUNTIME stop`. `register` or `start` restarts it.
- **Revoked device**: delivery stops until the owner selects "Allow reconnection"
  in the device card. Then register and pair again. Never rotate identities to
  bypass a revocation.
