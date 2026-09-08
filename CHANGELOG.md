# Changelog

## 2.0.1 — 2026-09-09

- Honor separate MCP and watcher authentication choices from onboarding, including explicitly supplied API keys and restart handoffs.

## 2.0.0 — 2026-09-09

- Require a WebSocket Hibernation server. No polling fallback, no idle model calls.
- Add device OAuth with a read-only watcher scope, reconnect snapshots, and expiration handling.
- Add Stop hook formats, configurable HTTP delivery, and an ACP/Amp bridge that owns the original process.
- Add host recipes for the documented A/B environments. Existing live evidence remains dated; new recipes are documentation-based.

## 1.4.0 — 2026-09-09

- Replace the 3-second polling loop with a single long-poll request held up to 300 seconds, cutting a watcher's daily request count from roughly 57,600 to a few hundred.
- Wake the watcher on ANY human feedback (decision, comment, form answer, table edit) via `wait_for_review` with `wait_for: "any_change"` and an `updated_at` cursor passed back as `since`.
- Fall back automatically to polling (3s for 10 minutes, then 15s) when the server omits `updated_at` or rejects the new arguments; `status` reports `mode`.
- Back off exponentially from 3 to 60 seconds on transient network failures, and abort an in-flight request immediately on stop.

## 1.3.2 — 2026-09-08

- Guide new users through separate OAuth grants for MCP and the feedback watcher.
- Add an explicit restart handoff with a resumption prompt and current-conversation rebinding.
- Require an actual automatic feedback round trip before claiming setup complete.
- Verify the real browser consent flow, refresh, persisted OAuth credentials in a new CLI process, and comment receipt against the local Relaynote server without an API key.

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
