import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const source = fileURLToPath(
  new URL("../skills/relaynote/scripts/relaynote-runtime.mjs", import.meta.url),
);
function run(entry, args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => p.kill(), 12000);
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}
const frame = (value) => {
  const data = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
};
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(30);
  }
  throw Error("Timed out");
}
test("installs independent runtime once, multiplexes two host conversations and survives empty review inbox without polling", async () => {
  const dir = await fs.mkdtemp("/tmp/rn-runtime-"),
    auth = path.join(dir, "legacy");
  await fs.mkdir(auth);
  let runtime, base;
  const sockets = new Set(),
    conversations = new Map(),
    listeners = [];
  const device = randomUUID();
  let inbox = [],
    snapshots = 0,
    inboxReads = 0,
    upgrades = 0,
    decided = false;
  const deliveries = [];
  const decision = {
    id: "99999999-9999-4999-8999-999999999999",
    round: 1,
    decision: "approved",
  };
  let delivery = { delivery_id: "first", status: "waiting" };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    assert.equal(req.headers.authorization, "Bearer unit-runtime-key");
    if (req.url === "/api/agents/identity")
      return res.end(JSON.stringify({ owner_id: "owner" }));
    if (req.url === "/api/agents/register") {
      const value = {
        conversation_id:
          conversations.get(body.origin_id)?.conversation_id ?? randomUUID(),
        device_id: device,
        generation: body.generation,
      };
      conversations.set(body.origin_id, value);
      return res.end(JSON.stringify(value));
    }
    if (req.url.endsWith("/ticket")) return res.end('{"ticket":"test"}');
    if (req.url.endsWith("/inbox")) {
      inboxReads++;
      return res.end(JSON.stringify({ items: inbox }));
    }
    if (req.url.endsWith("/guard")) return res.end('{"valid":true}');
    if (req.url.includes("/devices/") && req.url.endsWith("/delivery")) {
      const row = inbox.find((i) => i.session_id === body.session_id);
      const changed = row?.request_status === body.from;
      if (changed) row.request_status = body.to;
      return res.end(JSON.stringify({ changed }));
    }
    if (req.url.endsWith("/snapshot")) {
      snapshots++;
      const id = req.url.split("/")[3];
      return res.end(
        JSON.stringify({
          session_id: id,
          current_round: 1,
          review_status: decided ? "changes_requested" : "preparing",
          delivery_protocol: 4,
          updated_at: decided ? "t2" : "t1",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          latest_review: decided ? { ...decision, delivery } : null,
          open_comments: [],
        }),
      );
    }
    if (req.url.endsWith("/delivery")) {
      deliveries.push(body);
      if (body.action === "claim")
        return res.end(JSON.stringify({ ...delivery }));
      if (["sending", "sent", "failed"].includes(body.action))
        delivery = { ...delivery, status: body.action };
      return res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.on("upgrade", (req, socket) => {
    upgrades++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (b) => {
      if ((b[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`,
    );
    socket.write(frame({ type: "ready" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(
    path.join(auth, "auth.json"),
    JSON.stringify({ base, apiKey: "unit-runtime-key" }),
  );
  const env = {
    RELAYNOTE_RUNTIME_HOME: path.join(dir, "shared"),
    RELAYNOTE_HOME: auth,
  };
  try {
    assert.equal((await run(source, ["setup"], env, dir)).code, 1);
    const setup = await run(source, ["setup", "--accept-install"], env, dir);
    assert.equal(setup.code, 0, setup.err);
    runtime = JSON.parse(setup.out).runtime;
    assert.equal((await fs.lstat(runtime)).isSymbolicLink(), false);
    assert.equal(
      (await run(source, ["setup", "--accept-install"], env, dir)).code,
      0,
    );
    const regs = [];
    for (const thread of ["thread-a", "thread-b"]) {
      const result = await run(
        runtime,
        [
          "register",
          "--adapter",
          "host-task",
          "--brand",
          "claude-code",
          "--thread",
          thread,
        ],
        env,
        dir,
      );
      assert.equal(result.code, 0, result.err);
      regs.push(JSON.parse(result.out));
    }
    assert.equal(regs[0].device_id, regs[1].device_id);
    assert.notEqual(regs[0].conversation_id, regs[1].conversation_id);
    // A host-task registration tells the agent the exact next command; it must
    // not depend on the skill text to learn about the listener.
    assert.match(regs[0].next, /listen --conversation /);
    assert.ok(regs[0].next.includes(regs[0].conversation_id));
    assert.match(regs[0].verify, /status$/);
    const streams = [];
    const exits = [];
    for (const [index, reg] of regs.entries()) {
      // The second conversation uses --once: it must exit after its first event.
      const child = spawn(
        process.execPath,
        [runtime, "listen", "--conversation", reg.conversation_id, ...(index === 1 ? ["--once"] : [])],
        { env: { ...process.env, ...env }, cwd: dir },
      );
      exits.push(new Promise((resolve) => child.on("exit", resolve)));
      listeners.push(child);
      const lines = [];
      let raw = "";
      child.stdout.on("data", (b) => {
        raw += b;
        for (let i; (i = raw.indexOf("\n")) >= 0;) {
          lines.push(JSON.parse(raw.slice(0, i)));
          raw = raw.slice(i + 1);
        }
      });
      streams.push(lines);
    }
    await until(() => streams.every((x) => x.length));
    await until(() => upgrades === 1);
    // Listener attach and the socket's ready frame each trigger one inbox refresh; wait until
    // those have drained before measuring, otherwise a slow CI runner sees one land inside the
    // idle window and the no-polling assertion fails for the wrong reason.
    const settled = async () => {
      let last = null;
      for (let i = 0; i < 25; i++) {
        const now = [snapshots, inboxReads];
        if (last && now[0] === last[0] && now[1] === last[1]) return now;
        last = now;
        await delay(200);
      }
      return last;
    };
    const counts = await settled();
    await delay(300);
    assert.deepEqual(
      [snapshots, inboxReads],
      counts,
      "idle does not read D1 snapshots/inbox",
    );
    const reg = regs[1],
      session = randomUUID();
    inbox = [
      {
        ...reg,
        session_id: session,
        binding_id: "a".repeat(32),
        current_round: 1,
        session_updated_at: "t1",
        request_id: randomUUID(),
        request_status: "pending",
        request_kind: "task",
      },
    ];
    for (const socket of sockets) socket.write(frame({ type: "changed" }));
    await until(() => streams[1].some((x) => x.session_id === session));
    assert.equal(
      streams[0].some((x) => x.session_id === session),
      false,
    );
    assert.equal(await exits[1], 0, "listen --once exits 0 after the first event");
    await until(() => inbox[0].request_status === "sent");
    assert.equal(upgrades, 1, "one device socket, not one per review");
    // The listener for this conversation exited with --once. A decision must NOT be reported
    // `failed`: with nothing attached it stays `waiting` until a listener comes back.
    decided = true;
    inbox[0].session_updated_at = "t2";
    deliveries.length = 0;
    for (const socket of sockets) socket.write(frame({ type: "changed" }));
    await delay(250);
    assert.deepEqual(deliveries, [], "no claim, no failed, while unattached");
    assert.equal(delivery.status, "waiting");
    // Three distinct listener refusals, each printed by `listen` before exiting 1.
    const unknown = await run(
      runtime,
      ["listen", "--conversation", randomUUID()],
      env,
      dir,
    );
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /not_registered/);
    const busy = await run(
      runtime,
      ["listen", "--conversation", regs[0].conversation_id],
      env,
      dir,
    );
    assert.equal(busy.code, 1);
    assert.match(busy.err, /already_listening/);
    const adapterFile = path.join(dir, "adapter.json");
    await fs.writeFile(
      adapterFile,
      JSON.stringify({
        thread: "thread-http",
        url: base + "/hook/{{thread}}",
        body: { message: "{{message}}" },
      }),
    );
    const httpReg = JSON.parse(
      (
        await run(
          runtime,
          [
            "register",
            "--adapter",
            "http",
            "--brand",
            "claude-code",
            "--thread",
            "thread-http",
            "--adapter-file",
            adapterFile,
          ],
          env,
          dir,
        )
      ).out,
    );
    const wrong = await run(
      runtime,
      ["listen", "--conversation", httpReg.conversation_id],
      env,
      dir,
    );
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /wrong_adapter/);
    // Re-attaching delivers the decision that was kept waiting.
    const reattached = spawn(
      process.execPath,
      [runtime, "listen", "--conversation", reg.conversation_id],
      { env: { ...process.env, ...env }, cwd: dir },
    );
    listeners.push(reattached);
    const seen = [];
    let pending = "";
    reattached.stdout.on("data", (b) => {
      pending += b;
      for (let i; (i = pending.indexOf("\n")) >= 0; ) {
        seen.push(JSON.parse(pending.slice(0, i)));
        pending = pending.slice(i + 1);
      }
    });
    await until(() => seen.some((x) => x.decision_id === decision.id));
    await until(() => deliveries.some((d) => d.action === "sent"));
    assert.deepEqual(
      deliveries.filter((d) => d.action !== "bind").map((d) => d.action),
      ["claim", "sending", "sent"],
    );
    assert.equal(
      deliveries.some((d) => d.action === "failed"),
      false,
    );
    const detail = JSON.parse(
      (await run(runtime, ["status"], env, dir)).out,
    );
    const mine = detail.conversations.find(
      (x) => x.conversation_id === reg.conversation_id,
    );
    assert.equal(mine.adapter, "host-task");
    assert.equal(mine.listener, true);
    assert.equal(mine.state, "sent");
    assert.equal(mine.generation, reg.generation);
    assert.equal(mine.lastError, null);
    assert.equal(detail.auth_required, false);
    assert.equal(detail.conversation_count, 3);
    assert.equal(
      detail.conversations.find(
        (x) => x.conversation_id === httpReg.conversation_id,
      ).listener,
      null,
    );
    reattached.kill();
    inbox = [];
    decided = false;
    for (const socket of sockets) socket.write(frame({ type: "changed" }));
    await delay(150);
    const status = await run(runtime, ["status"], env, dir);
    assert.equal(JSON.parse(status.out).connected, true);
    const rc = JSON.parse(await fs.readFile(path.join(dir, ".relaynoterc")));
    assert.equal(rc.server, base);
    assert.equal(rc.conversation_id, undefined);
    assert(!JSON.stringify(rc).includes("unit-runtime-key"));
  } finally {
    for (const p of listeners) p.kill();
    if (runtime) await run(runtime, ["stop"], env, dir);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("updates require the exact expected version and reject downgrades or live runtimes", async () => {
  const dir = await fs.mkdtemp("/tmp/rn-install-"),
    env = { RELAYNOTE_RUNTIME_HOME: dir };
  try {
    const setup = await run(source, ["setup", "--accept-install"], env, dir);
    assert.equal(setup.code, 0, setup.err);
    const manifest = path.join(dir, "runtime", "runtime.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({ version: "3.4.1", protocol: 1 }),
    );
    assert.equal(
      (await run(source, ["setup", "--accept-install"], env, dir)).code,
      1,
    );
    assert.equal(
      (
        await run(
          source,
          ["setup", "--accept-update", "--from-version", "3.4.0"],
          env,
          dir,
        )
      ).code,
      1,
    );
    const account = path.join(dir, "accounts", "test");
    await fs.mkdir(account, { recursive: true });
    await fs.writeFile(path.join(account, "daemon.lock"), String(process.pid));
    const live = await run(
      source,
      ["setup", "--accept-update", "--from-version", "3.4.1"],
      env,
      dir,
    );
    assert.equal(live.code, 1);
    assert.match(live.err, /Stop affected/);
    await fs.unlink(path.join(account, "daemon.lock"));
    const updated = await run(
      source,
      ["setup", "--accept-update", "--from-version", "3.4.1"],
      env,
      dir,
    );
    assert.equal(updated.code, 0, updated.err);
    assert.equal(JSON.parse(await fs.readFile(manifest)).version, "4.2.1");
    await fs.writeFile(
      manifest,
      JSON.stringify({ version: "9.0.0", protocol: 1 }),
    );
    assert.equal(
      (
        await run(
          source,
          ["setup", "--accept-update", "--from-version", "9.0.0"],
          env,
          dir,
        )
      ).code,
      1,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("separate CLI processes serialize refresh and reuse the rotated credentials", async () => {
  const dir = await fs.mkdtemp("/tmp/rn-refresh-");
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    calls++;
    assert.equal(new URLSearchParams(raw).get("refresh_token"), "old-refresh");
    await delay(50);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fs.writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        base,
        clientId: "test",
        expiresAt: 0,
        refreshToken: "old-refresh",
        tokenEndpoint: base + "/token",
      }),
    );
    const script = path.join(dir, "refresh.mjs"),
      module = new URL(
        "../skills/relaynote/scripts/lib/auth.mjs",
        import.meta.url,
      ).href;
    await fs.writeFile(
      script,
      `import {accessToken} from ${JSON.stringify(module)}; await accessToken();`,
    );
    const results = await Promise.all(
      [1, 2, 3].map(() => run(script, [], { RELAYNOTE_HOME: dir }, dir)),
    );
    assert(
      results.every((r) => r.code === 0),
      JSON.stringify(results),
    );
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dir, "auth.json"))).refreshToken,
      "rotated-refresh",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reports the AI's own liveness as transitions between delivery and response", async () => {
  const dir = await fs.mkdtemp("/tmp/rn-activity-runtime-"),
    auth = path.join(dir, "auth"),
    home = path.join(dir, "home");
  await fs.mkdir(auth);
  const workspace = await fs.realpath(dir),
    slug = workspace.replace(/[^A-Za-z0-9-]/g, "-"),
    projects = path.join(home, ".claude/projects", slug);
  await fs.mkdir(projects, { recursive: true });
  const transcript = (thread) => path.join(projects, thread + ".jsonl");
  const append = (thread, entry) =>
    fs.appendFile(transcript(thread), JSON.stringify(entry) + "\n");
  const working = {
    type: "assistant",
    message: { role: "assistant", stop_reason: "tool_use", content: [] },
  };
  const done = {
    type: "assistant",
    message: { role: "assistant", stop_reason: "end_turn", content: [] },
  };
  let runtime,
    capability = false;
  const sockets = new Set(),
    conversations = new Map(),
    listeners = [],
    sessions = new Map(),
    posted = [];
  const device = randomUUID();
  let inbox = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/agents/identity")
      return res.end(JSON.stringify({ owner_id: "owner" }));
    if (req.url === "/api/agents/register") {
      const value = {
        conversation_id:
          conversations.get(body.origin_id)?.conversation_id ?? randomUUID(),
        device_id: device,
        generation: body.generation,
      };
      conversations.set(body.origin_id, value);
      return res.end(JSON.stringify(value));
    }
    if (req.url.endsWith("/ticket")) return res.end('{"ticket":"test"}');
    if (req.url.endsWith("/inbox")) return res.end(JSON.stringify({ items: inbox }));
    if (req.url.endsWith("/guard")) return res.end('{"valid":true}');
    if (req.url.endsWith("/state")) {
      posted.push(structuredClone(body));
      return res.end('{"ok":true}');
    }
    if (req.url.endsWith("/snapshot")) {
      const value = sessions.get(req.url.split("/")[3]);
      return res.end(
        JSON.stringify({
          session_id: value.id,
          current_round: 1,
          review_status: "changes_requested",
          delivery_protocol: 4,
          ...(capability ? { agent_activity: 1 } : {}),
          updated_at: value.decided ? "t2" : "t1",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          latest_review: value.decided
            ? {
                id: value.decision,
                round: 1,
                decision: "changes_requested",
                delivery: value.delivery,
              }
            : null,
          open_comments: [],
        }),
      );
    }
    if (req.url.endsWith("/delivery")) {
      const value = sessions.get(req.url.split("/")[3]);
      if (body.action === "claim") return res.end(JSON.stringify(value.delivery));
      if (["sending", "sent", "failed"].includes(body.action))
        value.delivery = { ...value.delivery, status: body.action };
      return res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (b) => {
      if ((b[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`,
    );
    socket.write(frame({ type: "ready" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(
    path.join(auth, "auth.json"),
    JSON.stringify({ base, apiKey: "unit-runtime-key" }),
  );
  const env = {
    RELAYNOTE_RUNTIME_HOME: path.join(dir, "shared"),
    RELAYNOTE_HOME: auth,
    RELAYNOTE_ACTIVITY_HOME: home,
    RELAYNOTE_ACTIVITY_QUIET_MS: "500",
    RELAYNOTE_ACTIVITY_SETTLE_MS: "30",
  };
  // Every activity state this conversation reported, in order, without repeats.
  const timeline = (id) =>
    posted
      .map((body) => body[id]?.activity?.state)
      .filter((state, index, all) => state && state !== all[index - 1]);
  const of = (id) => posted.findLast((body) => body[id]?.activity)?.[id].activity;
  const deliver = async (reg, thread) => {
    const session = randomUUID();
    sessions.set(session, {
      id: session,
      decision: randomUUID(),
      delivery: { delivery_id: session, status: "waiting" },
      decided: true,
    });
    inbox = [
      ...inbox,
      {
        ...reg,
        session_id: session,
        binding_id: thread.padEnd(32, "x").slice(0, 32),
        current_round: 1,
        session_updated_at: "t1",
        request_status: "none",
      },
    ];
    for (const socket of sockets) socket.write(frame({ type: "changed" }));
    await until(() => sessions.get(session).delivery.status === "sent");
    return session;
  };
  try {
    const setup = await run(source, ["setup", "--accept-install"], env, dir);
    runtime = JSON.parse(setup.out).runtime;
    const regs = new Map();
    for (const thread of ["thread-off", "thread-turn", "thread-quiet"]) {
      // The transcript already ends with the PREVIOUS turn's completion when the decision is
      // delivered, which is what production always looks like.
      await fs.writeFile(
        transcript(thread),
        [working, done].map((e) => JSON.stringify(e) + "\n").join(""),
      );
      const result = await run(
        runtime,
        ["register", "--adapter", "host-task", "--brand", "claude-code", "--thread", thread],
        env,
        dir,
      );
      assert.equal(result.code, 0, result.err);
      const reg = JSON.parse(result.out);
      regs.set(thread, reg);
      const child = spawn(
        process.execPath,
        [runtime, "listen", "--conversation", reg.conversation_id],
        { env: { ...process.env, ...env }, cwd: dir },
      );
      listeners.push(child);
      await new Promise((resolve) => child.stdout.once("data", resolve));
    }
    // An older server never receives `activity`, however live the transcript is.
    const off = regs.get("thread-off");
    await deliver(off, "thread-off");
    await append("thread-off", done);
    await delay(300);
    assert.deepEqual(timeline(off.conversation_id), []);
    assert.equal(
      posted.some((body) => JSON.stringify(body).includes("activity")),
      false,
      "no activity without the capability flag",
    );
    capability = true;
    // Delivery opens the window and takes a baseline. The tail at that moment is the previous
    // turn's `end_turn`, and it must produce no transcript activity at all — the server already
    // shows `working` from the MCP ack.
    const turn = regs.get("thread-turn");
    await deliver(turn, "thread-turn");
    await delay(300);
    assert.deepEqual(timeline(turn.conversation_id), [], "no state from the pre-baseline tail");
    assert.equal(of(turn.conversation_id), undefined);
    // The first write after the delivery is this turn, so: working, then its own completion.
    await append("thread-turn", working);
    await until(() => timeline(turn.conversation_id).length === 1);
    assert.deepEqual(timeline(turn.conversation_id), ["working"]);
    await append("thread-turn", done);
    await until(() => timeline(turn.conversation_id).length === 2);
    assert.deepEqual(timeline(turn.conversation_id), ["working", "responded"]);
    const responded = of(turn.conversation_id);
    assert.equal(responded.source, "transcript");
    assert.equal(responded.marker, "end_turn");
    assert.match(responded.at, /^\d{4}-\d\d-\d\dT/);
    assert.match(responded.last_write_at, /^\d{4}-\d\d-\d\dT/);
    assert.match(responded.baseline_at, /^\d{4}-\d\d-\d\dT/);
    // `responded` does not close the window: the same round can carry a second reply, and the
    // watcher is still attached to report it.
    await append("thread-turn", working);
    await until(() => timeline(turn.conversation_id).length === 3);
    await append("thread-turn", done);
    await until(() => timeline(turn.conversation_id).length === 4);
    assert.deepEqual(timeline(turn.conversation_id), [
      "working",
      "responded",
      "working",
      "responded",
    ]);
    // A delivery for a newer decision replaces the baseline: the `end_turn` now at the tail is
    // pre-baseline again, and only the next write reports anything.
    await deliver(turn, "thread-turn-2");
    await delay(300);
    assert.equal(timeline(turn.conversation_id).length, 4);
    await append("thread-turn", working);
    await until(() => timeline(turn.conversation_id).length === 5);
    assert.deepEqual(timeline(turn.conversation_id).at(-1), "working");
    // The window outlives `responded`, so the local inactivity timer still governs it.
    await until(() => timeline(turn.conversation_id).at(-1) === "quiet");
    // A silent transcript yields exactly one `quiet` after the local inactivity timer, with no
    // transcript-derived state before it.
    const quiet = regs.get("thread-quiet");
    await deliver(quiet, "thread-quiet");
    await until(() => timeline(quiet.conversation_id).length === 1);
    assert.deepEqual(timeline(quiet.conversation_id), ["quiet"]);
    // The next write reports `working`.
    await append("thread-quiet", working);
    await until(() => timeline(quiet.conversation_id).length === 2);
    assert.deepEqual(timeline(quiet.conversation_id), ["quiet", "working"]);
    const detail = JSON.parse((await run(runtime, ["status"], env, dir)).out);
    const row = detail.conversations.find(
      (x) => x.conversation_id === turn.conversation_id,
    );
    assert.equal(row.activity.state, "quiet");
    assert.equal(row.activity.transcript, transcript("thread-turn"));
    assert.match(row.activity.baseline_at, /^\d{4}-\d\d-\d\dT/);
    assert.match(row.activity.last_write_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(
      detail.conversations.find((x) => x.conversation_id === off.conversation_id)
        .activity,
      null,
    );
  } finally {
    for (const p of listeners) p.kill();
    if (runtime) await run(runtime, ["stop"], env, dir);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
