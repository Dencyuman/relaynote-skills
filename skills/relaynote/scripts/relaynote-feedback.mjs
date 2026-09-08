#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {home,init,read,write,endpoint,VERSION} from './lib/state.mjs';
import {login,apiKeyLogin,credentials} from './lib/auth.mjs';
import {getReview} from './lib/mcp.mjs';
import {observe,queueEvent,fingerprint,codexArgs,verifyCodexQueue} from './lib/feedback.mjs';
import {captureOrca,sendOrca} from './lib/orca.mjs';
const entry=fileURLToPath(import.meta.url),[command,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]};
const flag=name=>args.includes('--'+name);
async function statuses(){await init();return Promise.all((await fs.readdir(home)).filter(n=>/^watch-[a-f0-9]{24}\.json$/.test(n)).map(n=>read(path.join(home,n))))}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
async function watch(){
  const sessionId=args[0],delivery=option('delivery')||'stdout',events=option('events')||'decisions';
  if(!/^[0-9a-f-]{36}$/i.test(sessionId ?? ''))throw new Error('Specify a Relaynote session UUID');
  if(!['stdout','codex','orca'].includes(delivery)||!['decisions','feedback'].includes(events))throw new Error('Invalid delivery or events mode');
  const thread=option('thread')||process.env.CODEX_THREAD_ID,remote=option('remote');
  if(delivery==='codex')codexArgs(thread,'probe',remote);
  if(delivery==='stdout'&&!option('consumer'))throw new Error('--consumer must identify this conversation watcher');
  const origin=delivery==='orca'?(process.env.RELAYNOTE_ORCA_ORIGIN?JSON.parse(process.env.RELAYNOTE_ORCA_ORIGIN):await captureOrca()):undefined;
  const auth=await credentials();const id=fingerprint({base:auth.base,sessionId,delivery,thread:delivery==='orca'?origin:delivery==='codex'?thread:option('consumer')||'stdout'}).slice(0,24);
  const statusPath=path.join(home,'watch-'+id+'.json'),statePath=path.join(home,'seen-'+id+'.json'),lockPath=path.join(home,'lock-'+id);
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600)}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await fs.readFile(lockPath,'utf8'));if(alive(pid))throw new Error('This review is already being monitored for this conversation');await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600)}
  await lock.writeFile(String(process.pid));await lock.close();
  const abort=new AbortController();let interruptWait;
  const stop=()=>{abort.abort();interruptWait?.()};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const status={id,sessionId,delivery,events,thread:delivery==='orca'?origin.thread:delivery==='codex'?thread:undefined,origin,pid:process.pid,startedAt:new Date().toISOString(),status:'waiting'};
  try{
    await write(statusPath,status);
    if(process.send){process.send({ready:true,id,pid:process.pid});process.disconnect()}
    await observe({sessionId,events,continuous:flag('continuous'),signal:abort.signal,
      getReview:async id=>{if((await credentials()).base!==auth.base)throw new Error('Access denied: server changed');return getReview(id)},
      loadState:()=>read(statePath).catch(e=>{if(e.code==='ENOENT')return null;throw e}),saveState:state=>write(statePath,state),
      wait:()=>new Promise(resolve=>{const timer=setTimeout(()=>{interruptWait=null;resolve()},3000);interruptWait=()=>{clearTimeout(timer);resolve()}}),
      deliver:async event=>{if(abort.signal.aborted)return; if(delivery==='orca')await sendOrca(origin,event,{signal:abort.signal});else if(delivery==='codex')await queueEvent(thread,event,remote);else await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(event)+'\n',e=>e?reject(e):resolve()));await write(statusPath,{...status,lastEventAt:new Date().toISOString(),lastEventId:event.event_id})},
      onRetry:()=>write(statusPath,{...status,lastConnectionErrorAt:new Date().toISOString()}),
    });
    await write(statusPath,{...await read(statusPath),status:abort.signal.aborted?'stopped':'completed'});
  }catch(e){await write(statusPath,{...status,status:'failed',error:e.message});throw e}
  finally{await fs.unlink(lockPath).catch(()=>{});process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
try{
  await init();
  switch(command){
    case '--version':console.log(VERSION);break;
    case 'login':{
      if((await statuses()).some(s=>s.status==='waiting'&&alive(s.pid)))throw new Error('Stop active watchers before changing authentication');
      if(flag('api-key-stdin')){let key='';for await(const b of process.stdin)key+=b;await apiKeyLogin(endpoint(option('server')),key)}else await login(endpoint(option('server')),{open:!flag('no-open')});console.log('Relaynote connected');break;
    }
    case 'watch':await watch();break;
    case 'start':{
      if(!['codex','orca'].includes(option('delivery')))throw new Error('start requires codex or orca delivery; use a harness-managed background task for stdout');
      let origin;
      if(option('delivery')==='orca')origin=await captureOrca();
      else {codexArgs(option('thread')||process.env.CODEX_THREAD_ID,'probe',option('remote'));verifyCodexQueue()}
      await credentials();await getReview(args[0]);
      const log=await fs.open(path.join(home,'watcher.log'),'a',0o600);
      const child=spawn(process.execPath,[entry,'watch',...args],{detached:true,env:{...process.env,...(origin?{RELAYNOTE_ORCA_ORIGIN:JSON.stringify(origin)}:{})},stdio:['ignore',log.fd,log.fd,'ipc']});
      await log.close();
      const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Watcher startup timed out'))},10000);child.once('message',data=>{clearTimeout(timer);resolve(data)});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Watcher did not start; check status and watcher.log'))})});
      child.unref();console.log(JSON.stringify({...ready,monitorProcessOnly:true}));break;
    }
    case 'status':console.log(JSON.stringify(await statuses(),null,2));break;
    case 'stop':{
      const id=args[0];if(!/^[a-f0-9]{24}$/.test(id??''))throw new Error('Specify a watcher id from status');
      const state=await read(path.join(home,'watch-'+id+'.json'));const pid=Number(await fs.readFile(path.join(home,'lock-'+id),'utf8').catch(()=>0));
      if(pid && pid===state.pid && state.status==='waiting' && alive(pid)){const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).stdout||'';if(!command.includes(entry))throw new Error('Process ownership cannot be verified');process.kill(pid,'SIGTERM');}console.log('Stop requested');break;
    }
    default:console.log('Relaynote feedback bridge 1.3.2\nlogin [--server ORIGIN] [--no-open | --api-key-stdin]\nwatch SESSION [--events decisions|feedback] [--continuous] [--consumer CONVERSATION_ID]\nstart SESSION --delivery orca [--events feedback] [--continuous]\nstart SESSION --delivery codex --thread UUID [--remote LOCAL_ENDPOINT] [--events feedback] [--continuous]\nstatus | stop WATCHER_ID');
  }
}catch(e){console.error(e.message);process.exitCode=1}
