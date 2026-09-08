import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createHash} from 'node:crypto';import {spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
const sessionId='11111111-1111-4111-8111-111111111111';
const run=(dir,args,input='')=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,...args],{env:{...process.env,RELAYNOTE_HOME:dir},stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>p.kill('SIGTERM'),5000);p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);p.on('exit',code=>{clearTimeout(timer);resolve({code,out,err})})});
const frame=value=>{const data=Buffer.from(JSON.stringify(value));return Buffer.concat([Buffer.from([0x81,data.length]),data]);};

test('CLI receives a WebSocket notification without polling or starting an agent',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));let changed=false,snapshots=0,mcp=0;const sockets=new Set();
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer test-key');res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/events-ticket'))return res.end(JSON.stringify({ticket:'test-ticket'}));
  if(req.url.endsWith('/snapshot')){snapshots++;return res.end(JSON.stringify({session_id:sessionId,current_round:1,latest_review:null,open_comments:changed?[{id:'c1',body:'please fix'}]:[],updated_at:changed?'t1':'t0'}));}
  mcp++;res.writeHead(404);res.end('{}');
 });
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('data',data=>{if((data[0]&15)===8)socket.end(Buffer.from([0x88,0]));});const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`);
  socket.write(frame({type:'ready'}));
  setTimeout(()=>{changed=true;socket.write(frame({type:'changed'}));},200);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  assert.equal((await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key')).code,0);
  const result=await run(dir,['watch',sessionId,'--consumer','unit-origin','--events','feedback']);
  assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).feedback.comments[0].body,'please fix');assert.equal(mcp,0);assert.equal(snapshots,3);
 }finally{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('a legacy server is rejected, never downgraded to polling',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));let requests=0;
 const server=http.createServer((req,res)=>{requests++;res.writeHead(404);res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key');
  const result=await run(dir,['watch',sessionId,'--consumer','unit-origin']);
  assert.equal(result.code,1);assert.match(result.err,/does not support WebSocket Hibernation/);assert.equal(requests,1);
 }finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
