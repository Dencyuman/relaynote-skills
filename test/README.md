# Verification

`node --test test/*.test.mjs` exercises the real watcher CLI against a temporary
MCP fixture and checks reconnects, comment edits, decisions, saved cursors,
delivery failures, and exact-thread queue arguments. It does not invoke an AI.

`node test/codex-origin.mjs` is an explicit manual integration test. It requires
an authenticated Codex CLI, starts an isolated local app-server, creates one
TEST conversation, lets its first turn complete, queues an event to the same
thread, and verifies that the answer retains the original phrase. It never
uses exec/resume to deliver the follow-up. The test server closes afterward.

The watcher itself never creates that test conversation; the test harness does.
Runtime results, including the actual Relaynote comment/decision tests through
Claude Monitor and Codex queue, are in `evidence/2026-09-08.json`.

Claude interactive reproduction:
1. Authenticate the bridge to a test Relaynote account; create a test review.
2. In a fresh TEST conversation, ask Claude to remember a unique phrase and
   start Monitor with `persistent:true` and the documented CLI watch command.
3. Wait for its ARMED final response, then leave it idle for at least 65 seconds.
4. Submit a comment using the review UI. Do not send another chat message.
5. Verify the automatic answer contains the phrase and comment.
6. Submit a change request. Verify a second answer in the identical conversation.
7. Stop the monitor and revoke the test credential.

Cursor CLI interactive verification also passed: native background Shell task,
ARMED final response, 65-second delayed task completion, original phrase retained;
then a real local Relaynote comment received in that same conversation.
Standalone CLI tests do not verify embedded applications or the Cursor editor.
