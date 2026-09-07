# Changelog

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
