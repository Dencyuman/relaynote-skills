import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
const sessionId='11111111-1111-4111-8111-111111111111';
const run=(dir,args,input='')=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,...args],{env:{...process.env,RELAYNOTE_HOME:dir},stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);p.on('exit',code=>resolve({code,out,err}))});
const serve=handler=>new Promise(async resolve=>{const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer test-key');let body='';for await(const b of req)body+=b;const rpc=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:handler(rpc.params.name,rpc.params.arguments)}}))});await new Promise(r=>server.listen(0,'127.0.0.1',r));resolve(server)});
const statusFile=async dir=>{const name=(await fs.readdir(dir)).find(n=>/^watch-[a-f0-9]{24}\.json$/.test(n));return JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))};

test('lightweight CLI crosses pending polls and outputs comment changes without an AI process',async()=>{
 // Server without updated_at: the watcher must degrade to legacy polling and still deliver.
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));let calls=0;
 const server=await serve(()=>{calls++;return{session_id:sessionId,current_round:1,latest_review:null,open_comments:calls<2?[]:[{id:'c1',body:'please fix'}]}});
 try{assert.equal((await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key')).code,0);
 const result=await run(dir,['watch',sessionId,'--consumer','unit-origin','--events','feedback']);assert.equal(result.code,0,result.err);const event=JSON.parse(result.out);assert.equal(event.feedback.comments[0].body,'please fix');assert(calls>=2);assert.equal((await fs.stat(path.join(dir,'auth.json'))).mode&0o777,0o600);
 assert.equal((await statusFile(dir)).mode,'poll');
 }finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
});

test('CLI holds one long-poll request and reports long-poll mode',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));const waits=[];
 const server=await serve((name,args)=>{
  if(name==='get_session_review')return{session_id:sessionId,current_round:1,latest_review:null,open_comments:[],updated_at:'2026-09-09T00:00:00.000Z'};
  waits.push(args);
  return{session_id:sessionId,current_round:1,latest_review:null,open_comments:[{id:'c1',body:'please fix'}],updated_at:'2026-09-09T00:05:00.000Z'};
 });
 try{assert.equal((await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key')).code,0);
 const result=await run(dir,['watch',sessionId,'--consumer','unit-origin','--events','feedback']);
 assert.equal(result.code,0,result.err);
 assert.equal(JSON.parse(result.out).feedback.comments[0].body,'please fix');
 assert.equal(waits.length,1,'exactly one held request, not a poll loop');
 assert.deepEqual(waits[0],{session_id:sessionId,timeout_seconds:300,wait_for:'any_change',since:'2026-09-09T00:00:00.000Z'});
 assert.equal((await statusFile(dir)).mode,'long-poll');
 }finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
});
