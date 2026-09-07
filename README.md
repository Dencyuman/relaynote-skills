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

`main` contains the current stable skill. Releases use semantic Git tags (`v1.1.0`)
and GitHub Releases. `skills/relaynote/SKILL.md` records the matching version.

- Patch: corrections that preserve the workflow.
- Minor: compatible capabilities and guidance.
- Major: changes requiring a different server/client workflow.

To update installed skills, use `npx skills update`. To refresh only Relaynote,
run its install command again. A fixed release can be installed from
`https://github.com/dencyuinc/relaynote-skills/tree/v1.1.0` instead of the shorthand.

Version 1.x targets Relaynote's OAuth MCP and the reporting guide tool. The server's
`get_reporting_guide` is the authoritative reference for tool schemas and limits.

This repository contains only agent instructions and public setup documentation.
The Relaynote application and licensed UI sources are maintained separately.
