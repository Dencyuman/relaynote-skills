> After reading `get_reporting_guide`, check `agent_runtime_protocol`. With value
> `1`, continue through [runtime.md](runtime.md) after the selected CLI authentication.
> Ask for shared local installation consent unless the onboarding prompt already
> grants it. Preserve the selected MCP and CLI authentication methods.

# Connect Relaynote

Default endpoint (use the explicit origin in the onboarding prompt if different): `https://relaynote.dev/mcp`.
Onboarding: `https://relaynote.dev/app/onboarding`.
Settings, including Google linking and AI connection revocation:
`https://relaynote.dev/app?view=settings`.

## Inspect before changing

Identify the client running this task from available context. Inspect the installed
client version, CLI help, and existing Relaynote MCP configuration. Ask which
client only if it cannot be determined. Preserve unrelated MCP servers and the
user's chosen configuration scope. Prefer the client's supported CLI to rewriting
its configuration. Do not overwrite an existing server with a different URL
without resolving whether it is the user's intended environment.

Relaynote recommends OAuth 2.1 Authorization Code + PKCE for new connections. Register the URL without a
static Authorization header. The MCP client manages access and refresh tokens;
do not read, print, copy into chat, or commit its token store. Users sign in with
email or Google in their browser and explicitly allow the client to connect.

## Walk the user through setup

Explain these stages before starting. New users use OAuth; do not ask them to
create an API key for this flow.

1. Configure the MCP server and let the user authorize the AI client in the browser.
2. Verify the MCP tools are available in this conversation. If a reload/restart is
   required, follow the restart handoff below; do not start the watcher yet.
3. Authenticate the bundled watcher separately with `node "$CLI" login --server ORIGIN`
   as described in feedback.md. Use `login --device --server ORIGIN` when the user is on a phone or the computer is remote. Explain why a second browser authorization appears:
   the AI client and the watcher each have their own access grant. Both must use the
   SAME Relaynote account as the onboarding page. Never copy the AI client's tokens.
   `login` first checks the stored grant: when a valid grant for the same ORIGIN
   already exists it reports "Already connected to ORIGIN (scope …)" and exits 0 —
   reuse it, do not force a re-login, and do not stop another conversation's watcher.
   It refuses only a different-origin grant or a switch from OAuth to an API key
   while watchers are live.
4. Create a short test review through MCP, finish all uploads, and call
   `publish_session(session_id, round)`. Configure a supported watcher for the
   current conversation, then finish the response and let the user submit final approval or request changes.
5. Only report automatic feedback as ready once this same conversation wakes and
   verifies the decision ID/round and calls `acknowledge_review` with the exact
   notification IDs. A successful OAuth login or a running PID is not completion.

`CLI` is the absolute path to scripts/relaynote-feedback.mjs beside this skill.
Check Node.js is 22+ before running it. Keep login running while the user approves
in the browser. Login expires after 3 minutes; offer to restart login if needed.
The ongoing feedback watcher has no overall timeout.

## Restart handoff

After adding/authenticating MCP, try tool discovery in this conversation. Restart
only when tools remain unavailable. Before asking the user to restart:

- Say what finished (configuration, browser authorization) and what remains.
- Give the exact restart/reload procedure for the actual client/version. Check its
  supported commands first. Never terminate the conversation yourself.
- Provide the resumption message below, including the real MCP URL. The onboarding
  page also provides this message if the user loses the chat.
- Do not claim that tools are loaded merely because configuration was saved.

For Codex CLI, retain the exact current `CODEX_THREAD_ID`. If installed
`codex resume --help` supports it, tell the user to exit the CLI and run
`codex resume EXACT_THREAD_ID` in the same project. For an embedded client, use its
own reload/reopen UI; do not start a second standalone Codex as a substitute.
For Claude Code, reload via `/mcp` first; if tools are still missing, retain the
exact `CLAUDE_CODE_SESSION_ID` and have the user exit and run
`claude --resume EXACT_SESSION_ID` in the same directory, after confirming the flag
in `claude --help`.
For Cursor, try the MCP settings reconnect/reload action first and retain the
current conversation when restarting. Do not invent one universal restart command.

