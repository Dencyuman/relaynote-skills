import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
test('lightweight CLI crosses pending polls and outputs comment changes without an AI process',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));let calls=0;const sessionId='11111111-1111-4111-8111-111111111111';
 const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer test-key');let body='';for await(const b of req)body+=b;const rpc=JSON.parse(body);calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:{session_id:sessionId,current_round:1,latest_review:null,open_comments:calls<2?[]:[{id:'c1',body:'please fix'}]}}}))});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const run=(args,input='')=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,...args],{env:{...process.env,RELAYNOTE_HOME:dir},stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);p.on('exit',code=>resolve({code,out,err}))});
 try{assert.equal((await run(['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key')).code,0);
 const result=await run(['watch',sessionId,'--consumer','unit-origin','--events','feedback']);assert.equal(result.code,0,result.err);const event=JSON.parse(result.out);assert.equal(event.feedback.comments[0].body,'please fix');assert(calls>=2);assert.equal((await fs.stat(path.join(dir,'auth.json'))).mode&0o777,0o600);
 }finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
});
