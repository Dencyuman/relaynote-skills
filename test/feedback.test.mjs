import test from 'node:test';import assert from 'node:assert/strict';
import {observe,snapshot,fingerprint,codexArgs} from '../skills/relaynote/scripts/lib/feedback.mjs';
const empty={current_round:1,latest_review:null,open_comments:[],forms:[],tables:[]};
const decision={...empty,latest_review:{id:'decision-1',round:1,decision:'approved'}};
const at=(review,updated_at)=>({...review,updated_at});

function setup(values,options={}){let state=null,index=0,events=[];const abort=new AbortController();const take=async()=>{if(index>=values.length){abort.abort();return {pending:true,updated_at:'t'}}const v=values[index++];if(v instanceof Error)throw v;return {...v,updated_at:'t'+index}};return {events,abort,run:()=>observe({sessionId:'test',events:'feedback',getReview:take,waitForChange:take,deliver:async e=>events.push(e),loadState:async()=>state,saveState:async v=>{state=v},wait:async()=>{},signal:abort.signal,...options})}}
test('long idle/reconnect needs no model and decision is delivered once',async()=>{const x=setup([empty,new Error('network'),empty,decision]);await x.run();assert.equal(x.events.length,1);assert.equal(x.events[0].feedback.decision.decision,'approved')});
test('comment edits remain silent until the final decision',async()=>{const comment={...empty,open_comments:[{id:'c',body:'fix'}]};const edited={...comment,open_comments:[{id:'c',body:'fix please'}]};const x=setup([empty,comment,comment,edited,decision,decision],{continuous:true});await x.run();assert.equal(x.events.length,1)});
test('an empty new AI round is not feedback',async()=>{const x=setup([empty,{...empty,current_round:2}],{continuous:true});await x.run();assert.equal(x.events.length,0)});
test('delivery error stops without committing the cursor or launching replacements',async()=>{let saved=false;const x=setup([decision],{deliver:async()=>{throw new Error('origin unavailable')},saveState:async()=>{saved=true}});await assert.rejects(x.run(),/origin unavailable/);assert.equal(saved,false)});
test('persisted cursor prevents a restart from replaying the same decision',async()=>{const s=snapshot(decision,'feedback');const x=setup([decision],{loadState:async()=>({round:1,hash:fingerprint(s)})});await x.run();assert.equal(x.events.length,0)});
test('Codex only targets exact existing UUID via queue, with no shell interpretation',()=>{const thread='12345678-1234-1234-1234-123456789abc';assert.deepEqual(codexArgs(thread,'$(touch /tmp/no)'),['queue','--thread',thread,'--message','$(touch /tmp/no)']);assert.throws(()=>codexArgs('--last','x'));assert.throws(()=>codexArgs(thread,'x','wss://unknown.example'))});
test('authentication failures terminate rather than retrying forever',async()=>{class AuthError extends Error{};const x=setup([new AuthError('Reconnect')]);await assert.rejects(x.run(),/Reconnect/)});

// One held request per watcher. values[0] answers the baseline get_session_review; the rest answer wait_for_review.
function longPoll(values,options={}){
  let state=null,index=0;
  const events=[],modes=[],retries=[],sinces=[],waits=[],saved=[];
  const abort=new AbortController();
  const take=()=>{if(index>=values.length){abort.abort();return {pending:true}}const v=values[index++];if(v instanceof Error)throw v;return v};
  const base={sessionId:'test',events:'feedback',continuous:true,signal:abort.signal,
    getReview:async()=>take(),
    waitForChange:async(id,since)=>{sinces.push(since);return take()},
    deliver:async e=>{events.push(e)},
    loadState:async()=>state,saveState:async v=>{state=v;saved.push(v)},
    wait:async ms=>{waits.push(ms)},
    onRetry:async()=>{retries.push(Date.now())},onMode:async m=>{modes.push(m)}};
  return {events,modes,retries,sinces,waits,saved,abort,get state(){return state},run:()=>observe({...base,...options})};
}

test('a push wait timeout re-arms without delivering or moving the cursor',async()=>{
  const x=longPoll([at(empty,'t0'),{pending:true,updated_at:'t0'},{pending:true,updated_at:'t0'}]);
  await x.run();
  assert.equal(x.events.length,0);
  assert.deepEqual(x.sinces,['t0','t0','t0']);
  assert.deepEqual(x.waits,[]); // no sleeping between long polls; the request itself is the wait
  assert.deepEqual(x.modes,['websocket']);
});

test('a change wakes the watcher once and stores the new updated_at cursor',async()=>{
  const x=longPoll([at(empty,'t0'),at(decision,'t1')]);
  await x.run();
  assert.equal(x.events.length,1);
  assert.equal(x.events[0].feedback.decision.decision,'approved');
  assert.equal(x.state.updatedAt,'t1');
  assert.deepEqual(x.sinces,['t0','t1']);
});

test('a server without a change cursor is rejected without polling',async()=>{
 const x=longPoll([empty,decision]);await assert.rejects(x.run(),/must provide a change cursor/);assert.equal(x.sinces.length,0);
});

test('transient failures retry with backoff and then succeed',async()=>{
  const x=longPoll([at(empty,'t0'),new Error('fetch failed'),new Error('MCP request failed (503)'),at(decision,'t1')]);
  await x.run();
  assert.equal(x.retries.length,2);
  assert.deepEqual(x.waits,[3000,6000]);
  assert.equal(x.events.length,1);
  assert.deepEqual(x.modes,['websocket']); // an outage is not a downgrade
});

test('a push wait delivery error still fails closed without committing the cursor',async()=>{
  const x=longPoll([at(decision,'t1')],{deliver:async()=>{throw new Error('origin unavailable')}});
  await assert.rejects(x.run(),/origin unavailable/);
  assert.deepEqual(x.saved,[]);
});

test('a resumed watcher push waits from its persisted cursor',async()=>{
  const s=snapshot(decision,'feedback');
  const x=longPoll([at(decision,'t1'),at(decision,'t1')],{loadState:async()=>({round:1,hash:fingerprint(s),updatedAt:'t1'})});
  await x.run();
  assert.equal(x.events.length,0); // already delivered before the restart
  assert.equal(x.sinces[0],'t1'); // resumes from the saved cursor, not from "now"
});

test('a watcher ends at its deadline or at the session expiry without delivering',async()=>{
  const past=longPoll([at(empty,'t0')],{deadline:Date.now()-1});
  assert.deepEqual(await past.run(),{ended:'timed_out'});
  assert.equal(past.events.length,0);
  const expired=longPoll([{...at(empty,'t0'),expires_at:new Date(Date.now()-1000).toISOString()},{pending:true,updated_at:'t0'}]);
  assert.deepEqual(await expired.run(),{ended:'expired'});
  assert.equal(expired.events.length,0);
  const alive=longPoll([at(empty,'t0'),{pending:true,updated_at:'t0'}],{deadline:Date.now()+3600_000});
  assert.equal(await alive.run(),undefined); // ran out of scripted answers, not out of time
});
