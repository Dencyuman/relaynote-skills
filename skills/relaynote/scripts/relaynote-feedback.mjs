#!/usr/bin/env node
import {checkUpdates,updateInfo,updateMessage} from './lib/updates.mjs';
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
import {prepareFile,uploadArtifact,gitPatch} from './lib/artifact.mjs';
const entry=fileURLToPath(import.meta.url),[command,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]};
const flag=name=>args.includes('--'+name);
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const MAX_HOURS_DEFAULT=24, PRUNE_AFTER_MS=7*24*3600*1000;
// A watcher is live until it records one of these final states.
const FINAL=new Set(['completed','timed_out','expired','session_closed','stopped','failed']);
const isLive=state=>!FINAL.has(state.status);
const hostIds=agents.map(a=>a.id);
// One block per command: the banner is all of them, `COMMAND --help` prints one.
const USAGE={
 login:['login [--server ORIGIN] [--no-open | --device | --api-key-stdin] [--force]',
  '  Connects this machine. Repeating it for the server already connected prints the',
  '  connection and changes nothing; --force reauthorizes. Live watchers survive a',
  '  same-server login and pick up rotated tokens themselves; switching servers or',
  '  replacing OAuth with an API key requires stopping them first.'],
 watch:['watch SESSION --consumer CONVERSATION_ID [--events decisions|discussions] [--continuous] [--max-hours 24] [--replace-binding]',
  '  Foreground watcher for a harness-managed task; writes JSON lines to stdout:',
  '  relaynote.watch.started once bound, relaynote.feedback per final decision,',
  '  relaynote.watch.ended when nothing more can arrive. Ignore lines you do not know.'],
 start:['start SESSION --delivery codex|orca|http|bridge [--events decisions|discussions] [--continuous] [--max-hours 24] [--replace-binding]',
  '  start SESSION --delivery codex --thread UUID [--remote LOCAL_ENDPOINT]',
  '  start SESSION --delivery orca',
  '  start SESSION --delivery http --thread ORIGIN --adapter-file ABSOLUTE_PATH',
  '  start SESSION --delivery bridge --thread ORIGIN --socket ABSOLUTE_PATH',
  '  Detaches a background watcher and prints its startup receipt. stdout delivery',
  '  belongs to a harness-managed background task, not to start.',
  '  discussions opts into explicit discussion sends AND final decisions; saves stay silent.'],
 preflight:['preflight FILE --type pdf|csv|json|diff|mermaid|chart --renderer-project CHECKOUT --out NEW_DIRECTORY',
  '  Requires Node >=22.13, the renderer checkout dependencies, and local Chrome.',
  '  Use preflight git --type diff [--staged | --base REF --head REF] [--path PATH].',
  '  Chart CSV: --x COLUMN --y COLUMN[,COLUMN] [--kind bar|line].'],
 'upload-artifact':['upload-artifact MANIFEST --file ORIGINAL --session SESSION',
  '  Checks preflight hashes and uploads the exact artifact bytes before append_blocks.'],
 upload:['upload FILE --session SESSION [--max-side 1600] [--quality 76] [--keep]',
  '  Sends the bytes straight to the server and prints the asset id for append_blocks.'],
 status:['status [--all] [--json]',
  '  Lists live watchers as id status mode delivery session started ends.',
  '  --all adds finished records, --json prints every stored field.',
  '  Prunes finished records after a week.'],
 stop:['stop WATCHER_ID | stop --all',
  '  Asks a verified watcher process to stop; --all stops every live watcher.'],
 agents:['agents','  Prints the host registry as JSON.'],
 describe:[`describe [HOST]   (${hostIds.join(', ')})`,
  '  With a host id, prints its registry entry and transport facts. Without one,',
  '  detects the host from this process environment and prints the detection.'],
 bind:['bind SESSION --host HOST --thread ORIGIN',
  '  Arms a native Stop hook once for the originating conversation.'],
 hook:['hook --host HOST',
  '  Runs as that hook: reads the hook JSON on stdin and answers in the host format.'],
 'adapter-template':['adapter-template HOST --thread ORIGIN --endpoint URL',
  '  Prints a data-only adapter config for --delivery http.'],
 bridge:['bridge --protocol acp|amp --socket ABSOLUTE_PATH -- COMMAND ARGS',
  '  Owns the host agent process and accepts one delivery per originating conversation.'],
 'check-update':['check-update [--server ORIGIN]','  Reports skill compatibility without installing anything.'],
};
const usage=name=>USAGE[name].join('\n');
const banner=()=>`Relaynote feedback bridge ${VERSION}\n`+Object.keys(USAGE).map(usage).join('\n');
// Live watchers are reported as they are; with `prune`, a watcher whose process vanished is marked
// stopped and finished records older than a week are removed with their cursor and lock files.
// Everything else (the login guard) reads the same records without touching them.
async function statuses({prune=false}={}){
  await init();
  const out=[];
  for(const name of (await fs.readdir(home)).filter(n=>/^watch-[a-f0-9]{24}\.json$/.test(n))){
    const file=path.join(home,name);let state;
    try{state=await read(file)}catch{if(prune)await fs.unlink(file).catch(()=>{});continue}
    if(state.status==='waiting'&&!alive(state.pid)){
      state={...state,status:'stopped',error:'Watcher process is gone',endedAt:state.endedAt??new Date().toISOString()};
      if(prune)await write(file,state);
    }
    if(prune&&isLive(state)===false){
      // A record with no timestamp at all cannot age out of a NaN comparison: prune it now.
      const finishedAt=Date.parse(state.endedAt??state.lastEventAt??state.startedAt??'');
      if(!Number.isFinite(finishedAt)||Date.now()-finishedAt>PRUNE_AFTER_MS){
        for(const stale of [file,path.join(home,'seen-'+state.id+'.json'),path.join(home,'lock-'+state.id)])await fs.unlink(stale).catch(()=>{});
        continue;
      }
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
  const sessionId=args[0],delivery=option('delivery')||'stdout',events=option('events')==='discussions'?'discussions':'decisions';
  if(!/^[0-9a-f-]{36}$/i.test(sessionId ?? ''))throw new Error('Specify a Relaynote session UUID');
  // Every watcher has a lifetime: it ends after --max-hours (default 24) or at the session's expiry, whichever comes first.
  const maxHours=Number(option('max-hours')??MAX_HOURS_DEFAULT);
  if(!(maxHours>=1&&maxHours<=720))throw new Error('--max-hours must be between 1 and 720');
  const deadline=Date.now()+maxHours*3600*1000;
  if(!['stdout','codex','orca','http','bridge'].includes(delivery))throw new Error('Invalid delivery mode');
  // Preserve the legacy feedback alias as final-decisions-only.
  if(args.includes('--events')&&option('events')!==events){
    if(option('events')==='feedback')console.error(`--events feedback is deprecated; using ${events}`);
    else throw new Error('--events accepts only "decisions" or "discussions"');
  }
  const thread=option('thread')||process.env.CODEX_THREAD_ID,remote=option('remote');
  if(delivery==='codex')codexArgs(thread,'probe',remote);
  if(delivery==='bridge'&&(!thread||!option('socket')?.startsWith('/')))throw new Error('Bridge delivery needs its absolute socket path and exact originating thread');
  if(delivery==='stdout'&&!option('consumer'))throw new Error('--consumer must identify this conversation watcher');
  const origin=delivery==='orca'?(process.env.RELAYNOTE_ORCA_ORIGIN?JSON.parse(process.env.RELAYNOTE_ORCA_ORIGIN):await captureOrca()):undefined;
  let adapter;
  if(delivery==='http'){
    const file=option('adapter-file');
    if(!file?.startsWith('/'))throw new Error('--delivery http requires --adapter-file with an absolute path to the adapter JSON');
    let raw;try{raw=await fs.readFile(file,'utf8')}catch(e){throw new Error(`Cannot read --adapter-file ${file}: ${e.message}`,{cause:e})}
    try{adapter=JSON.parse(raw)}catch(e){throw new Error(`--adapter-file ${file} is not valid JSON: ${e.message}`,{cause:e})}
    if(!thread||adapter.thread!==thread)throw new Error('An adapter for this originating conversation is required');
  }
  const auth=await credentials();const id=fingerprint({base:auth.base,sessionId,delivery,thread:delivery==='orca'?origin:['codex','http','bridge'].includes(delivery)?thread:option('consumer')||'stdout'}).slice(0,24);
  const statusPath=path.join(home,'watch-'+id+'.json'),statePath=path.join(home,'seen-'+id+'.json'),lockPath=path.join(home,'lock-'+id);
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600)}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await fs.readFile(lockPath,'utf8'));if(alive(pid))throw new Error('This review is already being monitored for this conversation');await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600)}
  await lock.writeFile(String(process.pid));await lock.close();
  const abort=new AbortController();let interruptWait;
  const stop=()=>{abort.abort();interruptWait?.()};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const line=value=>new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',e=>e?reject(e):resolve()));
  const status={id,sessionId,delivery,events,thread:delivery==='orca'?origin.thread:['codex','http','bridge'].includes(delivery)?thread:undefined,origin,pid:process.pid,startedAt:new Date().toISOString(),status:'waiting',mode:'websocket',maxHours,endsAt:new Date(deadline).toISOString()};
  // Every later write merges into the stored record so a concurrent field is never dropped.
  const patch=async fields=>write(statusPath,{...await read(statusPath).catch(()=>status),...fields});
  try{
    await write(statusPath,status);
    const source=eventSource(sessionId,{bindingId:id,signal:abort.signal,onMode:async mode=>{status.mode=mode;await patch({mode})}});
    const post=deliveryClient(sessionId,id,auth.base);
    let bound=false,outcome;
    try {
    const initial=await source.snapshot();
    if(initial.delivery_protocol!==3)throw new Error('Upgrade Relaynote: final-decision delivery receipts (protocol 3) are required');
    if(events==='discussions' && initial.discussion_protocol!==1)throw new Error('Upgrade Relaynote: discussion_protocol 1 is required for --events discussions');
    await post('bind',{adapter:delivery,replace:flag('replace-binding'),discussions:events==='discussions'});bound=true;
    await source.ready();
    // Tell a stdout consumer that the binding exists, so silence afterwards is not ambiguity.
    if(delivery==='stdout')await line({type:'relaynote.watch.started',session_id:sessionId,watcher_id:id,consumer:option('consumer'),delivery:'stdout',mode:status.mode,binding:'bound',ends_at:status.endsAt,instruction:'Binding confirmed. Nothing arrives until a final decision.'});
    const update=updateInfo(initial.release);
    const notice=updateMessage(initial.release);if(notice)console.error(notice);
    if(process.send){process.send({ready:true,id,pid:process.pid,skillUpdate:update});process.disconnect()}
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
          else await line(event);
          return true;
        }});
        if(sent)await patch({lastEventAt:new Date().toISOString(),lastEventId:event.event_id});
        return sent;
      },
      onRetry:()=>patch({lastConnectionErrorAt:new Date().toISOString()}),
      onMode:async next=>{status.mode=next;await patch({mode:next})},
    });
    } finally { source.close(); if(bound)await post('disconnect').catch(()=>{}); }
    const ended=abort.signal.aborted?'stopped':outcome?.ended??'completed';
    await patch({status:ended,endedAt:new Date().toISOString()});
    // Tell a stdout consumer (e.g. a Claude Code Monitor) that nothing is being watched any more.
    if(delivery==='stdout'&&outcome?.ended)await line({type:'relaynote.watch.ended',session_id:sessionId,reason:outcome.ended,instruction:outcome.ended==='expired'?'This review session has expired; nothing more will arrive from it.':outcome.ended==='session_closed'?'The reviewer closed this review session. Stop working on it and do not append to it; a reopened or new session needs its own watch command.':`This watcher reached its ${maxHours}-hour lifetime and stopped without a decision. If a decision is still expected, start the same watch command again; otherwise nothing is pending.`});
  }catch(e){await patch({status:'failed',error:e.message,endedAt:new Date().toISOString()});throw e}
  finally{await fs.unlink(lockPath).catch(()=>{});process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
// The originating host is read from this process environment; ORCA_TERMINAL_HANDLE alone is not Orca.
function detectHost(env=process.env){
  const seen=names=>names.filter(name=>env[name]);
  const claude=seen(['CLAUDECODE','CLAUDE_CODE_SESSION_ID']);
  if(claude.length)return {id:'claude-code',reason:claude.join(', ')};
  if(env.CODEX_THREAD_ID&&env.ORCA_TERMINAL_HANDLE)return {id:'orca',reason:'CODEX_THREAD_ID, ORCA_TERMINAL_HANDLE'};
  if(env.CODEX_THREAD_ID)return {id:'codex',reason:'CODEX_THREAD_ID'};
  const cursor=Object.keys(env).filter(name=>name.startsWith('CURSOR_')&&env[name]).sort();
  if(cursor.length)return {id:'cursor-cli',reason:cursor.join(', ')};
  return {id:null,reason:'no host environment variable set'};
}
try{
  // --help answers before init(), a login guard, a spawn or any other side effect.
  if(USAGE[command]&&(args.includes('--help')||args.includes('-h')))console.log(usage(command));
  else{
  await init();
  switch(command){
    case 'bridge':{const index=args.indexOf('--');if(index<0)throw new Error('Missing initial agent command');await bridge(option('protocol'),option('socket'),args[index+1],args.slice(index+2));break;}
    case 'describe':{
      if(!args[0]||args[0].startsWith('-')){const {id,reason}=detectHost();console.log(JSON.stringify({detected:id,reason,adapter:agents.find(a=>a.id===id)??null,hosts:hostIds},null,2));break;}
      const agent=agents.find(a=>a.id===args[0]);
      if(!agent)throw new Error(`Unknown host "${args[0]}". Valid: ${hostIds.join(', ')}`);
      console.log(JSON.stringify({...agent,transport:'websocket-hibernation',sharedRuntime:{protocol:1,reference:'references/runtime.md',setup:'relaynote-runtime.mjs setup --accept-install',registration:'Existing conversation only; verify this host recipe first'},deliveryProtocol:3,eventScope:'final-decisions',optionalEvents:{discussions:{serverCapability:'discussion_protocol: 1',argument:'--events discussions',reference:'references/discussions.md'}},artifacts:{reference:'references/artifacts.md',requires:['Node.js >=22.13','Relaynote renderer checkout with pinned npm dependencies','local Google Chrome']},reference:'references/agents.md'},null,2));break;
    }
    case 'agents':console.log(JSON.stringify(agents,null,2));break;
    case 'adapter-template':console.log(JSON.stringify(adapterTemplate(args[0],option('thread'),option('endpoint')),null,2));break;
    case 'bind':await bindHook(option('host'),option('thread'),args[0]);console.log('Review bound to the originating hook conversation');break;
    case 'hook':await runHook(option('host'),entry);break;
    case '--version':console.log(VERSION);break;
    case 'check-update':console.log(JSON.stringify(await checkUpdates(option('server') || (await credentials()).base)));break;
    case 'login':{
      // Watchers re-read auth.json on every request and refuse a changed origin, so re-authorizing the
      // same server is safe while they run; only a different origin or a lost refresh token breaks them.
      const target=endpoint(option('server')),stored=await credentials().catch(()=>null);
      const live=(await statuses()).filter(s=>s.status==='waiting'&&alive(s.pid));
      if(live.length&&stored&&stored.base!==target)throw new Error(`${live.length} watcher(s) are bound to ${stored.base}; stop them before switching to ${target}`);
      if(live.length&&flag('api-key-stdin')&&stored?.refreshToken&&!flag('force'))throw new Error(`Switching to an API key drops the refresh token ${live.length} live watcher(s) rely on; stop them first or pass --force`);
      if(!flag('force')&&!flag('api-key-stdin')&&stored?.base===target&&(stored.refreshToken||stored.apiKey)){
        console.log(`Already connected to ${target} (scope: ${stored.scope||(stored.apiKey?'api key':'unknown')}); ${live.length} live watcher(s) keep working and pick up rotated tokens automatically. Pass --force to reauthorize.`);break;
      }
      if(flag('api-key-stdin')){let key='';for await(const b of process.stdin)key+=b;await apiKeyLogin(target,key)}else if(flag('device'))await deviceLogin(target);else await login(target,{open:!flag('no-open')});console.log('Relaynote connected');break;
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
    case 'preflight':{
      if(!option('renderer-project')||!option('out'))throw new Error('Specify --renderer-project RELAYNOTE_CHECKOUT and --out NEW_DIRECTORY. Requires its pinned npm dependencies and local Chrome.');
      let file=args[0];
      if(option('type')==='diff'&&!file?.startsWith('--')&&file==='git'){
        const output=path.resolve(option('out'));await fs.mkdir(output,{recursive:true});
        file=path.join(output,'input.diff');
        await fs.writeFile(file,gitPatch({base:option('base'),head:option('head'),staged:flag('staged'),paths:option('path')?[option('path')]:[]}),{flag:'wx'});
      }
      const result=spawnSync(process.execPath,[path.resolve(option('renderer-project'),'scripts/review-preflight.mjs'),'--file',file,'--type',option('type')||path.extname(file).slice(1),'--out',option('out'),...['title','x','y','kind'].flatMap(name=>option(name)?['--'+name,option(name)]:[])],{stdio:'inherit',timeout:180000});
      if(result.error||result.status!==0)throw new Error('Preflight failed; no upload or review notification was sent.');
      break;
    }
    case 'upload-artifact':{
      const block=await uploadArtifact(args[0],option('file'),option('session'));
      console.log(JSON.stringify({block,next:'append_blocks with this block; await all uploads, then publish_session for the exact round.'}));break;
    }
    case 'upload':{
      // Bytes go file -> server directly; the model only handles the returned asset_id.
      if(!args[0])throw new Error('Specify an image, PDF, CSV, JSON or validated SVG file');
      const image=/\.(pdf|csv|json|svg)$/i.test(args[0])?await prepareFile(args[0]):await prepareImage(args[0],{maxSide:Number(option('max-side')||DEFAULTS.maxSide),quality:Number(option('quality')||DEFAULTS.quality),keep:flag('keep')});
      const reply=await uploadAsset(option('session'),image);
      console.log(JSON.stringify({...reply,filename:image.filename,bytes:image.buffer.length,content_type:image.contentType,width:image.width,height:image.height,converter:image.converter,next:/\.(pdf|csv|json|svg)$/i.test(args[0])?'Asset uploaded only. Use preflight and upload-artifact to obtain a validated block before append_blocks.':'append_blocks with {type:"image", asset_id, title, alt, description}'}));break;
    }
    case 'status':{
      const all=await statuses({prune:true});
      if(flag('json')){console.log(JSON.stringify(all,null,2));break;}
      const rows=flag('all')?all:all.filter(isLive);
      if(!rows.length){console.log(flag('all')?'No watchers':'No live watchers; --all lists finished ones');break;}
      const table=[['ID','STATUS','MODE','DELIVERY','SESSION','STARTED','ENDS'],
        ...rows.map(s=>[s.id,s.status,s.mode??'-',s.delivery,s.sessionId,s.startedAt??'-',s.endedAt??s.endsAt??'-'].map(v=>String(v??'-')))];
      const width=table[0].map((_,i)=>Math.max(...table.map(row=>row[i].length)));
      for(const row of table)console.log(row.map((value,i)=>value.padEnd(width[i])).join('  ').trimEnd());
      break;
    }
    case 'stop':{
      if(flag('all')){let n=0;const skipped=[];for(const state of await statuses({prune:true})){if(state.status!=='waiting')continue;try{if(await stopWatcher(state.id))n++}catch(e){skipped.push(`${state.id}: ${e.message}`)}}console.log(`Stop requested for ${n} watcher(s)`);for(const line of skipped)console.error(line);break;}
      await stopWatcher(args[0]);console.log('Stop requested');break;
    }
    default:
      if(command===undefined||['help','--help','-h'].includes(command)){console.log(banner());break;}
      console.error(`Unknown command: ${command}\n\n${banner()}`);process.exitCode=1;
  }
  }
}catch(e){console.error(process.env.RELAYNOTE_DEBUG?(e.stack??e.message):e.message);if(process.env.RELAYNOTE_DEBUG&&e.cause)console.error('cause:',e.cause?.stack??String(e.cause));process.exitCode=1}
