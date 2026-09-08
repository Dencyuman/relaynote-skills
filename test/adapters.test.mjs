import test from 'node:test';
import assert from 'node:assert/strict';
import {hookResponse,conversationFromHook,renderAdapter,adapterTemplate} from '../skills/relaynote/scripts/lib/adapters.mjs';
const event={event_id:'one',session_id:'review',round:1,instruction:'Read feedback.'};
test('each hook receives its native continuation format',()=>{
 assert.match(hookResponse('cursor',event).followup_message,/Read feedback/);
 assert.equal(hookResponse('gemini-cli',event).decision,'deny');
 assert.equal(hookResponse('goose',event).decision,'block');
 assert.throws(()=>hookResponse('unknown',event));
});
test('hooks require the actual conversation identifier',()=>{
 assert.equal(conversationFromHook({conversation_id:'origin'}),'origin');
 assert.throws(()=>conversationFromHook({}));
});
test('HTTP adapters preserve message text and encode path IDs, reject another origin',()=>{
 const config=adapterTemplate('opencode','origin/one','http://localhost:1234');
 const rendered=renderAdapter(config,'origin/one',event);
 assert.equal(rendered.url.pathname,'/session/origin%2Fone/prompt_async');
 assert.equal(JSON.parse(rendered.options.body).parts[0].type,'text');
 assert.throws(()=>renderAdapter(config,'different',event));
 assert.throws(()=>renderAdapter({...config,url:'http://remote.example/{{thread}}'},'origin/one',event));
});
