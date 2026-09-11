# Relaynote skills

Official agent skill for [Relaynote](https://relaynote.dev), maintained by DencyuSystems
Share AI work as review sessions and receive contextual comments, answers, and approvals.

```bash
# Pin the release the Relaynote app currently recommends (shown on the onboarding page):
npx skills add https://github.com/Dencyuman/relaynote-skills/tree/<REVISION> --skill relaynote -g
```

Add `--agent codex`, `--agent claude-code`, or `--agent cursor` to select a client.
Ask your AI to use the Relaynote skill to set up OAuth and create your first review.
A Relaynote account and a remote MCP client are required. OAuth is recommended; existing API-key configurations remain supported and can be managed in Settings.

On servers advertising `agent_runtime_protocol: 1`, version 3.5.0 can place the
bundled runtime in a shared user directory after explicit consent. Registered AI
conversations then share one connection and account authentication across worktrees.
See [monitoring](skills/relaynote/references/monitoring.md). A live host-owned
listener is still required where the harness has no direct same-conversation API.
Older servers keep the existing per-review Hibernation workflow; no polling fallback.
See [monitoring](skills/relaynote/references/monitoring.md) for actual prerequisites.

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
See [setup](skills/relaynote/references/setup.md) and [legacy](skills/relaynote/references/legacy.md).
It never creates a replacement AI conversation. Setup verifies the actual
harness and uses its supported delivery path; an embedded app or editor is not
automatically covered by testing its standalone CLI.

Validation: `node --test test/*.test.mjs`.

## Final-decision protocol (3.0)

Create a draft, upload everything, then call `publish_session`. Comments and form
edits save without waking an AI. Final approval or a request for changes triggers
the watcher, bound to exactly one originating conversation. Relaynote shows the
transport result and a separate AI receipt (`acknowledge_review`). A follow-up
starts with `begin_revision` and is explicitly published after uploads complete.

Upgrade the server and skill together. Old servers are rejected by the 3.0 CLI;
there is no polling fallback. `npx skills update` updates installed skills from
their source. Use the repository's release tag when a fixed version is needed.


## Notify Relaynote after a release

Publishing a stable GitHub Release (`vX.Y.Z`, not a prerelease/draft) runs
`.github/workflows/notify-relaynote.yml`. It dispatches the tag to
`Dencyuman/relaynote` for compatibility checks and a recommendation-update PR.
Pushing a tag without publishing a Release does not notify the app.

Install the receiver workflow in Relaynote first. Set the repository Actions
secret `RELAYNOTE_AUTOMATION_TOKEN` to a dedicated fine-grained token with
Contents read/write on `Dencyuman/relaynote` (the receiver also needs Pull requests
read/write). Do not put a personal token in source or release notes. This workflow
executes no released skill code and only sends a validated tag to the fixed repo.

The receiver validates the published release, resolves and pins its commit, tests
both projects and the version API/CLI contract, and preserves the supported range
and app version. Unsupported versions or failures require manual review; they do
not update production. Retry with the workflow's manual `tag` input after resolving
the failure. Check the receiving **Skill release compatibility** workflow as well:
a successful dispatch means accepted delivery, not successful compatibility tests.
