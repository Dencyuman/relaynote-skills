# Changelog

## 1.3.1 — 2026-09-08

- Fix same-conversation wake-up for Codex inside Orca using its public terminal input API.
- Pin the original runtime, terminal incarnation, workspace, tab, and Codex process; stop on replacement.
- Wait for the original terminal to be idle without an overall monitoring deadline.
- Verify actual production review delivery after a final response in the original conversation; detached stdout notification alone failed in this host.

## 1.3.0 — 2026-09-08

- Add a lightweight feedback observer that never starts a replacement AI conversation.
- Deliver events through Claude Code Monitor, Codex existing-thread queue, and Cursor CLI background-task completion.
- Verify same-conversation continuation after final responses on all three CLIs, including real local Relaynote comments.
- Support comment/form/table changes as well as decisions, reconnects, persisted cursors, and explicit cancellation.
- Keep embedded apps and editor surfaces explicitly unverified until their own wake-up test passes.

## 1.2.2 — 2026-09-08

- Remove the background CLI and its setup instructions. It started a separate agent conversation instead of resuming the originating conversation.
- Retain MCP setup and the report/review workflow.

## 1.2.1 — 2026-09-07

- Recheck authorization and the exact review decision immediately before launching an AI.

## 1.2.0 — 2026-09-07

- Bundle a Node.js CLI with its own OAuth login and refresh.
- Install a user service to monitor reviews without keeping an AI turn active.
- Start one Codex or Claude Code background conversation from an explicit handoff after a decision.
- Add job status, cancellation, round checks, and duplicate-launch protection.

## 1.1.0 — 2026-09-07

- Preserve existing API-key clients alongside the recommended OAuth setup.
- Guide clients without OAuth to secure key setup in Settings.
- Only migrate existing authentication when requested.

## 1.0.0 — 2026-09-07

- OAuth setup for Codex, Claude Code, and Cursor.
- Connection verification and first human review walkthrough.
- Guidance for reports, screenshots, forms, tables, and revision rounds.
- Versioned releases and skill update instructions.
