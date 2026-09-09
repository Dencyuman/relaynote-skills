import {accessToken, AuthError} from './auth.mjs';

async function request(sessionId, path, method = 'GET', signal, bindingId) {
  const {base, token} = await accessToken();
  const response = await fetch(`${base}/api/sessions/${sessionId}/${path}`, {
    method, headers: {Authorization: `Bearer ${token}`, ...(bindingId ? {'X-Relaynote-Binding': bindingId} : {})}, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
  });
  if ([401,403].includes(response.status)) throw new AuthError('Access denied. Run login again.');
  if (response.status === 404) throw new AuthError('This server does not support WebSocket Hibernation. Upgrade the server.');
  if (response.status === 410) throw new AuthError('Session not found or expired.');
  if (!response.ok) throw new Error(`Events unavailable (${response.status})`);
  return {base, data: await response.json()};
}

/** A single connection, coalesced notifications, and D1 snapshots after each wake. */
export function eventSource(sessionId, {signal, bindingId, onMode = () => {}} = {}) {
  let socket, opening, timer, beat, wake, dirty = false, failures = 0, retryAt = 0, fatal;
  const snapshot = async () => {const data=(await request(sessionId, 'snapshot', 'GET', signal)).data;if(data.session_id!==sessionId)throw new AuthError('Session snapshot mismatch; delivery stopped');return data;};
  const notify = () => { dirty = true; wake?.(); };
  const close = () => { clearInterval(beat); clearTimeout(timer); if (socket) { socket.onclose = null; socket.close(); socket = undefined; } wake?.(); };
  const connect = async () => {
    const {base,data} = await request(sessionId, 'events-ticket', 'POST', signal, bindingId);
    if (signal?.aborted) return;
    await new Promise((resolve,reject) => {
      const url = new URL(`/api/sessions/${sessionId}/events`, base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = socket = new WebSocket(url, ['relaynote', `relaynote.ticket.${data.ticket}`]);
      let ready = false, pong = Date.now();
      const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket connection timeout')); }, 15000);
      ws.onmessage = event => {
        if (event.data === 'pong') { pong = Date.now(); return; }
        let data; try { data = JSON.parse(String(event.data)); } catch { ws.close(); return; }
        if (data.type === 'ready') {
          ready = true; failures = 0; clearTimeout(timeout); Promise.resolve(onMode('websocket')).then(resolve,reject);
          beat = setInterval(() => { if (Date.now() - pong > 75000) ws.close(); else if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 30000);
        }
        if (data.type === 'ready' || data.type === 'changed') notify();
      };
      ws.onclose = event => {
        clearTimeout(timeout); clearInterval(beat); if (socket === ws) socket = undefined;
        if (event.code === 4001) fatal = new AuthError('Session not found or expired.');
        if (!ready) reject(new Error('WebSocket connection failed')); else notify();
      };
      ws.onerror = () => { ws.close(); if (!ready) { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); } };
    });
  };
  signal?.addEventListener('abort', close, {once:true});
  return {
    snapshot,
    ready: async () => { opening ??= connect().finally(() => { opening = undefined; }); await opening; },
    async wait(_id, since, seconds = 300) {
      if (fatal) throw fatal;
      if (signal?.aborted) return {pending:true, updated_at:since};
      if (Date.now() < retryAt) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        timer = setTimeout(done, retryAt - Date.now()); signal?.addEventListener('abort', done, {once:true});
      });
      if (signal?.aborted) return {pending:true, updated_at:since};
      if (!socket) {
        try { opening ??= connect().finally(() => { opening = undefined; }); await opening; }
        catch (error) {
          if (error instanceof AuthError) throw error;
          close(); failures++;
          retryAt = Date.now() + (failures >= 5 ? 600000 : Math.min(60000,1000 * 2 ** failures));
          await onMode('reconnecting'); throw error;
        }
      }
      if (!dirty) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve,seconds*1000); });
      clearTimeout(timer); wake = undefined;
      const changed = dirty; dirty = false;
      if (fatal) throw fatal;
      if (signal?.aborted) return {pending:true, updated_at:since};
      return changed ? snapshot() : {pending:true, updated_at:since};
    },
    close() { signal?.removeEventListener('abort', close); close(); },
  };
}
