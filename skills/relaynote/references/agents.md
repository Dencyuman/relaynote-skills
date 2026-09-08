<!-- Product choices in onboarding are brands; the following IDs are internal adapters. -->

## Resolve the current environment

Onboarding selects a brand, not a runtime. Detect the environment of THIS conversation before choosing an adapter. Codex includes Orca: use `orca` only when `ORCA_TERMINAL_HANDLE` identifies this conversation; otherwise inspect `codex`. Cursor uses `cursor-cli` in its terminal environment and `cursor` for its editor hook. Cline's resume recipe targets its CLI API, not the editor extension. For every brand, inspect the adapter prerequisites and official reference before configuring it. Do not ask the user to classify CLI/TUI/ACP environments or present these as separate products. If detection is inconclusive, ask only for the missing environment information. Unsupported environments must not fall back to polling or launch another conversation.

# Host adapters

Use `node "$CLI" describe HOST` to get the host, installation target, delivery family,
and official reference. `agents` lists the registry. Product brand and actual host are
separate: Cursor IDE is `cursor`, its terminal is `cursor-cli`; Zed is an ACP host.

## Required transport

Every adapter below consumes the SAME hibernating WebSocket source. The CLI does not
poll D1/MCP, run an LLM on a timer, or replace the originating agent. A machine must
keep its watcher and original host running. Local heartbeat timers send `ping` to
the DO's automatic responder; they do not wake the model or pin the DO in memory.
If a host cannot keep this watcher attached and receive its output in the original
conversation, report that environment as unsupported. Do not improvise a polling loop.

## Setup

1. Install the skill in the selected host. Preserve working MCP entries. Configure
   remote HTTP MCP at the onboarding origin with OAuth; use an existing API key when
   OAuth is unavailable. Check the host's current CLI help/config reference first.
2. Follow `setup.md` for browser authorization and the exact host restart handoff.
3. Authenticate the watcher separately: `login --server ORIGIN`, or
   `login --device --server ORIGIN` to approve from a phone. The latter prints a URL
   that can be posted in the review using the already-connected MCP client.
4. Identify the exact active conversation and configure one route below. Capture
   IDs from the host, never from a title search or a guessed most-recent session.
5. Share a test review. A configured adapter is distinct from confirmed automatic
   continuation. New recipes are based on public protocols, not a claim of a live test.
   Live testing is optional unless the user requests it; keep that distinction in reports.

## Monitor / background completion

Claude Code: use native persistent Monitor and `watch SESSION --consumer ORIGIN
--events feedback --continuous`. Cursor CLI: use native background Shell with the
same command WITHOUT `--continuous`; task completion wakes its existing conversation.
Do not detach stdout with `&`. Qwen Code can use its native monitor; if its idle cap
cannot be disabled without restarting the model, use its Stop hook instead. Do not
emit artificial feedback to keep a monitor alive.

## Stop hooks

For each review, bind it to the exact hook conversation:

```
node "$CLI" bind SESSION --host HOST --thread ORIGIN
```

Install a **command** hook that executes `node /absolute/path/relaynote-feedback.mjs
hook --host HOST`. Merge the hook into existing configuration. The native host passes
its JSON input on stdin. The CLI finds only that conversation's binding, waits for
WebSocket feedback, and returns the host's continuation JSON. Without a binding it
exits immediately. Keep logs on stderr. Do not use prompt/LLM hooks.

| Host | Native event | Output |
| --- | --- | --- |
| Cursor IDE / CLI | `stop` | `followup_message` |
| Gemini CLI | `AfterAgent` | `decision: deny`, `reason` |
| Claude Code, Codex, Qwen Code, Goose, Trae, Auggie, Junie CLI | `Stop` (check installed casing/schema) | `decision: block`, `reason` |
| Copilot CLI | `agentStop` | `decision: block`, `reason` |

Use the host's documented timeout setting so it can wait for the expected review
interval. Do not trigger new turns just to rearm an expired hook. If the installed
host caps that wait, use its asynchronous route (Claude Monitor, Codex queue, or ACP)
or declare this configuration unsupported. Junie chat/ACP may not execute Stop hooks;
use only a documented hook-capable mode. A hook bound to one review is replaced by
`bind` when that conversation posts its next review. Each successful hook delivery disarms that binding; after appending a revised round, bind it again before waiting.

