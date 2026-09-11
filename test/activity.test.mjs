import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
// The module reads the home at import time: point every home at a temp dir BEFORE importing it.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rn-activity-"));
process.env.RELAYNOTE_HOME = path.join(dir, "auth");
process.env.RELAYNOTE_ACTIVITY_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
const {
  acceptsActivity,
  classifyTail,
  hostOf,
  projectSlug,
  readTail,
  resolveTranscript,
} = await import("../skills/relaynote/scripts/lib/activity.mjs");
const lines = (...entries) => entries.map((e) => JSON.stringify(e));
// Structural fixtures only: every text, path and id from the real transcripts is a placeholder.
const assistant = (stop, extra = {}) => ({
  type: "assistant",
  message: { role: "assistant", stop_reason: stop, content: [] },
  ...extra,
});
const toolResult = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "…" }] },
};
const codexEvent = (type) => ({
  timestamp: "2026-09-12T05:01:58.000Z",
  type: "event_msg",
  payload: { type },
});

test("Claude Code: the newest assistant/user entry decides, bookkeeping lines do not", () => {
  assert.deepEqual(
    classifyTail("claude-code", lines(assistant("tool_use"), toolResult)),
    { state: "working", marker: "tool_result" },
  );
  assert.deepEqual(classifyTail("claude-code", lines(assistant("tool_use"))), {
    state: "working",
    marker: "tool_use",
  });
  // A completed turn stays completed across the bookkeeping types written after it.
  assert.deepEqual(
    classifyTail(
      "claude-code",
      lines(
        toolResult,
        assistant("end_turn"),
        { type: "system", subtype: "note" },
        { type: "attachment" },
      ),
    ),
    { state: "responded", marker: "end_turn" },
  );
  // …but not across a later user entry: the conversation moved on.
  assert.deepEqual(
    classifyTail("claude-code", lines(assistant("end_turn"), toolResult)),
    { state: "working", marker: "tool_result" },
  );
  assert.deepEqual(
    classifyTail(
      "claude-code",
      lines(assistant(null, { isApiErrorMessage: true })),
    ),
    { state: "detached", marker: "api_error" },
  );
  // A truncated first line (the 64 KB tail cut a record in half) is ignored, not fatal.
  assert.deepEqual(
    classifyTail("claude-code", [
      '{"type":"assist',
      ...lines(assistant("end_turn")),
    ]),
    { state: "responded", marker: "end_turn" },
  );
  assert.deepEqual(classifyTail("claude-code", []), { state: "working" });
});

test("Codex and Orca: the newest turn event after which nothing happened", () => {
  assert.deepEqual(
    classifyTail(
      "codex",
      lines(
        codexEvent("task_started"),
        { type: "response_item", payload: { type: "reasoning" } },
        codexEvent("item_completed"),
        codexEvent("task_complete"),
      ),
    ),
    { state: "responded", marker: "task_complete" },
  );
  assert.deepEqual(
    classifyTail(
      "codex",
      lines(
        codexEvent("task_complete"),
        codexEvent("task_started"),
        codexEvent("token_count"),
      ),
    ),
    { state: "working", marker: "task_started" },
  );
  assert.deepEqual(
    classifyTail("codex", lines(codexEvent("task_started"), codexEvent("turn_aborted"))),
    { state: "detached", marker: "turn_aborted" },
  );
  // Orca hosts Codex: same format, same answers.
  assert.deepEqual(
    classifyTail("orca", lines(codexEvent("task_complete"))),
    { state: "responded", marker: "task_complete" },
  );
});

test("Cursor CLI: the turn_ended trailer, and anything else is mid-turn", () => {
  assert.deepEqual(
    classifyTail(
      "cursor-cli",
      lines(
        { role: "assistant", message: { content: [{ type: "text", text: "…" }] } },
        { type: "turn_ended", status: "success" },
      ),
    ),
    { state: "responded", marker: "turn_ended" },
  );
  assert.deepEqual(
    classifyTail("cursor-cli", lines({ type: "turn_ended", status: "error" })),
    { state: "detached", marker: "turn_ended_error" },
  );
  assert.deepEqual(
    classifyTail("cursor-cli", lines({ type: "tool_call", name: "…" })),
    { state: "working", marker: "tool_call" },
  );
});

