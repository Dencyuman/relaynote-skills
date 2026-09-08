import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverDecision,StaleDelivery} from '../skills/relaynote/scripts/lib/delivery.mjs';
import {sendOrca} from '../skills/relaynote/scripts/lib/orca.mjs';
const event=()=>({session_id:'session',decision_id:'decision',round:1});
function fixture(){const calls=[];return {calls,post:async(action)=>{calls.push(action);return {delivery_id:'receipt',status:'waiting'}},snapshot:async()=>({current_round:1,latest_review:{id:'decision'}})}}
test('reports waiting, sending and sent, carries receipt ID, never invents AI acknowledgement',async()=>{
 const f=fixture(),e=event();const sent=await deliverDecision(e,{...f,send:async before=>{assert.equal(await before(),true);assert.equal(e.delivery_id,'receipt');return true}});
 assert(sent);assert.deepEqual(f.calls,['claim','sending','sent']);
});
test('a round changed while the origin was busy is discarded at the send point',async()=>{
 const f=fixture();let wrote=false;
 const sent=await deliverDecision(event(),{...f,snapshot:async()=>({current_round:2,latest_review:null}),send:async before=>{if(!await before())return false;wrote=true}});
 assert.equal(sent,false);assert.equal(wrote,false);assert.deepEqual(f.calls,['claim']);
});
test('replacement binding detected by the atomic send claim prevents input',async()=>{
 const f=fixture();let wrote=false;
 const sent=await deliverDecision(event(),{...f,post:async action=>{if(action==='sending')throw new StaleDelivery('replaced');return f.post(action)},send:async before=>{if(!await before())return false;wrote=true}});
 assert.equal(sent,false);assert.equal(wrote,false);
});
test('ambiguous acceptance records failure and is not replayed on restart',async()=>{
 const f=fixture();let sends=0;
 await assert.rejects(deliverDecision(event(),{...f,send:async before=>{await before();sends++;throw new Error('unknown acceptance')}}),/unknown acceptance/);
 assert.deepEqual(f.calls,['claim','sending','failed']);
 for(const status of ['sending','sent','received','failed']) {
  assert.equal(await deliverDecision(event(),{...f,post:async()=>({delivery_id:'receipt',status}),send:async()=>{sends++}}),false);
 }
 assert.equal(sends,1);
});
test('Orca revalidates only after idle, then discards without sending',async()=>{
 const origin={command:'orca',handle:'term',incarnationId:'i',worktreeId:'w',tabId:'t',runtimeId:'r',thread:'thread',agent:{pid:1,started:'today',command:'codex'}};
 let idle=false,sends=0,checked=0;
 const result=await sendOrca(origin,event(),{identity:async()=>origin.agent,command:async(_,args)=>{
  if(args[1]==='show')return {ok:true,result:{terminal:{...origin,connected:true,writable:true}},_meta:{runtimeId:'r'}};
  if(args[1]==='wait')idle=true;if(args[1]==='send')sends++;return {ok:true};
 },beforeSend:async()=>{assert(idle);checked++;return false}});
 assert.equal(result,false);assert.equal(checked,1);assert.equal(sends,0);
});
