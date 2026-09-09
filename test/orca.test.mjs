import test from 'node:test';
import assert from 'node:assert/strict';
import {sendOrca} from '../skills/relaynote/scripts/lib/orca.mjs';
const origin={command:'orca',handle:'term_test',incarnationId:'instance',worktreeId:'workspace',tabId:'tab',runtimeId:'runtime',thread:'thread',agent:{pid:123,started:'today',command:'codex'}};
const shown={ok:true,result:{terminal:{...origin,connected:true,writable:true}},_meta:{runtimeId:'runtime'}};
const idle={ok:true,result:{wait:{handle:origin.handle,condition:'tui-idle',satisfied:true}}};
const accepted=args=>({ok:true,result:{send:{handle:origin.handle,accepted:true,bytesWritten:Buffer.byteLength(args[args.indexOf('--text')+1])+1}}});
const event={event_id:'event',session_id:'session',instruction:'Read review in this same conversation.'};
test('Orca waits past timeouts then sends once to the pinned terminal',async()=>{
  const calls=[];let waits=0;
  await sendOrca(origin,event,{identity:async()=>origin.agent,command:async(cmd,args)=>{calls.push(args);if(args[1]==='show')return shown;if(args[1]==='wait'&&++waits<3)return {ok:false,error:{code:'timeout'}};if(args[1]==='wait')return idle;if(args[1]==='send')return accepted(args);return {ok:true}}});
  assert.equal(waits,3);const sends=calls.filter(a=>a[1]==='send');assert.equal(sends.length,1);assert.equal(sends[0][3],origin.handle);assert(sends[0].includes('--enter'));assert(calls.some(a=>a[1]==='read'));
});
test('Orca refuses changed runtime or terminal and never sends',async()=>{
  for(const changed of [{...shown,_meta:{runtimeId:'another'}},{...shown,result:{terminal:{...shown.result.terminal,incarnationId:'another'}}}]){
    await assert.rejects(sendOrca(origin,event,{identity:async()=>origin.agent,command:async()=>changed}),/changed or closed/);
  }
});
test('Orca refuses a replacement agent process',async()=>{
  await assert.rejects(sendOrca(origin,event,{identity:async()=>({...origin.agent,started:'later'}),command:async()=>{throw new Error('should not run')}}),/process changed/);
});
test('ambiguous Orca send stops without automatic retry',async()=>{
  let sends=0;await assert.rejects(sendOrca(origin,event,{identity:async()=>origin.agent,command:async(cmd,args)=>{if(args[1]==='show')return shown;if(args[1]==='send'){sends++;return {ok:false}}if(args[1]==='wait')return idle;return {ok:true}}}),/outcome unknown/);assert.equal(sends,1);
});

test('successful RPC with zero-byte refusal retains the decision until acceptance',async()=>{
 let sends=0,checks=0,pauses=0;
 assert.equal(await sendOrca(origin,event,{identity:async()=>origin.agent,pause:async()=>{pauses++},beforeSend:async()=>{checks++;return true},command:async(_,args)=>{
  if(args[1]==='show')return shown;if(args[1]==='wait')return idle;
  if(args[1]==='send'){sends++;return sends===1?{ok:true,result:{send:{handle:origin.handle,accepted:false,bytesWritten:0}}}:accepted(args)}
  return {ok:true};
 }}),true);
 assert.equal(sends,2);assert.equal(checks,2);assert.equal(pauses,1);
});
test('blocked idle RPC cannot send input',async()=>{
 let sends=0;
 await assert.rejects(sendOrca(origin,event,{identity:async()=>origin.agent,command:async(_,args)=>{
  if(args[1]==='show')return shown;if(args[1]==='send')sends++;
  return {ok:true,result:{wait:{handle:origin.handle,condition:'tui-idle',satisfied:false,blockedReason:'approval'}}};
 }}),/blocked/);assert.equal(sends,0);
});
test('missing, partial or foreign send receipts are ambiguous and never retried',async()=>{
 for(const send of [undefined,{handle:origin.handle,accepted:true,bytesWritten:1},{handle:'another',accepted:true,bytesWritten:9999}]){
  let sends=0;
  await assert.rejects(sendOrca(origin,event,{identity:async()=>origin.agent,command:async(_,args)=>{
   if(args[1]==='show')return shown;if(args[1]==='wait')return idle;
   if(args[1]==='send'){sends++;return {ok:true,result:{send}}}return {ok:true};
  }}),/outcome unknown/);assert.equal(sends,1);
 }
});