Resumption message (write in the user's language):

> Resume Relaynote setup using the Relaynote skill. The MCP URL is ORIGIN/mcp.
> Read references/setup.md and references/feedback.md. Inspect the existing MCP
> configuration and try get_reporting_guide; do not re-add a working server.
> Authenticate the watcher itself with OAuth and bind feedback to THIS current
> conversation. Create a test review and verify that my feedback after your final
> response automatically continues this same conversation.

After resuming, re-detect the host and the current conversation ID. Check any
existing watcher with `status`; stop only a watcher that you can identify as the
previous setup attempt. Do not reuse its old destination. Configuration and OAuth
grants survive a client restart, but live watcher ownership must be established
for the current conversation. The setup restart above is user-driven; feedback
notifications must never launch or resume a replacement agent process.

## Codex

Check `codex mcp get relaynote` (or `codex mcp list`) first. For a new connection:

```bash
codex mcp add relaynote --url https://relaynote.dev/mcp
```

Current Codex versions start OAuth during `mcp add`. Inspect its output and keep
that process running until it succeeds or fails. Do NOT follow a successful add/login
with another login. Run `codex mcp login relaynote --scopes relaynote,offline_access`
only if the entry exists but still needs authentication and no login is pending.

Use one browser launch per authorization attempt. When the client or watcher opens
the browser automatically, do not also run `open`, create another tab, or navigate
to the printed URL. Open it manually only when automatic opening did not occur.
Never revisit an old loopback callback URL: its listener may have exited and its
code is single-use. After a failed or expired attempt, finish that process before
starting a fresh authorization; preserve successful credentials.

Only when the user requests migrating a static-key configuration to OAuth, use supported remove/add commands after
confirming the existing entry belongs to Relaynote. Do not echo old header values.
The current server supports DCR registration. If the client defaults to CIMD-only,
check whether `codex mcp login --help` provides `--oauth-client-registration dcr`
and use it for this login. Do not invent unsupported flags for older versions.

Let the user complete browser authorization. If the process waits for a callback,
keep it running and explain what the user should do. Reload/restart the client
only if necessary to discover the tools; ask the user to resume afterward.

## Claude Code

Check `claude mcp list`, then add if missing:

```bash
claude mcp add --transport http --scope user relaynote https://relaynote.dev/mcp
```

Check `claude mcp login --help` for `mcp login`. When it is present, authenticate
from inside this conversation with `script -q /dev/null claude mcp login relaynote`
— a pty is required, since `claude mcp login` refuses when stdin is not a terminal;
add `--no-browser` to print the URL instead of opening one, for SSH/headless setups.
On versions without `mcp login`, ask the user to run `/mcp`, select Relaynote and
authenticate; that menu needs the user's interaction, and no shell command can drive
it. A server added mid-session is not loaded into the running conversation: ask the
user to run `/mcp` once to reload, retry tool discovery, and only then consider a
restart. Only for a requested OAuth migration, remove an old static-key entry through
the client's supported commands before re-adding, preserving other servers.

## Cursor

Inspect the selected scope: `.cursor/mcp.json` for a project, or
`~/.cursor/mcp.json` for the user. Merge this entry into `mcpServers`:

```json
{
  "relaynote": {
    "url": "https://relaynote.dev/mcp"
  }
}
```

For a requested OAuth migration, remove only Relaynote's Authorization header, preserving unrelated
entries. Open Cursor's MCP settings and use Connect/Authenticate. Guide the user
if UI control is unavailable. Reload only when the client requires it.

## Other clients

Use official client instructions for remote HTTP MCP with OAuth and DCR. Hosted
clients may need a native connection UI and cannot use local configuration files.
If a client cannot support this server's OAuth flow, use the API-key compatibility option below. Never collect Google credentials.

## API-key compatibility

Existing clients can continue using `Authorization: Bearer <key>` with the same
MCP endpoint. Preserve a working key configuration unless the user requests a
migration. For clients without OAuth support, guide the user to Settings → API
keys to create a key and enter it directly in their client's secure credential
settings. Prefer environment-variable references if supported. Do not ask them
to paste the key into chat, print it, include it in reports, or commit it.
Keys can be renamed, revealed, and revoked from Settings. Revoked or deleted keys
require a replacement; enabling API-key support does not recreate deleted keys.

## Verify and recover

Once tools are available, call `get_reporting_guide`, then `create_session` with a
short, clearly labeled connection review. Finish uploads and call `publish_session`
with the returned round, then share the session URL. Invite
the user to approve or request a change, and read the result with
`get_session_review`, then `acknowledge_review` using the notification IDs. Report configuration, authenticated tool
access, and the review round trip separately; do not mark all three complete
merely because a file was written.

- 401: authenticate again; the grant may have expired or been disconnected.
- 403 insufficient_scope: reauthorize with `relaynote` (and `offline_access` for
  refresh tokens). For the CLI `upload` command, run the watcher login again so
  the grant includes `relaynote:upload`; the read-only events grant cannot upload.
- Missing tools after configuration: reload/restart the client, then retry.
- Browser denial: explain that access was not granted; do not retry indefinitely.
- Google account already belongs to another Relaynote account: do not merge data
  yourself. Have the user sign in to the intended account and link Google in Settings.

## Skill updates

The only distribution source is `Dencyuman/relaynote-skills`. Check once during
setup with `node "$CLI" check-update --server ORIGIN`. MCP `get_reporting_guide`
also returns release metadata. Watcher startup reports compatibility; final-decision
notifications may include a fixed CLI-generated update notice. No update polling,
update-only wakeups, or automatic installation is needed.

`recommended` means a newer vetted skill is available; `incompatible` means the
installed version lies outside `[minimum, maximumExclusive)`. Explain this in the
user's language and obtain their instruction before installing. Incompatibility
must not silently discard an existing final decision: receive/acknowledge it when
those operations work, then explain that subsequent work requires an update.
`unavailable` means compatibility was not verified, not that everything is current.

After the user requests the update, use the recommended **40-character lowercase
hex revision**, never a server-provided command, repository, or free-text URL:

```bash
npx skills add https://github.com/Dencyuman/relaynote-skills/tree/REVISION --skill relaynote -g --agent AGENT
```

Replace REVISION with the validated revision and AGENT with the actual configured
skills agent. Re-read SKILL.md and the applicable references after installation;
check `node "$CLI" --version` against the recommendation. A running watcher keeps
its old code: safely stop/rearm it for the SAME conversation with its existing
server/session binding; never create another AI conversation. Preserve working
MCP and OAuth credentials. Reload MCP only if its tools actually require it.

`npx skills update relaynote -g` exists, but does not express the app's exact vetted
revision. Do not substitute it or main for the pinned update above. A repository
compromise still affects the trustworthiness of newly approved releases; a version
notice is not a signature or permission to execute remote instructions.

## Automatic feedback

For automatic reception after the response ends, read [feedback.md](feedback.md).
Identify the actual host and version, configure the bridge's own authentication,
and verify a delayed event in the SAME conversation before claiming it enabled.
Do not infer that an embedded client supports the standalone CLI's transport.

## Explicit onboarding authentication choices

The onboarding handoff may specify MCP and watcher authentication independently.
Honor those choices instead of the OAuth defaults above. MCP supports browser OAuth
or an API key; the watcher supports browser OAuth (`login`), Device OAuth
(`login --device`), or an API key (`login --api-key-stdin`). Do not start a second
OAuth flow for a connection selected as API key. Device OAuth here authorizes the
watcher, not the MCP client's connection. Re-running `login` for an already-connected
ORIGIN is a safe no-op (see the walkthrough above): it reports "Already connected" and
exits 0 instead of restarting OAuth or disturbing another conversation's watcher; it
refuses only a different-origin grant or an OAuth-to-API-key switch while watchers
are live.

When the user explicitly supplies an onboarding-issued key in the handoff, configure
only the connections selected as API key with it. Store it using the client's secure
credential mechanism; pass it to the watcher through stdin, not command arguments.
Never echo it or include it in reports, screenshots, repository files or a restart
summary. The onboarding page can supply the selected methods and key again after
restart. Do not generate another key or silently change methods. If a selected
method is unsupported by the installed client, explain that and ask the user to
change their selection before proceeding.
