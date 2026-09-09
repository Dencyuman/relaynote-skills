import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';

test('a 410 names why the session ended: closed by the reviewer or expired',async()=>{
 const dir=await fs.mkdtemp('/tmp/rn-events-');process.env.RELAYNOTE_HOME=dir;
 await fs.writeFile(dir+'/auth.json',JSON.stringify({base:'http://localhost:12345',apiKey:'unit-only'}));
 const originalFetch=globalThis.fetch;const answers=[{error:'SESSION_CLOSED'},{error:'SESSION_EXPIRED'}];
 globalThis.fetch=async ()=>Response.json(answers.shift(),{status:410});
 const {eventSource,SessionEndedError}=await import('../skills/relaynote/scripts/lib/events.mjs');const source=eventSource('session');
 try{
  await assert.rejects(source.snapshot(),e=>e instanceof SessionEndedError&&e.ended==='session_closed');
  await assert.rejects(source.snapshot(),e=>e instanceof SessionEndedError&&e.ended==='expired');
 }finally{source.close();globalThis.fetch=originalFetch;delete process.env.RELAYNOTE_HOME;await fs.rm(dir,{recursive:true,force:true});}
});
