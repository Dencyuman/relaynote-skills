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
    upgrades = 0;
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
          review_status: "preparing",
          delivery_protocol: 3,
          updated_at: "t1",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          latest_review: null,
          open_comments: [],
        }),
      );
    }
    if (req.url.endsWith("/delivery")) return res.end('{"ok":true}');
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
    const counts = [snapshots, inboxReads];
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
    inbox = [];
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
    assert.equal(JSON.parse(await fs.readFile(manifest)).version, "4.0.0");
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
