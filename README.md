# Relaynote skills

Official agent skill for [Relaynote](https://relaynote.dencyu.co.jp), maintained by DENCYU Inc.
Share AI work as review sessions and receive contextual comments, answers, and approvals.

```bash
npx skills add dencyuinc/relaynote-skills --skill relaynote -g
```

Add `--agent codex`, `--agent claude-code`, or `--agent cursor` to select a client.
Ask your AI to use the Relaynote skill to set up OAuth and create your first review.
A Relaynote account and a remote MCP client are required. OAuth is recommended; existing API-key configurations remain supported and can be managed in Settings.

## Releases

`main` contains the current stable skill. Releases use semantic Git tags (`v1.2.0`)
and GitHub Releases. `skills/relaynote/SKILL.md` records the matching version.

- Patch: corrections that preserve the workflow.
- Minor: compatible capabilities and guidance.
- Major: changes requiring a different server/client workflow.

To update installed skills, use `npx skills update`. To refresh only Relaynote,
run its install command again. A fixed release can be installed from
`https://github.com/dencyuinc/relaynote-skills/tree/v1.2.0` instead of the shorthand.

Version 1.x targets Relaynote's OAuth MCP and the reporting guide tool. The server's
`get_reporting_guide` is the authoritative reference for tool schemas and limits.

This repository contains agent instructions, a dependency-free Node.js background watcher CLI, and public setup documentation.
The Relaynote application and licensed UI sources are maintained separately.

## Background continuation

The installed skill includes `scripts/relaynote.mjs`. Ask your AI to follow the
skill's background setup: install the user service, authorize OAuth in your
browser, and register an explicit handoff for the review. Codex and Claude Code
can start a new background conversation when you approve or request changes.
Cursor and other clients currently support waiting only.

Requires Node.js 22+, a supported AI CLI, and macOS launchd or Linux systemd user
services. `skills add` only installs files; the skill guides service setup.
See [the full setup and limitations](skills/relaynote/references/background.md).

## Validation

`node --test test/watcher.test.mjs` checks credential permissions, MCP responses, round guards, one-time dispatch, cancellation, failed runs, and bounded revision follow-up.

`test/watcher-integration.mjs` exercises a local Relaynote instance with `RELAYNOTE_TEST_COOKIE`. The default uses a fake harness; `RELAYNOTE_REAL_AGENT=1` explicitly enables a real Codex invocation. The macOS service lifecycle, local OAuth PKCE/refresh, and actual Codex and Claude Code launches were also verified during development. Linux service installation has not been exercised on a Linux host.
