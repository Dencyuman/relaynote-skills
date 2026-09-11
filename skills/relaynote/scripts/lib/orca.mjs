import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
// The original failure is kept as `cause` and summarised in the message; without it every Orca
// problem (missing CLI, timeout, non-JSON output) looked identical in the watcher log.
const detail=e=>[e?.message,String(e?.stderr??'').trim()].filter(Boolean).join(' | ').replace(/\s+/g,' ').slice(0,300);
/** Every refusal carries a machine-readable category so the server sees why a delivery failed. */
export function refuse(reason,message,cause){const e=new Error(message,cause?{cause}:undefined);e.reason=reason;return e}
// A terminal that stays busy is not a reason to drop a reviewer's decision, but it cannot block the
// conversation's other sessions forever either: `enqueue` serialises per conversation. Ten minutes is
// longer than any single Codex turn observed in practice and short enough that the server's re-send
// alarm (1/2/5/15/60 min) still has attempts left after the first `failed`.
export const BUSY_DEADLINE_MS=10*60*1000;
// Applied only to an explicit zero-byte refusal (for example a mobile input lock); the `terminal wait`
// call already blocks for 5 s on its own, so the idle path needs no extra sleep.
const REFUSAL_BACKOFF=[1000,2000,5000,10000];
const run=async(command,args,timeout=10000)=>{try{return JSON.parse((await exec(command,args,{timeout,maxBuffer:2*1024*1024})).stdout)}catch(e){if(e.stdout){try{return JSON.parse(e.stdout)}catch{}}throw refuse('transport_unknown',`Orca command failed; delivery was not retried: ${command} ${args[0]??''} ${args[1]??''}: ${detail(e)}`,e)}};
async function processIdentity(pid){
  const {stdout}=await exec('ps',['-p',String(pid),'-o','pid=,ppid=,lstart=,comm=']);
  const match=stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/);
  if(!match)throw refuse('identity','Originating agent is no longer running');
  return {pid:Number(match[1]),parent:Number(match[2]),started:match[3],command:match[4]};
}
const isCodex=p=>/(^|\/)codex$/.test(p?.command??'');
/** Every live process, used only to re-find Codex after a restart. */
async function processList(){
  const {stdout}=await exec('ps',['-axo','pid=,ppid=,lstart=,comm='],{maxBuffer:8*1024*1024});
  return stdout.split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/)).filter(Boolean)
    .map(m=>({pid:Number(m[1]),parent:Number(m[2]),started:m[3],command:m[4]}));
}
async function processCwd(pid){
  try{const {stdout}=await exec('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{timeout:5000});
    const line=stdout.split('\n').find(l=>l.startsWith('n'));return line?line.slice(1):null}catch{return null}
}
/** The stable half of an Orca origin: the conversation, not the processes that happen to serve it. */
export const orcaIdentity=origin=>({incarnationId:origin?.incarnationId,tabId:origin?.tabId,worktreeId:origin?.worktreeId});
export function validateTerminal(origin,response){
  const terminal=response.result?.terminal;
  if(!response.ok||!terminal||!terminal.connected||!terminal.writable||terminal.orphaned||
    ['handle','incarnationId','worktreeId','tabId'].some(k=>terminal[k]!==origin[k])||response._meta?.runtimeId!==origin.runtimeId)
    throw refuse('identity','Originating Orca terminal changed or closed; no replacement was selected');
  return terminal;
}
export async function captureOrca(){
  const handle=process.env.ORCA_TERMINAL_HANDLE;
  if(!/^term_[a-f0-9-]+$/i.test(handle||''))throw new Error('Run inside the originating Orca terminal');
  const command=process.env.ORCA_CLI_COMMAND||(process.env.ORCA_DEV_REPO_ROOT?'orca-dev':process.platform==='linux'?'orca-ide':'orca');
  const response=await run(command,['terminal','show','--terminal',handle,'--json']);
  const t=response.result?.terminal;
  const origin={command,handle,incarnationId:t?.incarnationId,worktreeId:process.env.ORCA_WORKTREE_ID||process.env.ORCA_WORKSPACE_ID,tabId:process.env.ORCA_TAB_ID,runtimeId:response._meta?.runtimeId,thread:process.env.CODEX_THREAD_ID};
  if(!origin.incarnationId||!origin.worktreeId||!origin.tabId||!origin.runtimeId||!origin.thread)throw new Error('Originating Orca Codex identity is incomplete');
  validateTerminal(origin,response);
  let p=await processIdentity(process.ppid);
  for(let n=0;n<12&&!isCodex(p)&&p.parent>1;n++)p=await processIdentity(p.parent);
  if(!isCodex(p))throw new Error('Originating Codex process not found');
  // `worktreePath` is a hint for re-finding Codex later; identity is incarnationId + tabId + worktreeId.
  return {...origin,worktreePath:t?.worktreePath,agent:p};
}
/**
 * Resolve the terminal that still serves this conversation.
 * Identity is (incarnationId, tabId, worktreeId) plus the registration's thread, never the handle:
 * Orca re-issues `term_…` handles when it reconnects while the same conversation stays open.
 */
export async function resolveOrcaTerminal(origin,command){
  let terminals=null;
  try{
    const listed=await command(origin.command,['terminal','list','--json']);
    if(listed?.ok&&Array.isArray(listed.result?.terminals))terminals=listed.result.terminals;
  }catch(e){if(e?.reason!=='transport_unknown')throw e}
  let terminal;
  if(terminals){
    const matches=terminals.filter(t=>t.incarnationId===origin.incarnationId&&t.tabId===origin.tabId);
    if(!matches.length)throw refuse('identity','Originating Orca conversation (incarnation/tab) is no longer open; nothing was sent');
    terminal=matches.find(t=>t.handle===origin.handle)??matches[0];
  }else{
    // `terminal list` is unavailable on this Orca build: fall back to the stored handle.
    const shown=await command(origin.command,['terminal','show','--terminal',origin.handle,'--json']);
    terminal=shown?.ok?shown.result?.terminal:null;
    if(!terminal)throw refuse('identity','Originating Orca terminal could not be resolved; nothing was sent');
  }
  if(terminal.incarnationId!==origin.incarnationId||terminal.tabId!==origin.tabId||(origin.worktreeId&&terminal.worktreeId&&terminal.worktreeId!==origin.worktreeId))
    throw refuse('identity','Originating Orca conversation changed (incarnation, tab or worktree); nothing was sent');
  if(!terminal.connected||!terminal.writable||terminal.orphaned)
    throw refuse('identity','Originating Orca terminal is disconnected, read-only or orphaned; nothing was sent');
  return terminal;
}
/**
 * Find the Codex serving that terminal.
 * `orca terminal show/list --json` exposes no pid (verified: handle, ptyId, incarnationId, worktreeId,
 * worktreePath, branch, tabId, leafId, title, connected, writable, lastOutputAt, preview and nothing
 * else), so the pinned pid is only a hint. When it is gone we accept any live `codex` whose cwd is the
 * terminal's worktreePath; the terminal handle, not the pid, is what the notification is sent to.
 */
export async function resolveCodex(origin,worktreePath,{identity=processIdentity,processes=processList,cwd=processCwd}={}){
  const stored=origin.agent;
  if(stored?.pid){
    const current=await identity(stored.pid).catch(()=>null);
    if(current&&isCodex(current)&&current.started===stored.started)return current;
  }
  if(!worktreePath)throw refuse('identity','Originating Codex process is gone and its worktree is unknown; nothing was sent');
  for(const p of (await processes()).filter(isCodex))
    if(await cwd(p.pid)===worktreePath)return p;
  throw refuse('identity','No Codex process is running in the originating Orca worktree; nothing was sent');
}
export async function sendOrca(origin,event,{command=run,identity=processIdentity,processes=processList,cwd=processCwd,signal,beforeSend=async()=>true,onBusy=async()=>{},onOrigin=async()=>{},busyMs=BUSY_DEADLINE_MS,pause=ms=>delay(ms,undefined,{signal})}={}){
  const verify=async()=>{
    const terminal=await resolveOrcaTerminal(origin,command);
    let moved=false;
    if(terminal.handle!==origin.handle){origin.handle=terminal.handle;moved=true}
    if(terminal.worktreePath&&terminal.worktreePath!==origin.worktreePath){origin.worktreePath=terminal.worktreePath;moved=true}
    const agent=await resolveCodex(origin,origin.worktreePath,{identity,processes,cwd});
    if(agent.pid!==origin.agent?.pid||agent.started!==origin.agent?.started){origin.agent=agent;moved=true}
    // The conversation is unchanged, only the processes serving it: persist the new hints.
    if(moved)await onOrigin(origin);
  };
  const deadline=Date.now()+busyMs;
  let refusals=0,committed=false;
  while(!signal?.aborted){
    if(Date.now()>=deadline)throw refuse('busy',`Originating Orca terminal stayed busy for ${Math.round(busyMs/60000)} minutes; nothing was sent`);
    await verify();
    const idle=await command(origin.command,['terminal','wait','--terminal',origin.handle,'--for','tui-idle','--timeout-ms','5000','--json'],10000);
    if(!idle.ok){if(idle.error?.code==='timeout'){await onBusy();continue;}throw refuse('identity','Cannot wait for the originating Orca terminal')}
    const wait=idle.result?.wait;
    if(wait?.handle!==origin.handle||wait.condition!=='tui-idle'||wait.satisfied!==true)
      throw refuse('identity','Originating Orca terminal is blocked or its idle result is invalid; no input was sent');
    await verify();
    await command(origin.command,['terminal','read','--terminal',origin.handle,'--limit','1','--json']);
    if(signal?.aborted)return false;
    if(!await beforeSend())return false;
    committed=true;
    const message=`[Relaynote CLI automatic notification] Event ${event.event_id}; server ${event.server_url}; session ${event.session_id}; round ${event.round}; originating thread ${origin.thread}; ${event.event_kind==='discussion'?'discussion_id':'decision_id'} ${event.decision_id}; delivery_id ${event.delivery_id}. ${event.instruction}`;
    const result=await command(origin.command,['terminal','send','--terminal',origin.handle,'--text',message,'--enter','--json'],30000);
    if(!result.ok)throw refuse('transport_unknown','Orca delivery outcome unknown; inspect the original conversation before retrying');
    const sent=result.result?.send;
    if(sent?.handle===origin.handle&&sent.accepted===false&&sent.bytesWritten===0){
      // A successful RPC can explicitly refuse input (for example, a mobile input lock).
      // No bytes were written: retain this decision and revalidate before retrying.
      await pause(REFUSAL_BACKOFF[Math.min(refusals++,REFUSAL_BACKOFF.length-1)]);
      continue;
    }
    if(sent?.handle!==origin.handle||sent.accepted!==true||!Number.isSafeInteger(sent.bytesWritten)||sent.bytesWritten<Buffer.byteLength(message,'utf8'))
      throw refuse('transport_unknown','Orca delivery outcome unknown; inspect the original conversation before retrying');
    return true;
  }
  // Aborted mid-loop. Once `sending` was reported the delivery must never end silently: `failed`
  // with a reason is the only honest outcome, and the server re-mints it to `waiting`.
  if(committed)throw refuse('busy','Orca delivery was interrupted after the terminal refused input; nothing was sent');
  return false;
}
