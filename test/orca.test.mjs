import test from 'node:test';
import assert from 'node:assert/strict';
import {sendOrca} from '../skills/relaynote/scripts/lib/orca.mjs';
const origin=()=>({command:'orca',handle:'term_test',incarnationId:'instance',worktreeId:'workspace',worktreePath:'/w',tabId:'tab',runtimeId:'runtime',thread:'thread',agent:{pid:123,started:'today',command:'codex'}});
const terminal=(over={})=>({handle:'term_test',incarnationId:'instance',worktreeId:'workspace',worktreePath:'/w',tabId:'tab',connected:true,writable:true,orphaned:false,...over});
const listed=(...terminals)=>({ok:true,result:{terminals},_meta:{runtimeId:'runtime'}});
const idle=handle=>({ok:true,result:{wait:{handle,condition:'tui-idle',satisfied:true}}});
const accepted=args=>({ok:true,result:{send:{handle:args[3],accepted:true,bytesWritten:Buffer.byteLength(args[args.indexOf('--text')+1])+1}}});
const event={event_id:'event',session_id:'session',instruction:'Read review in this same conversation.'};
const codex={pid:123,started:'today',command:'codex'};
/** Default injections: the pinned Codex is alive and nothing else needs discovering. */
const live={identity:async()=>codex,processes:async()=>[codex],cwd:async()=>'/w'};
const driver=(terminals,extra={})=>async(cmd,args)=>{
  if(args[1]==='list')return listed(...terminals);
  if(args[1]==='show')return {ok:true,result:{terminal:terminals[0]},_meta:{runtimeId:'runtime'}};
  if(args[1]==='wait')return extra.wait?extra.wait(args):idle(args[3]);
  if(args[1]==='send')return extra.send?extra.send(args):accepted(args);
  return {ok:true};
};
test('Orca waits past timeouts then sends once to the pinned terminal',async()=>{
  const calls=[];let waits=0;
  const o=origin();
  await sendOrca(o,event,{...live,command:async(cmd,args)=>{calls.push(args);
    if(args[1]==='wait'&&++waits<3)return {ok:false,error:{code:'timeout'}};
    return driver([terminal()])(cmd,args)}});
  assert.equal(waits,3);const sends=calls.filter(a=>a[1]==='send');assert.equal(sends.length,1);assert.equal(sends[0][3],o.handle);assert(sends[0].includes('--enter'));assert(calls.some(a=>a[1]==='read'));
});
test('a re-issued terminal handle for the same conversation is adopted and persisted',async()=>{
  const o=origin(),persisted=[];
  const sends=[];
  assert.equal(await sendOrca(o,event,{...live,onOrigin:async value=>persisted.push({...value}),
    command:driver([terminal({handle:'term_new'})],{send:args=>{sends.push(args[3]);return accepted(args)}})}),true);
  assert.equal(o.handle,'term_new');
  assert.deepEqual(sends,['term_new']);
  assert.equal(persisted.at(-1).handle,'term_new');
  assert.equal(persisted.at(-1).incarnationId,'instance');
});
test('a restarted Codex under the same terminal is re-found by worktree, not refused',async()=>{
  const o=origin(),replacement={pid:999,started:'later',command:'/usr/local/bin/codex'};
  const persisted=[];
  assert.equal(await sendOrca(o,event,{onOrigin:async v=>persisted.push({...v}),
    identity:async()=>({pid:123,started:'much later',command:'zsh'}),
    processes:async()=>[{pid:5,started:'x',command:'node'},replacement],
    cwd:async pid=>pid===999?'/w':'/elsewhere',
    command:driver([terminal()])}),true);
  assert.equal(o.agent.pid,999);
  assert.equal(persisted.at(-1).agent.pid,999);
});
test('a different tab or incarnation is refused with an identity reason and never sent',async()=>{
  for(const changed of [{incarnationId:'another'},{tabId:'another'}]){
    let sends=0;
    const error=await sendOrca(origin(),event,{...live,command:driver([terminal(changed)],{send:()=>{sends++;return {ok:true}}})}).catch(e=>e);
    assert.match(error.message,/no longer open/);
    assert.equal(error.reason,'identity');
    assert.equal(sends,0);
  }
});
test('a disconnected or orphaned terminal is an identity refusal',async()=>{
  for(const broken of [{connected:false},{writable:false},{orphaned:true}]){
    const error=await sendOrca(origin(),event,{...live,command:driver([terminal(broken)])}).catch(e=>e);
    assert.equal(error.reason,'identity');
    assert.match(error.message,/disconnected, read-only or orphaned/);
  }
});
test('no Codex running in the originating worktree is refused before any send',async()=>{
  let sends=0;
  const error=await sendOrca(origin(),event,{identity:async()=>({pid:123,started:'later',command:'zsh'}),
    processes:async()=>[],cwd:async()=>null,
    command:driver([terminal()],{send:()=>{sends++;return {ok:true}}})}).catch(e=>e);
  assert.equal(error.reason,'identity');
  assert.match(error.message,/No Codex process is running/);
  assert.equal(sends,0);
});
test('ambiguous Orca send stops without automatic retry',async()=>{
  let sends=0;const error=await sendOrca(origin(),event,{...live,command:driver([terminal()],{send:()=>{sends++;return {ok:false}}})}).catch(e=>e);
  assert.match(error.message,/outcome unknown/);assert.equal(error.reason,'transport_unknown');assert.equal(sends,1);
});

