import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
// The original failure is kept as `cause` and summarised in the message; without it every Orca
// problem (missing CLI, timeout, non-JSON output) looked identical in the watcher log.
const detail=e=>[e?.message,String(e?.stderr??'').trim()].filter(Boolean).join(' | ').replace(/\s+/g,' ').slice(0,300);
const run=async(command,args,timeout=10000)=>{try{return JSON.parse((await exec(command,args,{timeout,maxBuffer:2*1024*1024})).stdout)}catch(e){if(e.stdout){try{return JSON.parse(e.stdout)}catch{}}throw new Error(`Orca command failed; delivery was not retried: ${command} ${args[0]??''} ${args[1]??''}: ${detail(e)}`,{cause:e})}};
async function processIdentity(pid){
  const {stdout}=await exec('ps',['-p',String(pid),'-o','pid=,ppid=,lstart=,comm=']);
  const match=stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/);
  if(!match)throw new Error('Originating agent is no longer running');
  return {pid:Number(match[1]),parent:Number(match[2]),started:match[3],command:match[4]};
}
export function validateTerminal(origin,response){
  const terminal=response.result?.terminal;
  if(!response.ok||!terminal||!terminal.connected||!terminal.writable||terminal.orphaned||
    ['handle','incarnationId','worktreeId','tabId'].some(k=>terminal[k]!==origin[k])||response._meta?.runtimeId!==origin.runtimeId)
    throw new Error('Originating Orca terminal changed or closed; no replacement was selected');
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
  for(let n=0;n<12&&!/(^|\/)codex$/.test(p.command)&&p.parent>1;n++)p=await processIdentity(p.parent);
  if(!/(^|\/)codex$/.test(p.command))throw new Error('Originating Codex process not found');
  return {...origin,agent:p};
}
export async function sendOrca(origin,event,{command=run,identity=processIdentity,signal,beforeSend=async()=>true,pause=()=>delay(1000,undefined,{signal})}={}){
  const verify=async()=>{
    const p=await identity(origin.agent.pid);
    if(p.started!==origin.agent.started||p.command!==origin.agent.command)throw new Error('Originating Codex process changed');
    validateTerminal(origin,await command(origin.command,['terminal','show','--terminal',origin.handle,'--json']));
  };
  while(!signal?.aborted){
    await verify();
    const idle=await command(origin.command,['terminal','wait','--terminal',origin.handle,'--for','tui-idle','--timeout-ms','5000','--json'],10000);
    if(!idle.ok){if(idle.error?.code==='timeout')continue;throw new Error('Cannot wait for the originating Orca terminal')}
    const wait=idle.result?.wait;
    if(wait?.handle!==origin.handle||wait.condition!=='tui-idle'||wait.satisfied!==true)
      throw new Error('Originating Orca terminal is blocked or its idle result is invalid; no input was sent');
    await verify();
    await command(origin.command,['terminal','read','--terminal',origin.handle,'--limit','1','--json']);
    if(signal?.aborted)return;
    if(!await beforeSend())return false;
    const message=`[Relaynote CLI automatic notification] Event ${event.event_id}; server ${event.server_url}; session ${event.session_id}; round ${event.round}; originating thread ${origin.thread}; ${event.event_kind==='discussion'?'discussion_id':'decision_id'} ${event.decision_id}; delivery_id ${event.delivery_id}. ${event.instruction}`;
    const result=await command(origin.command,['terminal','send','--terminal',origin.handle,'--text',message,'--enter','--json'],30000);
    if(!result.ok)throw new Error('Orca delivery outcome unknown; inspect the original conversation before retrying');
    const sent=result.result?.send;
    if(sent?.handle===origin.handle&&sent.accepted===false&&sent.bytesWritten===0){
      // A successful RPC can explicitly refuse input (for example, a mobile input lock).
      // No bytes were written: retain this decision and revalidate before retrying.
      await pause();
      continue;
    }
    if(sent?.handle!==origin.handle||sent.accepted!==true||!Number.isSafeInteger(sent.bytesWritten)||sent.bytesWritten<Buffer.byteLength(message,'utf8'))
      throw new Error('Orca delivery outcome unknown; inspect the original conversation before retrying');
    return true;
  }
  return false;
}
