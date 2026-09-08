import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';

test('idle wait deadlines never fetch data; only ready or changed events do',async()=>{
 const dir=await fs.mkdtemp('/tmp/rn-events-');process.env.RELAYNOTE_HOME=dir;
 await fs.writeFile(dir+'/auth.json',JSON.stringify({base:'http://localhost:12345',apiKey:'unit-only'}));
 const originalFetch=globalThis.fetch,originalSocket=globalThis.WebSocket;let reads=0,ws;
 globalThis.fetch=async url=>{if(String(url).endsWith('/snapshot')){reads++;return Response.json({updated_at:'t'+reads,current_round:1})}return Response.json({ticket:'test'})};
 globalThis.WebSocket=class{static OPEN=1;readyState=1;constructor(){ws=this;queueMicrotask(()=>this.onmessage({data:'{"type":"ready"}'}));}send(){}close(){this.onclose?.({code:1000})}};
 const {eventSource}=await import('../skills/relaynote/scripts/lib/events.mjs');const source=eventSource('session');
 try{
  await source.ready();await source.wait('session','t0',0.001);assert.equal(reads,1);
  for(let i=0;i<5;i++)assert.equal((await source.wait('session','t1',0.001)).pending,true);
  assert.equal(reads,1,'timeouts must not perform a snapshot request');
  ws.onmessage({data:'{"type":"changed"}'});await source.wait('session','t1',0.001);assert.equal(reads,2);
 }finally{source.close();globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket;delete process.env.RELAYNOTE_HOME;await fs.rm(dir,{recursive:true,force:true});}
});
