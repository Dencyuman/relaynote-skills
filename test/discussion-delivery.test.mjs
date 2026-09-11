import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverDecision} from '../skills/relaynote/scripts/lib/delivery.mjs';

test('discussion delivery rechecks its round and final status at the actual send point',async()=>{
  const event={event_kind:'discussion',round:1,discussion_id:'d',decision_id:'d'};
  const actions=[];
  const post=async(action,ids)=>{actions.push({action,...ids});return {status:'waiting',delivery_id:'receipt'}};
  let sent=0;
  const send=async before=>{if(!await before())return false;sent++;return true};
  const current={current_round:1,review_status:'in_review',discussions:[{id:'d',reviewRound:1}]};
  assert.equal(await deliverDecision({...event},{post,snapshot:async()=>current,send}),true);
  assert.equal(sent,1);
  assert.deepEqual(actions.map(a=>a.action),['claim','sending','sent']);
  assert.ok(actions.every(a=>a.event_kind==='discussion'));
  assert.equal(await deliverDecision({...event},{post,snapshot:async()=>({...current,review_status:'approved'}),send}),false);
  assert.equal(await deliverDecision({...event},{post,snapshot:async()=>({...current,current_round:2}),send}),false);
  assert.equal(sent,1);
});

import {discussionEvent} from '../skills/relaynote/scripts/lib/feedback.mjs';
test('linked answer guidance is capability gated and preserves event identity',()=>{
  const discussion={id:'d',reviewRound:1};
  const legacy=discussionEvent('s',discussion);
  const linked=discussionEvent('s',discussion,1);
  assert.equal(legacy.event_id,linked.event_id);
  assert.doesNotMatch(legacy.instruction,/supplement.discussion_id/);
  assert.match(linked.instruction,/supplement.discussion_id/);
  assert.match(linked.instruction,/receipt alone is not a completed answer/);
  assert.equal(discussionEvent('s',discussion,'1').instruction,legacy.instruction);
});

test('response publication guidance is gated without changing discussion identity',()=>{
  const discussion={id:'d',reviewRound:2};
  const prior=discussionEvent('s',discussion,1);
  const current=discussionEvent('s',discussion,1,1);
  assert.equal(current.event_id,prior.event_id);
  assert.doesNotMatch(prior.instruction,/response_version/);
  assert.match(current.instruction,/publish_session/);
  assert.match(current.instruction,/response_pending=false/);
  assert.equal(discussionEvent('s',discussion,1,'1').instruction,prior.instruction);
});

import {refuse} from '../skills/relaynote/scripts/lib/orca.mjs';
test('a failed discussion delivery names its reason only on a server that advertises it',async()=>{
  const event={event_kind:'discussion',round:1,discussion_id:'d',decision_id:'d'};
  const current={current_round:1,review_status:'in_review',discussions:[{id:'d',reviewRound:1}]};
  for(const [extra,expected] of [[{delivery_reason:1},'busy: terminal stayed busy'],[{delivery_protocol:3},undefined]]){
    const actions=[];
    await assert.rejects(deliverDecision({...event},{
      post:async(action,ids)=>{actions.push({action,...ids});return {status:'waiting',delivery_id:'receipt'}},
      snapshot:async()=>({...current,...extra}),
      send:async before=>{await before();throw refuse('busy','terminal stayed busy')}}),/busy/);
    const failed=actions.find(a=>a.action==='failed');
    assert.equal(failed.event_kind,'discussion');
    assert.equal(failed.reason,expected);
  }
});
