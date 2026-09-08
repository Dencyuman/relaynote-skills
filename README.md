# Relaynote skills

Official agent skill for [Relaynote](https://relaynote.dencyu.co.jp), maintained by DENCYU Inc.
Share AI work as review sessions and receive contextual comments, answers, and approvals.

```bash
npx skills add Dencyuman/relaynote-skills --skill relaynote -g
```

Add `--agent codex`, `--agent claude-code`, or `--agent cursor` to select a client.
Ask your AI to use the Relaynote skill to set up OAuth and create your first review.
A Relaynote account and a remote MCP client are required. OAuth is recommended; existing API-key configurations remain supported and can be managed in Settings.

Release 2.0.0 adds host-specific adapters and requires the new
WebSocket Hibernation server. Keep 1.4.0 on the old server until the server migration.
See [host recipes](skills/relaynote/references/agents.md) for the expanded A/B list,
Device OAuth, and same-process delivery setup. New recipes are documentation-based;
they are not additional live verification claims.

## Releases

`main` contains the current stable skill. Releases use semantic Git tags (`v1.4.0`)
and GitHub Releases. `skills/relaynote/SKILL.md` records the matching version.

- Patch: corrections that preserve the workflow.
- Minor: compatible capabilities and guidance.
- Major: changes requiring a different server/client workflow.

To update installed skills, use `npx skills update`. To refresh only Relaynote,
run its install command again. A fixed release can be installed from
`https://github.com/Dencyuman/relaynote-skills/tree/v1.4.0` instead of the shorthand.

The reporting workflow targets Relaynote's OAuth MCP and the reporting guide tool. The server's
`get_reporting_guide` is the authoritative reference for tool schemas and limits.

This repository contains agent instructions, public setup documentation, and the lightweight feedback CLI.
The Relaynote application and licensed UI sources are maintained separately.

## Same-conversation feedback bridge

The skill contains a lightweight feedback watcher. Claude Code Monitor and Codex
queue delivery, and Cursor CLI background-shell completion were tested against
actual local Relaynote reviews. Codex inside Orca also supports delivery to the
original terminal, verified against a production review after a final response.
See [the compatibility and setup guide](skills/relaynote/references/feedback.md).
It never creates a replacement AI conversation. Setup verifies the actual
harness and uses its supported delivery path; an embedded app or editor is not
automatically covered by testing its standalone CLI.

Validation: `node --test test/*.test.mjs`.
