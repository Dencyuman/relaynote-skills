## 4.1.0

- Identify an Orca conversation by its terminal, not by the processes serving it. The generation
  fingerprint covers `(incarnationId, tabId, worktreeId)` and the thread; a re-issued `term_…`
  handle or a restarted Codex is adopted and persisted instead of refused, and re-registering the
  same terminal keeps the generation, so attached sessions are no longer orphaned.
- Before each Orca send the terminal is re-resolved through `orca terminal list --json` (falling
  back to the stored handle) and required to be connected, writable and not orphaned with the same
  incarnation and tab. A different tab, incarnation or worktree is still an outright refusal.
- Every delivery failure reports a reason: `identity`, `busy`, `transport_unknown`,
  `listener_absent` or `auth`. The reason is sent with `failed` only when the session snapshot
  advertises `delivery_reason: 1` or `delivery_protocol` 4, and logged either way.
- A busy Orca terminal now has a 10-minute deadline with 1/2/5/10 s backoff instead of blocking its
  conversation forever, and a send can no longer end silently after `sending` was reported.
- A decision whose delivery the server re-minted is claimed and delivered again: the seen file
  records the delivery attempt, not only the decision id.
- A host-task delivery with no listener attached stays `waiting` instead of failing, and is
  delivered when the listener attaches.
- `AuthError` carries `.status = 401`, so a dead grant stops the daemon instead of retrying
  forever. The daemon then reports state `auth_required` for every registered conversation and logs
  one "run login again" line.
- Failures are visible: one stderr line per failure in `runtime.log`, `status` gains
  `conversations[]` with per-conversation state, listener, last error and time, `/listen` answers
  `not_registered`, `wrong_adapter` or `already_listening`, and `listen` prints that body before
  exiting 1.
- The daemon survives a single delivery's fault: listener responses have an `error` handler and
  uncaught exceptions and rejections are logged instead of ending every conversation.

## 4.0.0

- Restructure the skill around the Agent Skills specification and Anthropic's
  authoring guidance: SKILL.md is a 76-line table of contents with a copyable
  end-of-turn checklist; every reference is one level deep and files over 100
  lines carry a table of contents.
