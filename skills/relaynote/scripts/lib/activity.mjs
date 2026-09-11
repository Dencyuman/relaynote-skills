// Liveness of the AI that owns a conversation, derived from the host's own transcript file.
// Every host-specific rule lives here; the daemon only opens a window and posts transitions.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {agents} from './adapters.mjs';
import {acceptsReason} from './delivery.mjs';

/** The only capability gate. Change this one function if the server names the flag differently. */
export const acceptsActivity = snapshot => snapshot?.agent_activity===1 && acceptsReason(snapshot);

/** Tests point the home at a temp dir; production always reads the real user home. */
const userHome = () => path.resolve(process.env.RELAYNOTE_ACTIVITY_HOME || os.homedir());
const codexHome = () => path.resolve(process.env.CODEX_HOME || path.join(userHome(),'.codex'));

/** The registered brand is the host id; `orca` is the adapter, not a brand. */
export const hostOf = reg => (reg?.adapter==='orca' ? 'orca' : reg?.brand ?? null);
export const descriptor = hostId => agents.find(a=>a.id===hostId)?.transcript ?? null;

/**
 * Claude Code names a project directory after the workspace with every character outside
 * [A-Za-z0-9-] replaced by `-`, the leading `/` included (verified against ~/.claude/projects:
 * `/Users/x/orca/workspaces/img-share-mcp/i18n対応言語を追加` →
 * `-Users-x-orca-workspaces-img-share-mcp-i18n-------`, one dash per non-ASCII character).
 * Cursor CLI uses the same rule without the leading dash.
 */
export const projectSlug = (workspace,{leading=true}={}) => {
  const slug = String(workspace ?? '').replace(/[^A-Za-z0-9-]/g,'-');
  return leading ? slug : slug.replace(/^-+/,'');
};

const escape = value => value.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');
/** Newest file matching a `*`-globbed absolute template, or null. Used for the Codex rollout name. */
async function newest(pattern) {
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of pattern.split('/')) {
    if (!segment) continue;
    const next = [];
    if (segment.includes('*')) {
      const match = new RegExp('^'+escape(segment)+'$');
      for (const dir of current)
        for (const name of await fs.readdir(dir).catch(()=>[]))
          if (match.test(name)) next.push(path.join(dir,name));
    } else for (const dir of current) next.push(path.join(dir,segment));
    if (!(current = next).length) return null;
  }
  let best = null;
  for (const candidate of current) {
    const stat = await fs.stat(candidate).catch(()=>null);
    if (stat?.isFile() && (!best || stat.mtimeMs>best.at)) best = {file:candidate, at:stat.mtimeMs};
  }
  return best?.file ?? null;
}

/** Absolute transcript path for this registration, or null when the host exposes no file. */
export async function resolveTranscript(hostId, reg) {
  const value = descriptor(hostId);
  if (value?.kind!=='jsonl') return null;
  const thread = reg?.thread;
  // A thread is an opaque id from the host; never let one escape its own directory.
  if (typeof thread!=='string' || !thread || /[/\\\0]/.test(thread)) return null;
  if (value.path.includes('{slug}') && !reg?.workspace) return null;
  const expanded = value.path
    .replaceAll('{home}',userHome())
    .replaceAll('{codex_home}',codexHome())
    .replaceAll('{slug}',projectSlug(reg?.workspace,{leading:value.slug!=='relative'}))
    .replaceAll('{thread}',thread);
  return expanded.includes('*') ? newest(expanded) : expanded;
}

export const TAIL_BYTES = 65536;
/** Last `bytes` of the transcript as lines; a truncated first line is dropped by the parser. */
export async function readTail(file, bytes=TAIL_BYTES) {
  const handle = await fs.open(file,'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, bytes);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer,0,length,stat.size-length);
    return {lines: buffer.toString('utf8').split('\n'), lastWriteAt: stat.mtime.toISOString()};
  } finally { await handle.close(); }
}

const parse = lines => {
  const entries = [];
  for (const line of lines ?? []) {
    const text = String(line).trim();
    if (!text.startsWith('{')) continue;
    try { entries.push(JSON.parse(text)); } catch {}
  }
  return entries;
};
const label = value => String(value ?? '').slice(0,40) || undefined;

/** Claude Code: the newest `assistant`/`user` entry decides; bookkeeping types are ignored. */
function claudeCode(entries) {
  for (let i=entries.length-1;i>=0;i--) {
    const entry = entries[i];
    if (!['assistant','user'].includes(entry.type)) continue;
    if (entry.isApiErrorMessage) return {state:'detached',marker:'api_error'};
    if (entry.type==='user') {
      const content = entry.message?.content;
      const tool = Array.isArray(content) && content.some(part=>part?.type==='tool_result');
      return {state:'working',marker:tool?'tool_result':'user'};
    }
    const stop = entry.message?.stop_reason;
    if (['end_turn','stop_sequence'].includes(stop)) return {state:'responded',marker:stop};
    return {state:'working',marker:label(stop)??'assistant'};
  }
  return null;
}
/** Codex and Orca: the newest turn event after which nothing else happened. */
function codex(entries) {
  for (let i=entries.length-1;i>=0;i--) {
    const type = entries[i].type==='event_msg' ? entries[i].payload?.type : null;
    if (type==='task_complete') return {state:'responded',marker:'task_complete'};
    if (type==='turn_aborted') return {state:'detached',marker:'turn_aborted'};
    if (type==='error') return {state:'detached',marker:'error'};
    if (type==='task_started') return {state:'working',marker:'task_started'};
  }
  return null;
}
/** Cursor CLI: the turn ends with a `turn_ended` trailer line. */
function cursorCli(entries) {
  const entry = entries.at(-1);
  if (!entry) return null;
  if (entry.type==='turn_ended')
    return entry.status==='success'
      ? {state:'responded',marker:'turn_ended'}
      : {state:'detached',marker:label('turn_ended_'+(entry.status??'failed'))};
  return {state:'working',marker:label(entry.type ?? entry.role ?? 'message')};
}
const formats = {'claude-code':claudeCode, codex, orca:codex, 'cursor-cli':cursorCli};

/** Pure: last lines of a transcript → this conversation's AI state. */
export function classifyTail(hostId, tailLines) {
  if (descriptor(hostId)?.kind!=='jsonl' || !formats[hostId]) return {state:'untracked'};
  // A write with nothing conclusive in the tail still means the AI is running.
  return formats[hostId](parse(tailLines)) ?? {state:'working'};
}

/** The exact object the server accepts under `activity`. */
export const activityValue = ({state,source,marker,lastWriteAt,at}) => ({
  state, at: at ?? new Date().toISOString(), source,
  ...(marker?{marker:label(marker)}:{}), ...(lastWriteAt?{last_write_at:lastWriteAt}:{}),
});