test("hosts without a transcript are untracked, never guessed", async () => {
  assert.deepEqual(classifyTail("opencode", lines(assistant("end_turn"))), {
    state: "untracked",
  });
  assert.deepEqual(classifyTail("devin", []), { state: "untracked" });
  assert.equal(await resolveTranscript("devin", { thread: "t" }), null);
  assert.equal(await resolveTranscript("opencode", { thread: "t" }), null);
});

test("resolveTranscript follows each host's own naming rule", async () => {
  const home = process.env.RELAYNOTE_ACTIVITY_HOME;
  // Verified against ~/.claude/projects: every character outside [A-Za-z0-9-] becomes one dash,
  // the leading slash included.
  assert.equal(
    projectSlug("/Users/x/orca/workspaces/img-share-mcp/i18n対応言語を追加"),
    "-Users-x-orca-workspaces-img-share-mcp-i18n-------",
  );
  assert.equal(
    await resolveTranscript("claude-code", {
      brand: "claude-code",
      thread: "session-1",
      workspace: "/Users/x/dev/my_repo",
    }),
    path.join(home, ".claude/projects/-Users-x-dev-my-repo/session-1.jsonl"),
  );
  // Cursor uses the same slug without the leading dash.
  assert.equal(
    await resolveTranscript("cursor-cli", {
      brand: "cursor-cli",
      thread: "abc",
      workspace: "/private/tmp/probe",
    }),
    path.join(
      home,
      ".cursor/projects/private-tmp-probe/agent-transcripts/abc/abc.jsonl",
    ),
  );
  // Without a registered workspace there is no slug and therefore no file.
  assert.equal(
    await resolveTranscript("claude-code", {
      brand: "claude-code",
      thread: "session-1",
    }),
    null,
  );
  // A thread is an opaque host id; it never escapes its directory.
  assert.equal(
    await resolveTranscript("claude-code", {
      brand: "claude-code",
      thread: "../../escape",
      workspace: "/w",
    }),
    null,
  );
  assert.equal(hostOf({ adapter: "orca", brand: "codex" }), "orca");
  assert.equal(hostOf({ adapter: "host-task", brand: "claude-code" }), "claude-code");
});

test("the Codex rollout is found by glob and the newest match wins", async () => {
  const thread = "01a09210-0426-77c3-8eed-067642986754";
  const day = path.join(process.env.CODEX_HOME, "sessions/2026/09/12");
  await fs.mkdir(day, { recursive: true });
  const older = path.join(day, `rollout-2026-09-12T05-01-58-${thread}.jsonl`),
    newer = path.join(day, `rollout-2026-09-12T09-30-00-${thread}.jsonl`);
  await fs.writeFile(older, lines(codexEvent("task_started")).join("\n") + "\n");
  await fs.writeFile(newer, lines(codexEvent("task_complete")).join("\n") + "\n");
  const past = new Date(Date.now() - 60000);
  await fs.utimes(older, past, past);
  const reg = { brand: "codex", adapter: "codex", thread };
  assert.equal(await resolveTranscript("codex", reg), newer);
  const tail = await readTail(newer);
  assert.deepEqual(classifyTail("codex", tail.lines), {
    state: "responded",
    marker: "task_complete",
  });
  assert.match(tail.lastWriteAt, /^\d{4}-\d\d-\d\dT/);
  // A thread with no rollout file is untracked rather than a guessed path.
  assert.equal(
    await resolveTranscript("codex", { ...reg, thread: "missing-thread" }),
    null,
  );
});

test("activity is sent only to a server that advertises the capability", () => {
  assert.equal(acceptsActivity({ agent_activity: 1, delivery_protocol: 4 }), true);
  assert.equal(acceptsActivity({ agent_activity: 1, delivery_reason: 1 }), true);
  assert.equal(acceptsActivity({ delivery_protocol: 4 }), false);
  assert.equal(acceptsActivity({ agent_activity: 1 }), false);
  assert.equal(acceptsActivity(null), false);
});

test.after(() => fs.rm(dir, { recursive: true, force: true }));
