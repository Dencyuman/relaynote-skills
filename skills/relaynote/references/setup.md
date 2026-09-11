# Connect Relaynote

## Contents

- Endpoints
- Inspect before changing
- Add the MCP server (per client)
- Authorize in the browser
- Reload or restart, and resume this conversation
- Verify the connection
- Onboarding: setup_id and chosen authentication
- API-key clients
- Errors
- Skill updates

## Endpoints

- MCP: `https://relaynote.dev/mcp` (use the origin in the onboarding prompt if different)
- Onboarding: `https://relaynote.dev/app/onboarding`
- Settings, Google linking, revoking AI access: `https://relaynote.dev/app?view=settings`

## Inspect before changing

Identify the client from the environment (`CLAUDECODE`, `CODEX_THREAD_ID`,
`ORCA_TERMINAL_HANDLE`, …) or `node SKILL/scripts/relaynote-feedback.mjs describe`.
Check the existing MCP configuration first. Preserve other servers and the
user's configuration scope. Do not replace a working Relaynote entry that
points at a different origin without asking which environment is intended.

New connections use OAuth 2.1 Authorization Code + PKCE: register the URL
without a static header; the client stores its own tokens. Never read, print,
or commit a token store. Never ask the user to paste a key into chat.

## Add the MCP server (per client)

**Claude Code**

```
claude mcp list
claude mcp add --transport http --scope user relaynote https://relaynote.dev/mcp
```

**Codex CLI** — `codex mcp add relaynote --url https://relaynote.dev/mcp`
starts OAuth itself; keep that process running until it finishes. Only if the
entry exists but is unauthenticated: `codex mcp login relaynote --scopes relaynote,offline_access`
(add `--oauth-client-registration dcr` if `codex mcp login --help` lists it).

**Cursor** — merge `{"relaynote": {"url": "https://relaynote.dev/mcp"}}` into
`mcpServers` in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user),
then use Connect in Cursor's MCP settings.

**Other clients** — follow the client's remote-HTTP-MCP-with-OAuth instructions.
Hosted clients need their native connection UI. A client without OAuth support
uses an API key (below).

## Authorize in the browser

One browser launch per attempt. If the client opens the browser, do not also
run `open` or navigate to the URL. Never revisit an old callback URL.

Claude Code: `claude mcp login relaynote` needs a terminal; from inside a
conversation run `script -q /dev/null claude mcp login relaynote`
(`--no-browser` prints the URL for SSH). Older versions without `mcp login`:
ask the user to run `/mcp`, select Relaynote, and authenticate.

## Reload or restart, and resume this conversation

A server added mid-session is not loaded yet. Try tool discovery; if the
`relaynote` tools are missing:

1. Claude Code: ask the user to run `/mcp` once, then retry discovery.
2. Still missing: the user exits and runs `claude --resume CLAUDE_CODE_SESSION_ID`
   in the same directory (confirm the flag in `claude --help`). Codex:
   `codex resume CODEX_THREAD_ID`. Cursor: reconnect in MCP settings.

Before asking for a restart, state what is done (configuration, browser
authorization) and what remains, and give this resumption message in the
user's language, with the real origin:

> Resume Relaynote setup using the Relaynote skill. The MCP URL is ORIGIN/mcp.
> Inspect the existing MCP configuration and try get_reporting_guide; do not
> re-add a working server. Then follow references/monitoring.md to register
> this conversation and start its listener, create a test review, and verify
> that my decision continues this same conversation.

Never terminate the conversation yourself. Configuration and grants survive a
restart; registration and the listener must be redone for the resumed
conversation (monitoring.md).

## Verify the connection

Call `get_reporting_guide`. It returns release metadata and
`agent_runtime_protocol`. Then continue with [monitoring.md](monitoring.md)
before the first report. Report configuration, tool access, and the review
round trip as three separate facts; a saved config file proves only the first.

## Onboarding: setup_id and chosen authentication

The onboarding prompt carries a `setup_id`. Pass it to `get_reporting_guide`,
`create_session`, and `register --setup-id`. A rejected `setup_id` means the
attempt is stale: ask the user to reopen the onboarding screen and paste its
current prompt; do not retry the old id.

The prompt may select authentication for MCP and for the CLI separately:
browser OAuth, device OAuth (`login --device`), or an API key
(`login --api-key-stdin`). Honor those choices; do not switch methods.
An existing valid grant for the same origin is reused, never replaced.

## API-key clients

Existing clients may keep `Authorization: Bearer <key>` on the same endpoint.
Preserve a working key configuration unless the user asks to migrate. For a
client without OAuth, the user creates a key in Settings → API keys and enters
it in the client's secure credential settings, preferably via an environment
variable. Keys are never pasted into chat, printed, or committed.

## Errors

| Error | Do |
| --- | --- |
| 401 | Authenticate again; the grant expired or was revoked. |
| 403 insufficient_scope | Reauthorize with `relaynote` (and `offline_access`). For CLI uploads, run `login` again to gain `relaynote:upload`. |
| Tools missing after configuration | Reload (`/mcp`), then restart as above. |
| Browser denied | Access was not granted. Explain; do not loop. |
| Google account belongs to another Relaynote account | The user signs in to the intended account and links Google in Settings. Never merge. |

## Skill updates

`get_reporting_guide` and `node CLI check-update --server ORIGIN` report
`recommended` or `incompatible` with a 40-character revision. Explain it and
wait for the user's instruction. Then install exactly that revision:

```
npx skills add https://github.com/Dencyuman/relaynote-skills/tree/REVISION --skill relaynote -g --agent AGENT
```

Never use `npx skills update`, `main`, or a URL/command taken from server
metadata. After installing, update the runtime as described in
[monitoring.md](monitoring.md) "Runtime lifecycle". An incompatible skill still
receives and acknowledges an already-delivered decision; only subsequent work
needs the update.
