#!/usr/bin/env node
// Self-contained shared runtime. No agent process is ever created by this entrypoint.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { VERSION, read, write, home, init } from "./lib/state.mjs";
import { accessToken, credentials, AuthError } from "./lib/auth.mjs";
import { captureOrca, sendOrca, orcaIdentity } from "./lib/orca.mjs";
import {
  deliverHttp,
  renderAdapter,
  feedbackMessage,
} from "./lib/adapters.mjs";
import { deliverBridge } from "./lib/bridge.mjs";
import { queueEvent, verifyCodexQueue, observe } from "./lib/feedback.mjs";
import { locked } from "./lib/lock.mjs";
import { deliveryClient, deliverDecision, reasonText } from "./lib/delivery.mjs";
const entry = fileURLToPath(import.meta.url),
  root = path.resolve(
    process.env.RELAYNOTE_RUNTIME_HOME ||
      path.join(os.homedir(), ".local/share/relaynote"),
  );
const [cmd, ...args] = process.argv.slice(2),
  opt = (n) => {
    const i = args.indexOf("--" + n);
    return i < 0 ? undefined : args[i + 1];
  };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const digest = (v) => createHash("sha256").update(v).digest("hex");
const privateDir = async (p) => {
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
  await fs.chmod(p, 0o700);
};
async function install() {
  if (!args.includes("--accept-install") && !args.includes("--accept-update"))
    throw new Error(
      "Explain shared runtime installation and obtain consent, then use --accept-install",
    );
  await privateDir(root);
  return locked(path.join(root, "installation.lock"), async () => {
    const target = path.join(root, "runtime"),
      installed = await read(path.join(target, "runtime.json")).catch(
        () => null,
      );
    if (installed?.version === VERSION)
      return path.join(target, "relaynote-runtime.mjs");
    if (installed) {
      const parts = (v) =>
          /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null,
        from = parts(installed.version),
        to = parts(VERSION);
      const newer =
        from &&
        to &&
        to.some(
          (v, i) =>
            v > from[i] && to.slice(0, i).every((x, j) => x === from[j]),
        );
      if (
        !args.includes("--accept-update") ||
        opt("from-version") !== installed.version ||
        !newer
      )
        throw new Error(
          `Shared runtime ${installed.version} already installed. Explicit pinned update required; no overwrite/downgrade performed.`,
        );
      const accounts = await fs
        .readdir(path.join(root, "accounts"))
        .catch(() => []);
      for (const account of accounts) {
        const pid = Number(
          await fs
            .readFile(
              path.join(root, "accounts", account, "daemon.lock"),
              "utf8",
            )
            .catch(() => 0),
        );
        if (pid && alive(pid))
          throw new Error(
            "Stop affected shared runtimes before updating; active conversations have not been interrupted",
          );
      }
    }
    const stage = path.join(root, "runtime-" + randomUUID());
    await privateDir(stage);
    let backup;
    try {
      await fs.cp(path.dirname(entry), stage, {
        recursive: true,
        filter: (s) => !s.endsWith(".DS_Store"),
      });
      await write(path.join(stage, "runtime.json"), {
        version: VERSION,
        protocol: 1,
      });
      if (installed) {
        backup = path.join(
          root,
          "previous-" + installed.version + "-" + randomUUID(),
        );
        await fs.rename(target, backup);
      }
      await fs.rename(stage, target);
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      if (backup) await fs.rename(backup, target);
      throw error;
    }
    return path.join(target, "relaynote-runtime.mjs");
  });
}
async function api(base, p, body) {
  const auth = await accessToken();
  if (auth.base !== base)
    throw new Error("Authentication server changed; stopped");
  const response = await fetch(base + p, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = new Error(
      `Relaynote ${response.status}: ${(await response.json().catch(() => ({}))).error ?? "request failed"}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function context() {
  await privateDir(root);
  await init();
  const auth = await credentials();
  await privateDir(path.join(root, "ipc"));
  const credentialId = digest(
    auth.base +
      "\0" +
      (auth.apiKey
        ? digest(auth.apiKey)
        : auth.clientId + "\0" + (auth.subject ?? "")),
  );
  const indexPath = path.join(root, "profile-" + credentialId + ".json");
  const stored = await read(path.join(home, "account.json")).catch(() =>
    read(indexPath).catch(() => null),
  );
  if (stored && stored.base === auth.base) return stored;
  const identity = await api(auth.base, "/api/agents/identity");
  const key = digest(auth.base + "\0" + identity.owner_id),
    dir = path.join(root, "accounts", key);
  await privateDir(dir);
  const authHome = path.join(dir, "auth");
  await privateDir(authHome);
  const value = {
    base: auth.base,
    owner: identity.owner_id,
    dir,
    authHome,
    socket: path.join(root, "ipc", key.slice(0, 24) + ".sock"),
  };
  await locked(path.join(dir, "profile.lock"), async () => {
    const exists = await read(path.join(authHome, "auth.json")).catch(
      () => null,
    );
    if (!exists) await write(path.join(authHome, "auth.json"), auth);
    await write(path.join(authHome, "account.json"), value);
    await write(indexPath, value);
  });
  return value;
}
async function rpc(c, route, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        socketPath: c.socket,
        path: route,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (s) => (data += s));
        res.on("end", () => {
          try {
            const v = JSON.parse(data);
            res.statusCode === 200 ? resolve(v) : reject(new Error(v.error));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.setTimeout(10000, () =>
      r.destroy(new Error("Shared runtime did not answer")),
    );
    r.on("error", reject);
    r.end(JSON.stringify(body ?? {}));
  });
}
async function start(c) {
  try {
    return await rpc(c, "/status");
  } catch {}
  const info = await read(path.join(path.dirname(entry), "runtime.json")).catch(
    () => null,
  );
  if (!info)
    throw new Error("Run setup, then use the printed shared runtime path");
  const log = await fs.open(path.join(c.dir, "runtime.log"), "a", 0o600);
  const child = spawn(process.execPath, [entry, "daemon"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, RELAYNOTE_HOME: c.authHome },
  });
  child.unref();
  await log.close();
  for (let n = 0; n < 50; n++) {
    try {
      return await rpc(c, "/status");
    } catch {
      await delay(100);
    }
  }
  throw new Error("Shared runtime did not start; inspect its runtime.log");
}
async function register(c) {
  let installation = await read(path.join(root, "installation.json")).catch(
    () => null,
  );
  if (!installation) {
    const handle = await fs
      .open(path.join(root, "installation.json"), "wx", 0o600)
      .catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    if (handle) {
      await handle.writeFile(JSON.stringify({ id: randomUUID() }));
      await handle.close();
    }
    installation = await read(path.join(root, "installation.json"));
  }
  const adapter = opt("adapter"),
    brand = opt("brand");
  if (
    !brand ||
    !["orca", "codex", "host-task", "http", "bridge"].includes(adapter)
  )
    throw new Error(
      "Use verified --brand and --adapter orca|codex|host-task|http|bridge. Other hosts use their documented foreground notification recipe, never pretend to support background injection.",
    );
  const origin = adapter === "orca" ? await captureOrca() : null,
    thread = origin?.thread ?? opt("thread") ?? process.env.CODEX_THREAD_ID;
  if (!thread || thread.length > 256 || /[\r\n\0]/.test(thread))
    throw new Error("Exact originating thread is required");
  if (adapter === "codex") {
    if (thread !== process.env.CODEX_THREAD_ID)
      throw new Error("Codex thread does not match this conversation");
    verifyCodexQueue();
  }
  let adapterConfig, socket;
  if (adapter === "http") {
    if (!opt("adapter-file")?.startsWith("/"))
      throw new Error("HTTP adapter needs its absolute data-only config path");
    adapterConfig = await read(opt("adapter-file"));
    renderAdapter(adapterConfig, thread, { instruction: "probe" });
  }
  if (adapter === "bridge") {
    socket = opt("socket");
    if (!socket?.startsWith("/") || !(await fs.stat(socket)).isSocket())
      throw new Error("An existing host-owned bridge socket is required");
  }
  // Identity is the conversation, never the processes serving it. For Orca that is the terminal's
  // (incarnation, tab, worktree) plus the thread; pid, handle and runtimeId are hints that change
  // whenever Codex restarts or Orca reconnects, and rotating the generation over them orphaned
  // already-attached sessions. Registrations written by 4.0.0 keep their generation: their stored
  // fingerprint is recomputed the old way from their own stored origin and accepted as a match.
  const identityOf = (o) =>
    adapter === "orca"
      ? { adapter, thread, identity: orcaIdentity(o) }
      : { adapter, thread, origin: o, adapterConfig, socket };
  const legacyOf = (o, config, sock) =>
    digest(
      JSON.stringify({
        adapter,
        thread,
        origin: o,
        adapterConfig: config,
        socket: sock,
      }),
    );
  const fingerprint = digest(JSON.stringify(identityOf(origin))),
    file = path.join(
      c.dir,
      "conversation-" + digest(adapter + "\0" + thread) + ".json",
    );
  const prior = await read(file).catch(() => null);
  const migrated =
    prior &&
    prior.fingerprint ===
      legacyOf(prior.origin, prior.adapterConfig, prior.socket) &&
    JSON.stringify(identityOf(prior.origin)) ===
      JSON.stringify(identityOf(origin));
  const generation =
      prior && (prior.fingerprint === fingerprint || migrated)
        ? prior.generation
        : randomUUID(),
    code = randomBytes(32).toString("hex");
  const localAuth = await credentials();
  const result = await api(c.base, "/api/agents/register", {
    ...(localAuth.flow ? { cli_auth_flow: localAuth.flow } : {}),
    installation_id: installation.id,
    device_name: os.hostname(),
    runtime_version: VERSION,
    origin_id: thread,
    generation,
    name: opt("name") || brand,
    brand,
    adapter,
    workspace: process.cwd(),
    skill_version: opt("skill-version") || VERSION,
    capabilities: {
      receive: adapter === "host-task" ? "host-task" : "push",
      // This runtime can receive submitted discussions; --no-discussions opts out.
      discussions: !args.includes("--no-discussions"),
    },
    pairing_code: code,
    ...(opt("setup-id") ? { setup_id: opt("setup-id") } : {}),
  });
  const value = {
    ...result,
    adapter,
    thread,
    origin,
    adapterConfig,
    socket,
    remote: opt("remote"),
    fingerprint,
    base: c.base,
    discussions: !args.includes("--no-discussions"),
  };
  await write(file, value);
  await rpc(c, "/register", value);
  const rcFile = path.join(process.cwd(), ".relaynoterc");
  const rc = await read(rcFile).catch((e) => {
    if (e.code === "ENOENT") return { project: path.basename(process.cwd()) };
    throw e;
  });
  await write(rcFile, { ...rc, server: c.base });
  console.log(
    JSON.stringify({
      ...result,
      pairing_code: code,
      auth_home: c.authHome,
      cli: path.join(path.dirname(entry), "relaynote-feedback.mjs"),
      next:
        "Call register_agent with conversation_id and pairing_code in THIS MCP conversation. Keep generation for create/attach and task receipts." +
        (adapter === "host-task"
          ? ` Then start this conversation's listener as the host's persistent background task and wait for its listening line before ending the turn: node ${entry} listen --conversation ${result.conversation_id}`
          : ""),
      // Verifiable after the listener is attached; not a substitute for the listen step.
      verify: `node ${entry} status`,
    }),
  );
}
async function daemon(c) {
  const lock = path.join(c.dir, "daemon.lock");
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await fs.readFile(lock, "utf8"));
    if (alive(pid)) return;
    await fs.unlink(lock);
    handle = await fs.open(lock, "wx", 0o600);
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  await fs.unlink(c.socket).catch(() => {});
  const registrations = new Map(),
    consumers = new Map(),
    listeners = new Map(),
    queues = new Map(),
    wakeups = new Map(),
    changes = new Set();
  let deviceId,
    ws,
    renew,
    beat,
    stopped = false,
    dirty = false,
    loading = false;
  let failures = 0;
  const daemonAbort = new AbortController();
  const status = {
    pid: process.pid,
    version: VERSION,
    connected: false,
    error: null,
    auth_required: false,
  };
  // Every failure gets one line on stderr, which `start` redirects into runtime.log. Before this the
  // daemon logged exactly one kind of error and everything else vanished into a shared status field.
  const short = (v) => (v ? String(v).slice(0, 8) : "-");
  const log = (fields) => {
    try {
      console.error(
        [
          new Date().toISOString(),
          `conversation=${short(fields.conversation)}`,
          `session=${short(fields.session)}`,
          `adapter=${fields.adapter ?? "-"}`,
          `stage=${fields.stage}`,
          `reason=${fields.reason ?? "-"}`,
          String(fields.message ?? "").replace(/\s+/g, " ").slice(0, 500),
        ].join(" "),
      );
    } catch {}
  };
  // Per-conversation health, so `status` can say which conversation is broken and why.
  const health = new Map();
  const record = (id) => {
    let value = health.get(id);
    if (!value) {
      value = {
        state: null,
        listener: false,
        lastError: null,
        lastErrorAt: null,
      };
      health.set(id, value);
    }
    return value;
  };
  const note = (reg, fields) => {
    const entry = record(reg.conversation_id);
    entry.lastError = `${fields.reason ?? "error"}: ${fields.message}`.slice(
      0,
      300,
    );
    entry.lastErrorAt = new Date().toISOString();
    log({ conversation: reg.conversation_id, adapter: reg.adapter, ...fields });
  };
  process.on("uncaughtException", (error) => {
    // One conversation's bad write must never take down every other conversation on this account.
    log({ stage: "daemon", reason: "uncaught", message: error?.stack ?? error });
    status.error = String(error?.message ?? error);
  });
  process.on("unhandledRejection", (error) => {
    log({ stage: "daemon", reason: "unhandled", message: error?.stack ?? error });
    status.error = String(error?.message ?? error);
  });
  const stop = () => {
    stopped = true;
    daemonAbort.abort();
    for (const output of listeners.values()) output.end();
    clearTimeout(stateTimer);
    clearInterval(renew);
    clearInterval(beat);
    ws?.close();
    for (const x of consumers.values()) x.abort.abort();
    server.close();
  };
  // A dead refresh token cannot be retried into working. Say so, tell every conversation, stop.
  const authStop = async (error) => {
    if (status.auth_required) return;
    status.auth_required = true;
    status.error = error?.message ?? "Authentication failed";
    log({
      stage: "auth",
      reason: "auth",
      message: `Relaynote authentication failed (${status.error}). Run \`node CLI login --server ORIGIN\` again, then register and pair this conversation.`,
    });
    for (const reg of registrations.values()) {
      record(reg.conversation_id).lastError = `auth: ${status.error}`;
      record(reg.conversation_id).lastErrorAt = new Date().toISOString();
      states[reg.conversation_id] = {
        generation: reg.generation,
        state: "auth_required",
        updatedAt: new Date().toISOString(),
      };
      record(reg.conversation_id).state = "auth_required";
    }
    if (deviceId)
      await api(c.base, `/api/agents/devices/${deviceId}/state`, states).catch(
        () => {},
      );
    stop();
  };
  const fatalAuth = (error) =>
    error instanceof AuthError ||
    (error?.reason === "auth" && [401, 403].includes(error?.status));
  const enqueue = (id, fn) => {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    next
      .finally(() => {
        if (queues.get(id) === next) queues.delete(id);
      })
      .catch(() => {});
    return next;
  };
  const states = {};
  let stateTimer;
  const mark = (reg, state) => {
    if (stopped) return;
    if (
      states[reg.conversation_id]?.state === state &&
      states[reg.conversation_id]?.generation === reg.generation
    )
      return;
    states[reg.conversation_id] = {
      generation: reg.generation,
      state,
      updatedAt: new Date().toISOString(),
    };
    record(reg.conversation_id).state = state;
    clearTimeout(stateTimer);
    stateTimer = setTimeout(
      () =>
        api(c.base, `/api/agents/devices/${deviceId}/state`, states).catch(
          () => {},
        ),
      50,
    );
  };
  const send = async (reg, event, beforeSend, signal) => {
    mark(reg, "queued");
    const original = beforeSend;
    beforeSend = async () => {
      if (registrations.get(reg.conversation_id)?.generation !== reg.generation)
        return false;
      const guard = await api(c.base, `/api/agents/devices/${deviceId}/guard`, {
        session_id: event.session_id,
        conversation_id: reg.conversation_id,
        generation: reg.generation,
        event_kind: event.event_kind ?? "decision",
      });
      return guard.valid ? original() : false;
    };
    if (reg.adapter === "orca")
      return sendOrca(reg.origin, event, {
        beforeSend,
        signal: signal
          ? AbortSignal.any([daemonAbort.signal, signal])
          : daemonAbort.signal,
        onBusy: async () => mark(reg, "busy"),
        // Orca re-issues the terminal handle and Codex restarts while the same conversation stays
        // open; persist the refreshed hints so the next delivery starts from them.
        onOrigin: async (origin) => {
          const updated = { ...registrations.get(reg.conversation_id), origin };
          registrations.set(reg.conversation_id, updated);
          reg.origin = origin;
          await write(
            path.join(
              c.dir,
              "conversation-" +
                digest(reg.adapter + "\0" + reg.thread) +
                ".json",
            ),
            updated,
          ).catch((error) =>
            note(reg, {
              session: event.session_id,
              stage: "origin",
              reason: "identity",
              message: error.message,
            }),
          );
        },
      });
    if (reg.adapter === "host-task") {
      const output = listeners.get(reg.conversation_id);
      if (!output) {
        // Nothing was claimed as `sending`, so the delivery stays `waiting` on the server and the
        // listener's own attach `refresh()` (or the server's re-send) delivers it later.
        if (record(reg.conversation_id).state !== "unavailable")
          note(reg, {
            session: event.session_id,
            stage: "delivery",
            reason: "listener_absent",
            message:
              "No listener attached for this conversation; the delivery stays waiting",
          });
        mark(reg, "unavailable");
        return false;
      }
      if (!(await beforeSend())) return false;
      output.write(JSON.stringify(event) + "\n");
      return true;
    }
    if (!(await beforeSend())) return false;
    if (reg.adapter === "http")
      await deliverHttp(reg.adapterConfig, reg.thread, event);
    else if (reg.adapter === "bridge")
      await deliverBridge(reg.socket, reg.thread, feedbackMessage(event));
    else await queueEvent(reg.thread, event, reg.remote);
    return true;
  };
  const registerLocal = async (value) => {
    if (value.base !== c.base) throw new Error("Server mismatch");
    if (deviceId && deviceId !== value.device_id)
      throw new Error(
        "Account/device changed. Stop this runtime and reconnect explicitly.",
      );
    deviceId = value.device_id;
    const old = registrations.get(value.conversation_id);
    if (old && old.generation !== value.generation)
      for (const consumer of consumers.values())
        if (consumer.conversationId === value.conversation_id)
          consumer.abort.abort();
    registrations.set(value.conversation_id, value);
    mark(value, "ready");
  };
  for (const name of await fs.readdir(c.dir))
    if (/^conversation-.*\.json$/.test(name))
      await registerLocal(await read(path.join(c.dir, name)));
  const reviewConsumer = async (item, reg) => {
    if (consumers.has(item.session_id)) return;
    const abort = new AbortController(),
      post = deliveryClient(item.session_id, item.binding_id, c.base),
      cursor = path.join(c.dir, "seen-" + item.binding_id + ".json");
    consumers.set(item.session_id, {
      abort,
      conversationId: reg.conversation_id,
      updated: item.session_updated_at,
    });
    const snapshot = () =>
      api(c.base, `/api/sessions/${item.session_id}/snapshot`);
    try {
      // An older server without discussion_protocol 1 still gets a final-decisions binding.
      const discussions =
        reg.discussions && (await snapshot()).discussion_protocol === 1;
      await post("bind", {
        adapter: reg.adapter,
        discussions,
      });
      await observe({
        sessionId: item.session_id,
        events: discussions ? "discussions" : "decisions",
        continuous: true,
        signal: abort.signal,
        getReview: snapshot,
        waitForChange: async (_id, since, seconds) => {
          if (changes.delete(item.session_id)) return snapshot();
          const changed = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              wakeups.delete(item.session_id);
              resolve(false);
            }, seconds * 1000);
            wakeups.set(item.session_id, () => {
              changes.delete(item.session_id);
              clearTimeout(timer);
              wakeups.delete(item.session_id);
              resolve(true);
            });
            abort.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve(false);
              },
              { once: true },
            );
          });
          return changed ? snapshot() : { pending: true, updated_at: since };
        },
        loadState: () => read(cursor).catch(() => null),
        saveState: (v) => write(cursor, v),
        wait: delay,
        deliver: (event) =>
          enqueue(reg.conversation_id, () => {
            event.server_url = c.base;
            return deliverDecision(event, {
              post,
              snapshot,
              send: (before) => send(reg, event, before, abort.signal),
              onFailure: (reason) =>
                note(reg, {
                  session: item.session_id,
                  stage: event.event_kind === "discussion"
                    ? "discussion"
                    : "review",
                  reason: reason.split(":")[0],
                  message: reason,
                }),
            })
              .then((sent) => {
                if (sent) mark(reg, "sent");
                return sent;
              })
              .catch((error) => {
                mark(reg, "unavailable");
                if (fatalAuth(error)) void authStop(error);
                throw error;
              });
          }),
      });
    } catch (error) {
      status.error = error.message;
      note(reg, {
        session: item.session_id,
        stage: "consumer",
        reason: error.reason ?? "error",
        message: error.message,
      });
      if (fatalAuth(error)) void authStop(error);
    } finally {
      consumers.delete(item.session_id);
      wakeups.delete(item.session_id);
    }
  };
  async function refresh() {
    dirty = true;
    if (loading) return;
    loading = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        if (!deviceId) break;
        const { items } = await api(
          c.base,
          `/api/agents/devices/${deviceId}/inbox`,
        );
        failures = 0;
        status.error = null;
        const active = new Set(items.map((i) => i.session_id));
        for (const [id, consumer] of consumers)
          if (!active.has(id.replace(/^task:/, ""))) consumer.abort.abort();
        for (const item of items) {
          const reg = registrations.get(item.conversation_id);
          if (!reg || reg.generation !== item.generation) continue;
          if (
            reg.adapter === "host-task" &&
            !listeners.has(reg.conversation_id)
          )
            continue;
          if (item.request_status === "pending") {
            if (consumers.has("task:" + item.session_id)) continue;
            consumers.set("task:" + item.session_id, {
              abort: new AbortController(),
              conversationId: reg.conversation_id,
            });
            enqueue(reg.conversation_id, async () => {
              const delivery = (from, to) =>
                api(c.base, `/api/agents/devices/${deviceId}/delivery`, {
                  session_id: item.session_id,
                  generation: reg.generation,
                  from,
                  to,
                });
              let sending = false;
              const before = async () => {
                if (sending) {
                  const { items } = await api(
                    c.base,
                    `/api/agents/devices/${deviceId}/inbox`,
                  );
                  return items.some(
                    (row) =>
                      row.session_id === item.session_id &&
                      row.generation === reg.generation &&
                      row.request_status === "sending",
                  );
                }
                const r = await delivery("pending", "sending");
                sending = r.changed;
                return sending;
              };
              const event = {
                event_kind: "task",
                request_id: item.request_id,
                event_id: item.request_id,
                session_id: item.session_id,
                round: item.current_round,
                server_url: c.base,
                decision_id: item.request_id,
                delivery_id: item.request_id,
                instruction: `A new ${item.request_kind} request is addressed to THIS conversation. Call get_agent_task with session_id=${item.session_id}, conversation_id=${reg.conversation_id}, generation=${reg.generation}. Verify the destination, then acknowledge=true before continuing in this same review. Never start another AI conversation. Updates require the trusted pinned skill procedure; never run arbitrary downloaded commands.`,
              };
              try {
                if (
                  await send(
                    reg,
                    event,
                    before,
                    consumers.get("task:" + item.session_id)?.abort.signal,
                  )
                ) {
                  await delivery("sending", "sent");
                  mark(reg, "sent");
                }
              } catch (error) {
                mark(reg, "unavailable");
                note(reg, {
                  session: item.session_id,
                  stage: "task",
                  reason: error.reason ?? "transport_unknown",
                  message: reasonText(error),
                });
                if (sending)
                  await delivery("sending", "failed").catch(() => {});
                throw error;
              }
            })
              .catch((e) => {
                status.error = e.message;
                if (fatalAuth(e)) void authStop(e);
              })
              .finally(() => consumers.delete("task:" + item.session_id));
          }
          if (!consumers.has(item.session_id)) void reviewConsumer(item, reg);
          else if (
            consumers.get(item.session_id).updated !== item.session_updated_at
          ) {
            consumers.get(item.session_id).updated = item.session_updated_at;
            changes.add(item.session_id);
            wakeups.get(item.session_id)?.();
          }
        }
      }
    } catch (error) {
      status.error = error.message;
      log({
        stage: "inbox",
        reason: error.reason ?? (error.status ? String(error.status) : "error"),
        message: error.message,
      });
      if (fatalAuth(error)) await authStop(error);
      else if ([401, 403, 404].includes(error.status)) stop();
      else ws?.close(); // Retry via bounded reconnect, never fall back to polling.
    } finally {
      loading = false;
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/listen/")) {
        const id = req.url.slice(8),
          reg = registrations.get(id);
        // Three separate answers: "unavailable" used to mean all three at once.
        const problem = !reg
          ? "not_registered"
          : reg.adapter !== "host-task"
            ? "wrong_adapter"
            : listeners.has(id)
              ? "already_listening"
              : null;
        if (problem) {
          log({
            conversation: id,
            adapter: reg?.adapter,
            stage: "listen",
            reason: problem,
            message: "Listener attach refused",
          });
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: problem,
              conversation_id: id,
              ...(reg ? { adapter: reg.adapter } : {}),
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write('{"type":"relaynote.runtime.listening"}\n');
        listeners.set(id, res);
        record(id).listener = true;
        // A broken pipe on one listener must not reach the daemon as an uncaught error event.
        res.on("error", (error) => {
          listeners.delete(id);
          record(id).listener = false;
          note(reg, {
            stage: "listen",
            reason: "listener_absent",
            message: error.message,
          });
          mark(reg, "unavailable");
        });
        mark(reg, "ready");
        req.on("close", () => {
          listeners.delete(id);
          record(id).listener = false;
          mark(reg, "unavailable");
        });
        void refresh();
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10000) throw new Error("Request too large");
      }
      if (req.url === "/register") {
        await registerLocal(JSON.parse(raw));
        void refresh();
      } else if (req.url === "/stop") stop();
      else if (req.url !== "/status") throw new Error("Unknown action");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...status,
          device_id: deviceId,
          conversation_count: registrations.size,
          conversations: [...registrations.values()].map((reg) => {
            const entry = record(reg.conversation_id);
            return {
              conversation_id: reg.conversation_id,
              adapter: reg.adapter,
              thread: reg.thread,
              generation: reg.generation,
              state: entry.state,
              listener:
                reg.adapter === "host-task"
                  ? listeners.has(reg.conversation_id)
                  : null,
              lastError: entry.lastError,
              lastErrorAt: entry.lastErrorAt,
            };
          }),
        }),
      );
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(c.socket, resolve);
  });
  await fs.chmod(c.socket, 0o600);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopped) {
      if (!deviceId) {
        await delay(250);
        continue;
      }
      try {
        const ticket = await api(
          c.base,
          `/api/agents/devices/${deviceId}/ticket`,
          {},
        );
        const url = new URL(`/api/agents/devices/${deviceId}/events`, c.base);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        await new Promise((resolve, reject) => {
          ws = new WebSocket(url, [
            "relaynote",
            "relaynote.ticket." + ticket.ticket,
          ]);
          let pong = Date.now();
          const deadline = setTimeout(() => {
            ws.close();
            reject(new Error("Hibernation connection timed out"));
          }, 20000);
          ws.onmessage = (message) => {
            if (message.data === "pong") {
              pong = Date.now();
              return;
            }
            let data;
            try {
              data = JSON.parse(message.data);
            } catch {
              ws.close(1008, "Invalid event");
              return;
            }
            if (data.type === "ready") {
              clearTimeout(deadline);
              status.connected = true;
              status.error = null;
              void api(
                c.base,
                `/api/agents/devices/${deviceId}/state`,
                states,
              ).catch(() => {});
              beat = setInterval(() => {
                if (Date.now() - pong > 75000) ws.close();
                else ws.send("ping");
              }, 30000);
              renew = setInterval(
                () =>
                  api(
                    c.base,
                    `/api/agents/devices/${deviceId}/renew`,
                    {},
                  ).catch((error) => {
                    log({
                      stage: "renew",
                      reason:
                        error.reason ??
                        (error.status ? String(error.status) : "error"),
                      message: error.message,
                    });
                    if (fatalAuth(error)) void authStop(error);
                    else ws.close();
                  }),
                240000,
              );
            }
            if (["ready", "changed"].includes(data.type)) void refresh();
          };
          ws.onerror = () => {
            clearTimeout(deadline);
            reject(new Error("Hibernation connection failed"));
          };
          ws.onclose = (event) => {
            clearTimeout(deadline);
            if (event.code === 4001) {
              const error = new Error("Device revoked; reconnect explicitly");
              error.status = 401;
              reject(error);
            } else resolve();
          };
        });
      } catch (error) {
        status.error = error.message;
        log({
          stage: "socket",
          reason: error.reason ?? (error.status ? String(error.status) : "error"),
          message: error.message,
        });
        if (fatalAuth(error)) await authStop(error);
        else if ([401, 403, 404].includes(error.status)) stop();
      } finally {
        status.connected = false;
        clearInterval(renew);
        clearInterval(beat);
        ws?.close();
      }
      if (!stopped)
        await delay(
          Math.min(60000, 1000 * 2 ** Math.min(++failures, 6)),
          undefined,
          { signal: daemonAbort.signal },
        ).catch(() => {});
    }
  } finally {
    stop();
    await fs.unlink(c.socket).catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}
