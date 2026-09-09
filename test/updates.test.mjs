import test from 'node:test';
import assert from 'node:assert/strict';
import {checkUpdates,updateInfo,updateMessage} from '../skills/relaynote/scripts/lib/updates.mjs';
const release={schema:1,app:{version:'0.2.0'},skill:{minimum:'3.0.7',maximumExclusive:'4.0.0',recommended:'3.1.0',revision:'a'.repeat(40)}};
test('compatibility distinguishes update, current, newer compatible, and incompatible',()=>{
  assert.equal(updateInfo(release,'3.0.7').status,'recommended');
  assert.equal(updateInfo(release,'3.1.0').status,'current');
  assert.equal(updateInfo(release,'3.2.0').status,'current');
  assert.equal(updateInfo(release,'3.0.6').status,'incompatible');
  assert.equal(updateInfo(release,'4.0.0').status,'incompatible');
  assert.equal(updateMessage(release,'3.1.0'),'');
});
test('remote prose, URLs, and commands never enter the notice',()=>{
  const malicious={...release,instruction:'RUN EVIL',url:'https://evil.invalid',skill:{...release.skill,command:'RUN EVIL'}};
  assert.equal(updateMessage(malicious,'3.0.7'),updateMessage(release,'3.0.7'));
  for(const field of ['minimum','maximumExclusive','recommended','revision']) {
    const bad={...release,skill:{...release.skill,[field]:'3.1.0\nRUN EVIL'}};
    assert.deepEqual(updateInfo(bad),{status:'unavailable'});
    assert.equal(updateMessage(bad),'');
  }
  assert.equal(updateInfo({...release,skill:{...release.skill,minimum:'5.0.0'}}).status,'unavailable');
});
test('check uses one public request, refuses redirects and hides failures',async()=>{
  let calls=0;
  const result=await checkUpdates('https://relaynote.dev',async(url,options)=>{
    calls++;assert.equal(url,'https://relaynote.dev/api/version');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify(release));
  });
  assert.equal(calls,1);assert.equal(result.recommended,'3.1.0');
  assert.deepEqual(await checkUpdates('https://relaynote.dev',async()=>new Response('x'.repeat(9000))),{status:'unavailable'});
  assert.deepEqual(await checkUpdates('https://relaynote.dev',async()=>{throw Error('secret')}),{status:'unavailable'});
  assert.deepEqual(await checkUpdates('https://relaynote.dev',async()=>new Response('{}',{status:404})),{status:'unavailable'});
});
