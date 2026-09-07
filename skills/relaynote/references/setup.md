# Connect Relaynote

Production endpoint: `https://relaynote.dencyu.co.jp/mcp`.
Onboarding: `https://relaynote.dencyu.co.jp/app/onboarding`.
Settings, including Google linking and AI connection revocation:
`https://relaynote.dencyu.co.jp/app?view=settings`.

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

## Codex

Check `codex mcp get relaynote` (or `codex mcp list`) first. For a new connection:

```bash
codex mcp add relaynote --url https://relaynote.dencyu.co.jp/mcp
codex mcp login relaynote --scopes relaynote,offline_access
```

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
claude mcp add --transport http --scope user relaynote https://relaynote.dencyu.co.jp/mcp
```

Use `/mcp` to select Relaynote and authenticate. The slash menu may require the
user's interaction; explain this single step. Do not claim a shell command can
operate an interactive slash menu. Only for a requested OAuth migration, remove an old static-key entry through the
client's supported commands before re-adding, preserving other servers.

## Cursor

Inspect the selected scope: `.cursor/mcp.json` for a project, or
`~/.cursor/mcp.json` for the user. Merge this entry into `mcpServers`:

```json
{
  "relaynote": {
    "url": "https://relaynote.dencyu.co.jp/mcp"
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

## Background continuation setup

If the user selected Codex or Claude Code, follow [background.md](background.md)
to install the bundled CLI user service and authorize its own OAuth connection.
Verify a fresh daemon heartbeat. For other clients explain the wait-only support.
Do not treat `skills add` alone as installing or enabling a background service.

## Verify and recover

Once tools are available, call `get_reporting_guide`, then `create_session` with a
short, clearly labeled connection review. Share the returned session URL. Invite
the user to approve or request a change, and read the result with
`wait_for_review` / `get_session_review`. Report configuration, authenticated tool
access, and the review round trip separately; do not mark all three complete
merely because a file was written.

- 401: authenticate again; the grant may have expired or been disconnected.
- 403 insufficient_scope: reauthorize with `relaynote` (and `offline_access` for
  refresh tokens).
- Missing tools after configuration: reload/restart the client, then retry.
- Browser denial: explain that access was not granted; do not retry indefinitely.
- Google account already belongs to another Relaynote account: do not merge data
  yourself. Have the user sign in to the intended account and link Google in Settings.

## Skill updates

The public distribution source is `dencyuinc/relaynote-skills`.
`npx skills update` updates installed skills (possibly more than Relaynote).
For a Relaynote-only refresh, reinstall from the same source and selected agent:

```bash
npx skills add dencyuinc/relaynote-skills --skill relaynote -g
```

Stable releases use Git tags. To deliberately install a specific release:

```bash
npx skills add https://github.com/dencyuinc/relaynote-skills/tree/v1.0.0 --skill relaynote -g
```

A pinned release should move only when requested; do not silently replace it with
main. `metadata.version` documents the release; the Git source/ref determines the
installed content. Skill updates do not automatically register or authenticate MCP.