- Replace `runtime.md`, `agents.md`, `feedback.md`, `discussions.md` and
  `review-workflow.md` with `monitoring.md` (register, pair, start and verify
  this conversation's listener, host by host, as exact commands),
  `reporting.md` (all 14 block types and when to use each, including
  `comparison` and `callout`), `receiving.md` (decision and discussion
  handling in one place) and `legacy.md` (per-review watcher, host adapters
  and dated evidence for servers without the shared runtime, collapsed).
- Unify terms: **runtime** (the shared local process) and **listener** (this
  conversation's receiver). "Watcher", "bridge" and "monitor" remain only in
  `legacy.md`.
- `register` now prints the exact `listen` command for host-task adapters and a
  `verify` command, so the next step never depends on reading the skill.
- `listen --once` exits after the first delivered event, for hosts whose
  background task wakes the conversation on completion (Cursor CLI).
- Frontmatter: third-person description, `compatibility` field, version 4.0.0.
- Add `assets/example-report.json`, a complete multi-section `append_blocks`
  payload to copy from.

## 3.6.0

- Deliver submitted discussions by default. A watcher started without `--events` reads
  `discussion_protocol` from the snapshot and binds for discussions when the server
  advertises it, so a reviewer's comments reach the originating conversation without
  anyone enabling them first.
- Degrade instead of failing: a server without `discussion_protocol: 1` binds for final
  decisions only. `--events discussions` keeps its explicit, fail-loud behavior.
- Add the opt-outs `--events decisions` (watcher) and `--no-discussions` (shared runtime);
  the legacy `--events feedback` alias remains the same opt-out.
- Drop `--events decisions` from the host recipes and `describe`'s event scope so the
  documented setup no longer starts final-decisions-only by default.

## 3.5.0

- Add an explicitly installed shared runtime, copied from the bundled scripts into private user storage. One Hibernation connection per server/account/device multiplexes existing AI conversations and survives individual review closure.
- Pair registrations with the same account through MCP, preserve exact conversation generations, reuse authentication across worktrees, and expose local profile/current-conversation discovery.
- Route owner-assigned tasks through existing adapters; keep uncertain deliveries unreplayed and require AI receipt. Host-task adapters still need their real harness-owned consumer.
- Lock OAuth refresh across processes and gate runtime updates on explicit consent, a matching old version, and stopped account runtimes. No new agent conversation or OS autostart is created.
- Use the shared flow only when the server advertises `agent_runtime_protocol: 1`; older servers retain their existing Hibernation workflow.

## 3.4.0

- Link AI replies and same-round supplements to submitted discussion IDs when the app advertises `discussion_response_protocol: 1`.
- Distinguish transport acceptance, AI receipt, and a persisted answer. Keep older apps and final-decision monitoring compatible.
- Preserve the exact original conversation, explicit discussion opt-in, and no replay after ambiguous delivery.

# 3.2.0

- Re-running `login` for the server already connected prints the connection and changes nothing, so a
  same-origin re-login no longer requires stopping other conversations' watchers: they keep running and
  pick up rotated tokens themselves. `--force` reauthorizes; switching servers, or replacing OAuth with
  an API key, still refuses while watchers are live.
- `COMMAND --help` prints that command's usage before any side effect, and the banner is the same blocks
  joined; an unknown command prints it on stderr and exits 1.
- `describe` without a host id detects the originating host from this process environment and prints the
  detection; an unknown id lists the valid ones instead of just "Unknown host".
- `status` lists live watchers as a table; `--all` adds finished records and `--json` prints every stored
  field. Records carry `endedAt`, and a finished record with no usable timestamp is now pruned instead of
  surviving the week-old comparison forever.
- A stdout watcher emits `relaynote.watch.started` once its binding exists, so later silence means a
  waiting watcher rather than an unknown one.
- Watcher status writes merge into the stored record, so a concurrent field is never dropped.
- MCP, Orca and HTTP adapter failures keep the original error as `cause` and name it in the message;
  `RELAYNOTE_DEBUG` prints stacks. `--delivery http` reports a missing, unreadable or invalid
  `--adapter-file` by path.
- `--events feedback` is normalized to `decisions` with a deprecation warning; any other value is refused
  instead of silently ignored.
- `login` records the account `subject` in `auth.json` when the server hands one over.

# 3.1.0

- Report app/skill compatibility at watcher startup and on final decisions without polling or automatic updates.
- Add `check-update`; validate data-only metadata and install only an explicitly requested pinned revision.

# 3.0.7

- Default server is now `https://relaynote.dev`; setup references and README point there too.

# 3.0.6

- A session closed by its reviewer ends the watcher cleanly: the `relaynote.watch.ended`
  line carries `reason: "session_closed"` and tells the AI to stop appending to it.
  Previously the 410 surfaced as a failed watcher with an "expired" message.
- Hub close code 4003 (session closed) is recognised alongside 4001 (expired).

# 3.0.5

- Clarify inline Markdown references versus grouped link blocks (1–10 destinations); check the connected server schema before using grouped links.

# 3.0.4

- Identify the pinned watcher binding in signed WebSocket tickets so Relaynote can
  show real CLI presence before a review decision. Browser subscriptions do not
  count as CLI connections.
- Keep Hibernation-only transport and the existing conversation adapters.
- Requires the server's progress/presence update for the new connection display.

# 3.0.3

- `stop` verifies a watcher by its command line (`relaynote-feedback.mjs watch <session>`) rather than by the CLI's own path, so watchers started from an installed copy of the skill can be stopped from the repository copy and vice versa; `stop --all` reports the ones it could not verify instead of aborting.

# 3.0.2

- Every watcher now has a lifetime: `--max-hours` (default 24, max 720) ends it without a decision, and the session's `expires_at` ends it at expiry; a stdout watcher emits one `relaynote.watch.ended` line so the harness knows nothing is pending. Detached watchers can no longer accumulate for weeks.
- `status` marks vanished processes as stopped and prunes finished records older than a week; `stop --all` stops every live watcher.

# 3.0.1

- `upload`: shrink by width (1600px) with a separate height allowance (5x), so a tall stitched page capture keeps a readable width instead of collapsing to a sliver.

# 3.0.0

- Add `upload FILE --session SESSION_ID`: shrinks the image (1600px, WebP q76, via sharp / ImageMagick / cwebp / sips) and sends the bytes straight to `POST /api/sessions/:id/assets`; the printed `asset_id` goes into `append_blocks` as an `image` block, so screenshots never pass through the model. Logins now request the upload-only `relaynote:upload` scope next to the read-only events scope; a read-only grant cannot upload.
- Explicit preparing/publish lifecycle and immutable review rounds.
- Final decisions only; comments and uploads no longer wake an agent.
- Server-bound conversation identity, stale-decision checks before send, delivery receipts and AI acknowledgement.
- Requires Relaynote delivery protocol 3; no polling or replacement agent fallback.

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