try {
  if (cmd === "setup")
    console.log(JSON.stringify({ runtime: await install(), version: VERSION }));
  else if (cmd === "profiles") {
    const accounts = await fs
      .readdir(path.join(root, "accounts"))
      .catch(() => []);
    const profiles = [];
    for (const name of accounts) {
      const account = await read(
        path.join(root, "accounts", name, "auth", "account.json"),
      ).catch(() => null);
      if (account) {
        const auth = await read(path.join(account.authHome, "auth.json")).catch(
          () => null,
        );
        profiles.push({
          server: account.base,
          owner_id: account.owner,
          auth_home: account.authHome,
          auth_method: auth?.apiKey ? "api-key" : "oauth",
          auth_flow: auth?.flow ?? null,
        });
      }
    }
    console.log(JSON.stringify({ profiles }));
  } else if (cmd === "--help" || !cmd)
    console.log(
      "setup --accept-install [--accept-update --from-version VERSION] | start | register --adapter orca|codex|host-task --brand BRAND [--thread ID] [--setup-id ID] [--no-discussions] | profiles | current --adapter ADAPTER [--thread ID] | status | listen --conversation ID [--once] | stop",
    );
  else {
    const c = await context();
    if (path.resolve(home) !== c.authHome) {
      const result = spawn(process.execPath, [entry, cmd, ...args], {
        env: { ...process.env, RELAYNOTE_HOME: c.authHome },
        stdio: "inherit",
      });
      process.exitCode = await new Promise((resolve) =>
        result.once("exit", resolve),
      );
    } else if (cmd === "daemon") await daemon(c);
    else if (cmd === "start") console.log(JSON.stringify(await start(c)));
    else if (cmd === "register") {
      await start(c);
      await register(c);
    } else if (cmd === "current") {
      const adapter = opt("adapter");
      const origin = adapter === "orca" ? await captureOrca() : null;
      const thread =
        origin?.thread ?? opt("thread") ?? process.env.CODEX_THREAD_ID;
      if (!adapter || !thread)
        throw new Error("Exact adapter and originating thread required");
      const reg = await read(
        path.join(
          c.dir,
          "conversation-" + digest(adapter + "\0" + thread) + ".json",
        ),
      );
      if (
        origin &&
        JSON.stringify(orcaIdentity(origin)) !==
          JSON.stringify(orcaIdentity(reg.origin))
      )
        throw new Error(
          "Origin changed; register and pair this conversation again",
        );
      console.log(
        JSON.stringify({
          conversation_id: reg.conversation_id,
          generation: reg.generation,
          thread: reg.thread,
          adapter: reg.adapter,
          auth_home: c.authHome,
        }),
      );
    } else if (cmd === "status" || cmd === "stop")
      console.log(JSON.stringify(await rpc(c, "/" + cmd)));
    else if (cmd === "listen") {
      // --once: print the first delivered event and exit, for hosts whose
      // background task wakes the conversation on process completion (Cursor CLI).
      const once = args.includes("--once");
      let done = false;
      const req = http.get(
        { socketPath: c.socket, path: "/listen/" + opt("conversation") },
        (res) => {
          if (res.statusCode !== 200) {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => console.error(body.trim() || "Listener refused"));
            process.exitCode = 1;
            return;
          }
          if (!once) return void res.pipe(process.stdout);
          res.setEncoding("utf8");
          let buffer = "";
          res.on("data", (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index + 1);
              buffer = buffer.slice(index + 1);
              process.stdout.write(line);
              // Anything after the listening notice is a delivered event.
              if (!line.includes('"type":"relaynote.runtime.listening"')) {
                done = true;
                req.destroy();
                return;
              }
            }
          });
        },
      );
      req.on("error", (e) => {
        if (done) return;
        console.error(e.message);
        process.exitCode = 1;
      });
    } else throw new Error("Unknown runtime command");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