## Existing queues and terminals

Codex: `start SESSION --delivery codex --thread ORIGIN --events feedback --continuous`.
Orca: `start SESSION --delivery orca --events feedback --continuous` from the originating
Orca terminal. See `feedback.md` for identity checks and dated evidence.

## HTTP APIs

Generate a data-only configuration, then start the watcher:

```
node "$CLI" adapter-template opencode --thread ORIGIN --endpoint http://127.0.0.1:PORT
node "$CLI" start SESSION --delivery http --thread ORIGIN --adapter-file /absolute/adapter.json --events feedback --continuous
```

Save the first command's JSON into the chosen file. Templates exist for OpenCode,
Kilo (OpenCode-compatible servers), Continue, and Devin. Bind each config to one
`thread`. Continue's single-conversation server also uses `exclusiveConversation`;
confirm its instance belongs to this conversation before starting.

Other HTTP hosts use the same `--adapter-file` format:

```json
{
  "thread": "exact-origin-id",
  "url": "http://127.0.0.1:PORT/session/{{thread}}/message",
  "method": "POST",
  "body": {"message": "{{message}}"},
  "headersEnv": {"Authorization": "LOCAL_AGENT_AUTHORIZATION"}
}
```

Check the host's actual API and replace URL/body accordingly; this example is NOT a
universal endpoint. IDs are URL-encoded; message substitution is JSON data, never
shell code. `headersEnv` references local credentials and never stores their values.
Ambiguous or rejected delivery stops without retrying into another conversation.

| Host | Route / prerequisite |
| --- | --- |
| OpenCode | Its existing local TUI server, `/session/:id/prompt_async`, text `parts` |
| Kilo Code CLI | Existing compatible local server; confirm current OpenCode route |
| Continue | Existing `cn serve` instance, `/message`; one conversation per instance |
| Crush | Server API `/v1/workspaces/{id}/agent`; inspect the current payload and pin workspace **and session**, not just workspace |
| Devin | Existing cloud session; default endpoint `https://api.devin.ai`; set `DEVIN_AUTHORIZATION` locally to its bearer header |
| Antigravity | Existing Sidecar / agentapi route only when it identifies the active IDE conversation; never substitute `agy --continue` |
| Cline CLI | Existing connector only when its API can address the live originating thread; a resume-only connector is unsupported |

## ACP and Amp stdin bridge

Some hosts expose a stream only to their original parent. Install the bridge as the
initial agent command in that parent, before starting the conversation:

```
node "$CLI" bridge --protocol acp --socket /private/dir/relaynote.sock -- AGENT ACP_ARGS
```

This transparently forwards ACP JSON lines between the real host and its one agent
process. It records session IDs from successful `session/new` / `session/load` /
`session/resume` responses. Only attached sessions can receive `session/prompt`.
Use for Copilot CLI, Kiro CLI, or external agents hosted by Zed. Set the actual ACP
command from installed help; the wrapper does not reconnect to an already-owned
stdio stream. It creates the initial process once, not a replacement on feedback.

For Amp execute mode, use `--protocol amp -- amp -x --stream-json --stream-json-input`.
It learns the original thread ID from Amp's stream and writes user NDJSON to that
same stdin. The watcher connects with:

```
node "$CLI" start SESSION --delivery bridge --thread ORIGIN --socket /private/dir/relaynote.sock --events feedback --continuous
```

The socket is private (0600), is never replaced while it exists, and closes with the
original process. A wrapper cannot be retrofitted into a running process: provide
an explicit user restart handoff instead. Stop on unknown origin, agent replacement,
or an API rejection. Never use the bridge command as a feedback-delivery command.

## Sources and support levels

The registry links each host's primary documentation. Shared protocol references:
- https://cursor.com/docs/hooks
- https://geminicli.com/docs/hooks/reference/
- https://code.claude.com/docs/en/hooks
- https://docs.github.com/en/copilot/reference/hooks-reference
- https://opencode.ai/docs/server/
- https://ampcode.com/news/streaming-json
- https://agentclientprotocol.com/protocol/prompt-turn

`verified` references the repository's dated host evidence; `documented` is a public
API recipe; `conditional` requires the listed environment. No new live host evidence
was collected for this release. Adapt differing configuration syntax from official
help; do not reinterpret a missing same-conversation route as supported.