test('successful RPC with zero-byte refusal retains the decision until acceptance',async()=>{
 let sends=0,checks=0;const pauses=[];
 assert.equal(await sendOrca(origin(),event,{...live,pause:async ms=>{pauses.push(ms)},beforeSend:async()=>{checks++;return true},
  command:driver([terminal()],{send:args=>{sends++;return sends===1?{ok:true,result:{send:{handle:args[3],accepted:false,bytesWritten:0}}}:accepted(args)}})}),true);
 assert.equal(sends,2);assert.equal(checks,2);assert.deepEqual(pauses,[1000]);
});
test('a terminal that never accepts input fails with a busy reason inside the deadline',async()=>{
 let sends=0;const pauses=[];
 const error=await sendOrca(origin(),event,{...live,busyMs:120,pause:async ms=>{pauses.push(ms)},
  command:driver([terminal()],{send:args=>{sends++;return {ok:true,result:{send:{handle:args[3],accepted:false,bytesWritten:0}}}}})}).catch(e=>e);
 assert.equal(error.reason,'busy');
 assert.match(error.message,/stayed busy/);
 assert(sends>=1);
 assert.deepEqual(pauses.slice(0,4),[1000,2000,5000,10000].slice(0,pauses.length));
});
test('blocked idle RPC cannot send input',async()=>{
 let sends=0;
 const error=await sendOrca(origin(),event,{...live,command:driver([terminal()],{wait:args=>({ok:true,result:{wait:{handle:args[3],condition:'tui-idle',satisfied:false,blockedReason:'approval'}}}),send:()=>{sends++;return {ok:true}}})}).catch(e=>e);
 assert.match(error.message,/blocked/);assert.equal(error.reason,'identity');assert.equal(sends,0);
});
test('missing, partial or foreign send receipts are ambiguous and never retried',async()=>{
 for(const send of [undefined,{handle:'term_test',accepted:true,bytesWritten:1},{handle:'another',accepted:true,bytesWritten:9999}]){
  let sends=0;
  const error=await sendOrca(origin(),event,{...live,command:driver([terminal()],{send:()=>{sends++;return {ok:true,result:{send}}}})}).catch(e=>e);
  assert.match(error.message,/outcome unknown/);assert.equal(error.reason,'transport_unknown');assert.equal(sends,1);
 }
});
test('a build without `terminal list` still delivers through the stored handle',async()=>{
 const sends=[];
 assert.equal(await sendOrca(origin(),event,{...live,command:async(cmd,args)=>{
  if(args[1]==='list')return {ok:false,error:{code:'invalid_argument'}};
  if(args[1]==='show')return {ok:true,result:{terminal:terminal()},_meta:{runtimeId:'runtime'}};
  if(args[1]==='wait')return idle(args[3]);
  if(args[1]==='send'){sends.push(args[3]);return accepted(args)}
  return {ok:true};
 }}),true);
 assert.deepEqual(sends,['term_test']);
});
