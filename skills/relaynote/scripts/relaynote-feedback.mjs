#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {home,init,read,write,endpoint,VERSION} from './lib/state.mjs';
import {login,deviceLogin,apiKeyLogin,credentials} from './lib/auth.mjs';
import {bridge,deliverBridge} from './lib/bridge.mjs';
import {agents,deliverHttp,adapterTemplate,feedbackMessage} from './lib/adapters.mjs';
import {bindHook,runHook} from './lib/hooks.mjs';
import {deliveryClient,deliverDecision} from './lib/delivery.mjs';
import {eventSource} from './lib/events.mjs';
import {observe,queueEvent,fingerprint,codexArgs,verifyCodexQueue} from './lib/feedback.mjs';
import {captureOrca,sendOrca} from './lib/orca.mjs';
import {prepareImage,uploadAsset,DEFAULTS} from './lib/upload.mjs';
const entry=fileURLToPath(import.meta.url),[command,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]};
const flag=name=>args.includes('--'+name);
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const MAX_HOURS_DEFAULT=24, PRUNE_AFTER_MS=7*24*3600*1000;
// Live watchers are reported as they are; a watcher whose process vanished is marked stopped, and
// finished records older than a week are removed together with their cursor and lock files.
async function statuses(){
  await init();
  const out=[];
  for(const name of (await fs.readdir(home)).filter(n=>/^watch-[a-f0-9]{24}\.json$/.test(n))){
    const file=path.join(home,name);let state;
    try{state=await read(file)}catch{await fs.unlink(file).catch(()=>{});continue}
    if(state.status==='waiting'&&!alive(state.pid)){state={...state,status:'stopped',error:'Watcher process is gone'};await write(file,state)}
    const finishedAt=Date.parse(state.lastEventAt||state.startedAt||0);
    if(state.status!=='waiting'&&Number.isFinite(finishedAt)&&Date.now()-finishedAt>PRUNE_AFTER_MS){
      for(const stale of [file,path.join(home,'seen-'+state.id+'.json'),path.join(home,'lock-'+state.id)])await fs.unlink(stale).catch(()=>{});
      continue;
    }
    out.push(state);
  }
  return out;
}
async function stopWatcher(id){
  if(!/^[a-f0-9]{24}$/.test(id??''))throw new Error('Specify a watcher id from status');
  const state=await read(path.join(home,'watch-'+id+'.json'));const pid=Number(await fs.readFile(path.join(home,'lock-'+id),'utf8').catch(()=>0));
  if(pid && pid===state.pid && state.status==='waiting' && alive(pid)){const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).stdout||'';if(!/relaynote-feedback\.mjs\b.*\bwatch\b/.test(command)||!command.includes(state.sessionId))throw new Error('Process ownership cannot be verified');process.kill(pid,'SIGTERM');return true}
  return false;
}
async function watch(){
  const sessionId=args[0],delivery=option('delivery')||'stdout',events='decisions';
  if(!/^[0-9a-f-]{36}$/i.test(sessionId ?? ''))throw new Error('Specify a Relaynote session UUID');
  // Every watcher has a lifetime: it ends after --max-hours (default 24) or at the session's expiry, whichever comes first.
  const maxHours=Number(option('max-hours')??MAX_HOURS_DEFAULT);
  if(!(maxHours>=1&&maxHours<=720))throw new Error('--max-hours must be between 1 and 720');
  const deadline=Date.now()+maxHours*3600*1000;
  if(!['stdout','codex','orca','http','bridge'].includes(delivery)||!['decisions','feedback'].includes(events))throw new Error('Invalid delivery or events mode');
  if(option('events') && !['decisions','feedback'].includes(option('events')))throw new Error('Only final decision events are supported');
  const thread=option('thread')||process.env.CODEX_THREAD_ID,remote=option('remote');
  if(delivery==='codex')codexArgs(thread,'probe',remote);
  if(delivery==='bridge'&&(!thread||!option('socket')?.startsWith('/')))throw new Error('Bridge delivery needs its absolute socket path and exact originating thread');
  if(delivery==='stdout'&&!option('consumer'))throw new Error('--consumer must identify this conversation watcher');
  const origin=delivery==='orca'?(process.env.RELAYNOTE_ORCA_ORIGIN?JSON.parse(process.env.RELAYNOTE_ORCA_ORIGIN):await captureOrca()):undefined;
  const adapter=delivery==='http'?JSON.parse(await fs.readFile(option('adapter-file'),'utf8')):undefined;
  if(adapter&&(!thread||adapter.thread!==thread))throw new Error('An adapter for this originating conversation is required');
  const auth=await credentials();const id=fingerprint({base:auth.base,sessionId,delivery,thread:delivery==='orca'?origin:['codex','http','bridge'].includes(delivery)?thread:option('consumer')||'stdout'}).slice(0,24);
  const statusPath=path.join(home,'watch-'+id+'.json'),statePath=path.join(home,'seen-'+id+'.json'),lockPath=path.join(home,'lock-'+id);
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600)}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await fs.readFile(lockPath,'utf8'));if(alive(pid))throw new Error('This review is already being monitored for this conversation');await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600)}
  await lock.writeFile(String(process.pid));await lock.close();
  const abort=new AbortController();let interruptWait;
  const stop=()=>{abort.abort();interruptWait?.()};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const status={id,sessionId,delivery,events,thread:delivery==='orca'?origin.thread:['codex','http','bridge'].includes(delivery)?thread:undefined,origin,pid:process.pid,startedAt:new Date().toISOString(),status:'waiting',mode:'websocket',maxHours,endsAt:new Date(deadline).toISOString()};
  try{
    await write(statusPath,status);
    const source=eventSource(sessionId,{signal:abort.signal,onMode:async mode=>{status.mode=mode;await write(statusPath,{...await read(statusPath),mode})}});
    const post=deliveryClient(sessionId,id,auth.base);
    let bound=false,outcome;
    try {
    const initial=await source.snapshot();
    if(initial.delivery_protocol!==3)throw new Error('Upgrade Relaynote: final-decision delivery receipts (protocol 3) are required');
    await post('bind',{adapter:delivery,replace:flag('replace-binding')});bound=true;
    await source.ready();
    if(process.send){process.send({ready:true,id,pid:process.pid});process.disconnect()}
    outcome=await observe({sessionId,events,continuous:flag('continuous'),deadline,signal:abort.signal,
      getReview:async id=>{if((await credentials()).base!==auth.base)throw new Error('Access denied: server changed');return source.snapshot()},
      waitForChange:async(id,since,seconds)=>{if((await credentials()).base!==auth.base)throw new Error('Access denied: server changed');return source.wait(id,since,seconds)},
      loadState:()=>read(statePath).catch(e=>{if(e.code==='ENOENT')return null;throw e}),saveState:state=>write(statePath,state),
      wait:ms=>new Promise(resolve=>{const timer=setTimeout(()=>{interruptWait=null;resolve()},ms);interruptWait=()=>{clearTimeout(timer);resolve()}}),
      deliver:async event=>{
        if(abort.signal.aborted)return false;
        event.server_url=auth.base;
        const sent=await deliverDecision(event,{post,snapshot:()=>source.snapshot(),send:async beforeSend=>{
          if(delivery==='orca')return sendOrca(origin,event,{signal:abort.signal,beforeSend});
          if(abort.signal.aborted || !await beforeSend())return false;
          if(delivery==='bridge')await deliverBridge(option('socket'),thread,feedbackMessage(event));
          else if(delivery==='http')await deliverHttp(adapter,thread,event);
          else if(delivery==='codex')await queueEvent(thread,event,remote);
          else await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(event)+'\n',e=>e?reject(e):resolve()));
          return true;
        }});
        if(sent)await write(statusPath,{...status,lastEventAt:new Date().toISOString(),lastEventId:event.event_id});
        return sent;
      },
      onRetry:()=>write(statusPath,{...status,lastConnectionErrorAt:new Date().toISOString()}),
      onMode:async next=>{status.mode=next;await write(statusPath,{...await read(statusPath).catch(()=>({})),...status})},
    });
    } finally { source.close(); if(bound)await post('disconnect').catch(()=>{}); }
    const ended=abort.signal.aborted?'stopped':outcome?.ended??'completed';
    await write(statusPath,{...await read(statusPath),status:ended});
    // Tell a stdout consumer (e.g. a Claude Code Monitor) that nothing is being watched any more.
    if(delivery==='stdout'&&outcome?.ended)await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({type:'relaynote.watch.ended',session_id:sessionId,reason:outcome.ended,instruction:outcome.ended==='expired'?'This review session has expired; nothing more will arrive from it.':`This watcher reached its ${maxHours}-hour lifetime and stopped without a decision. If a decision is still expected, start the same watch command again; otherwise nothing is pending.`})+'\n',e=>e?reject(e):resolve()));
  }catch(e){await write(statusPath,{...status,status:'failed',error:e.message});throw e}
  finally{await fs.unlink(lockPath).catch(()=>{});process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
try{
  await init();
  switch(command){
    case 'bridge':{const index=args.indexOf('--');if(index<0)throw new Error('Missing initial agent command');await bridge(option('protocol'),option('socket'),args[index+1],args.slice(index+2));break;}
    case 'describe':{const agent=agents.find(a=>a.id===args[0]);if(!agent)throw new Error('Unknown host');console.log(JSON.stringify({...agent,transport:'websocket-hibernation',deliveryProtocol:3,eventScope:'final-decisions',reference:'references/agents.md'},null,2));break;}
    case 'agents':console.log(JSON.stringify(agents,null,2));break;
    case 'adapter-template':console.log(JSON.stringify(adapterTemplate(args[0],option('thread'),option('endpoint')),null,2));break;
    case 'bind':await bindHook(option('host'),option('thread'),args[0]);console.log('Review bound to the originating hook conversation');break;
    case 'hook':await runHook(option('host'),entry);break;
    case '--version':console.log(VERSION);break;
    case 'login':{
      if((await statuses()).some(s=>s.status==='waiting'&&alive(s.pid)))throw new Error('Stop active watchers before changing authentication');
      if(flag('api-key-stdin')){let key='';for await(const b of process.stdin)key+=b;await apiKeyLogin(endpoint(option('server')),key)}else if(flag('device'))await deviceLogin(endpoint(option('server')));else await login(endpoint(option('server')),{open:!flag('no-open')});console.log('Relaynote connected');break;
    }
    case 'watch':await watch();break;
    case 'start':{
      if(!['codex','orca','http','bridge'].includes(option('delivery')))throw new Error('start requires codex, orca, http or bridge delivery; use a harness-managed background task for stdout');
      let origin;
      if(option('delivery')==='orca')origin=await captureOrca();
      else if(option('delivery')==='codex'){codexArgs(option('thread')||process.env.CODEX_THREAD_ID,'probe',option('remote'));verifyCodexQueue()}
      await credentials();const probe=eventSource(args[0]);try{await probe.snapshot()}finally{probe.close()}
      const log=await fs.open(path.join(home,'watcher.log'),'a',0o600);
      const child=spawn(process.execPath,[entry,'watch',...args],{detached:true,env:{...process.env,...(origin?{RELAYNOTE_ORCA_ORIGIN:JSON.stringify(origin)}:{})},stdio:['ignore',log.fd,log.fd,'ipc']});
      await log.close();
      const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Watcher startup timed out'))},30000);child.once('message',data=>{clearTimeout(timer);resolve(data)});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Watcher did not start; check status and watcher.log'))})});
      child.unref();console.log(JSON.stringify({...ready,monitorProcessOnly:true}));break;
    }
    case 'upload':{
      // Bytes go file -> server directly; the model only handles the returned asset_id.
      if(!args[0])throw new Error('Specify an image file');
      const image=await prepareImage(args[0],{maxSide:Number(option('max-side')||DEFAULTS.maxSide),quality:Number(option('quality')||DEFAULTS.quality),keep:flag('keep')});
      const reply=await uploadAsset(option('session'),image);
      console.log(JSON.stringify({...reply,filename:image.filename,bytes:image.buffer.length,content_type:image.contentType,width:image.width,height:image.height,converter:image.converter,next:'append_blocks with {type:"image", asset_id, title, alt, description}'}));break;
    }
    case 'status':console.log(JSON.stringify(await statuses(),null,2));break;
    case 'stop':{
      if(flag('all')){let n=0;const skipped=[];for(const state of await statuses()){if(state.status!=='waiting')continue;try{if(await stopWatcher(state.id))n++}catch(e){skipped.push(`${state.id}: ${e.message}`)}}console.log(`Stop requested for ${n} watcher(s)`);for(const line of skipped)console.error(line);break;}
      await stopWatcher(args[0]);console.log('Stop requested');break;
    }
    default:console.log('Relaynote feedback bridge 3.0.3\nlogin [--server ORIGIN] [--no-open | --api-key-stdin]\nwatch SESSION [--events decisions] [--continuous] [--consumer CONVERSATION_ID] [--max-hours 24]\nstart SESSION --delivery orca [--events decisions] [--continuous] [--max-hours 24]\nstart SESSION --delivery codex --thread UUID [--remote LOCAL_ENDPOINT] [--events decisions] [--continuous]\nupload FILE --session SESSION [--max-side 1600] [--quality 76] [--keep]\nstatus | stop WATCHER_ID | stop --all\nlogin --device [--server ORIGIN]\nagents | describe HOST\nbind SESSION --host HOST --thread ORIGIN\nhook --host HOST\nadapter-template HOST --thread ORIGIN --endpoint URL\nstart SESSION --delivery http --thread ORIGIN --adapter-file FILE\nbridge --protocol acp|amp --socket ABSOLUTE_PATH -- COMMAND ARGS\nstart SESSION --delivery bridge --thread ORIGIN --socket ABSOLUTE_PATH');
  }
}catch(e){console.error(e.message);process.exitCode=1}
