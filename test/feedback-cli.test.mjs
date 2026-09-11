import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createHash} from 'node:crypto';import {spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
const sessionId='11111111-1111-4111-8111-111111111111';
const run=(dir,args,input='')=>new Promise(resolve=>{const p=spawn(process.execPath,[cli,...args],{env:{...process.env,RELAYNOTE_HOME:dir},stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>p.kill('SIGTERM'),5000);p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);p.on('exit',code=>{clearTimeout(timer);resolve({code,out,err})})});
const frame=value=>{const data=Buffer.from(JSON.stringify(value));return Buffer.concat([Buffer.from([0x81,data.length]),data]);};

test('CLI receives a WebSocket notification without polling or starting an agent',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-test-'));let changed=false,decided=false,snapshots=0,mcp=0;const sockets=new Set();
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer test-key');res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/events-ticket'))return res.end(JSON.stringify({ticket:'test-ticket'}));
  if(req.url.endsWith('/snapshot')){snapshots++;return res.end(JSON.stringify({session_id:sessionId,current_round:1,delivery_protocol:3,latest_review:decided?{id:'22222222-2222-4222-8222-222222222222',round:1,decision:'approved'}:null,open_comments:changed?[{id:'c1',body:'please fix'}]:[],updated_at:changed?'t1':'t0'}));}
  if(req.url.endsWith('/delivery')){let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);res.end(JSON.stringify(data.action==='claim'?{status:'waiting',delivery_id:'33333333-3333-4333-8333-333333333333'}:{ok:true}))});return;}
  mcp++;res.writeHead(404);res.end('{}');
 });
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('data',data=>{if((data[0]&15)===8)socket.end(Buffer.from([0x88,0]));});const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`);
  socket.write(frame({type:'ready'}));
  setTimeout(()=>{changed=true;socket.write(frame({type:'changed'}));},150);
  setTimeout(()=>{decided=true;socket.write(frame({type:'changed'}));},400);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  assert.equal((await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key')).code,0);
  const result=await run(dir,['watch',sessionId,'--consumer','unit-origin','--events','decisions']);
  assert.equal(result.code,0,result.err);
  const lines=result.out.trim().split('\n').map(line=>JSON.parse(line));
  const started=lines[0],event=lines.find(line=>line.type==='relaynote.feedback');
  assert.equal(started.type,'relaynote.watch.started');assert.equal(started.consumer,'unit-origin');assert.equal(started.binding,'bound');assert.equal(started.session_id,sessionId);assert.equal(started.delivery,'stdout');assert.match(started.watcher_id,/^[a-f0-9]{24}$/);
  assert.equal(event.feedback.comments[0].body,'please fix');assert.equal(mcp,0);assert.equal(event.decision_id,'22222222-2222-4222-8222-222222222222');assert(snapshots>=5 && snapshots<=6);
  const [state]=await Promise.all((await fs.readdir(dir)).filter(n=>n.startsWith('watch-')).map(async n=>JSON.parse(await fs.readFile(path.join(dir,n),'utf8'))));
  assert.equal(state.status,'completed');assert(Number.isFinite(Date.parse(state.endedAt)));assert.equal(state.lastEventId,event.event_id);
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

test('watch refuses a lifetime outside 1-720 hours',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-feedback-hours-'));
 await fs.writeFile(path.join(dir,'auth.json'),JSON.stringify({base:'http://127.0.0.1:9',apiKey:'k'}));
 const r=await run(dir,['watch',sessionId,'--consumer','c','--max-hours','0']);
 assert.equal(r.code,1);assert.match(r.err,/--max-hours/);
});

test('discussion mode negotiates capability and delivers an explicit send, not an autosave',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-discussion-cli-'));
 const discussionId='44444444-4444-4444-8444-444444444444';
 const deliveryId='55555555-5555-4555-8555-555555555555';
 const sockets=new Set(),actions=[];let submitted=false,snapshots=0,capability=1;
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/snapshot')){snapshots++;return res.end(JSON.stringify({session_id:sessionId,current_round:1,delivery_protocol:3,discussion_protocol:capability,review_status:'in_review',latest_review:null,open_comments:[{id:'draft',body:'saved'}],discussions:submitted?[{id:discussionId,reviewRound:1,sequence:1}]:[],updated_at:submitted?'sent':'draft'}));}
  if(req.url.endsWith('/events-ticket'))return res.end(JSON.stringify({ticket:'t'}));
  if(req.url.endsWith('/delivery')){let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);actions.push(data);res.end(JSON.stringify(data.action==='claim'?{status:'waiting',delivery_id:deliveryId}:{ok:true}));});return;}
  res.writeHead(404);res.end('{}');
 });
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('data',data=>{if((data[0]&15)===8)socket.end(Buffer.from([0x88,0]));});
  const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`);
  socket.write(frame({type:'ready'}));
  setTimeout(()=>socket.write(frame({type:'changed'})),100);
  setTimeout(()=>{submitted=true;socket.write(frame({type:'changed'}));},250);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key');
  const result=await run(dir,['watch',sessionId,'--consumer','origin','--events','discussions']);
  assert.equal(result.code,0,result.err);
  const events=result.out.trim().split('\n').map(s=>JSON.parse(s)).filter(e=>e.type==='relaynote.feedback');
  assert.equal(events.length,1);assert.equal(events[0].discussion_id,discussionId);assert.equal(events[0].delivery_id,deliveryId);
  assert.match(events[0].instruction,/acknowledge_discussion/);
  assert.equal(actions[0].discussions,true);
  assert.deepEqual(actions.map(a=>a.action),['bind','claim','sending','sent','disconnect']);
  // delivery_protocol 3 does not advertise reasons: a `reason` field would 400 on its strict schema.
  assert.ok(actions.every(a=>a.reason===undefined));
  assert.ok(actions.filter(a=>a.decision_id).every(a=>a.event_kind==='discussion'));
  assert.ok(snapshots>=5&&snapshots<=6);
  capability=0;actions.length=0;
  const rejected=await run(dir,['watch',sessionId,'--consumer','unsupported','--events','discussions']);
  assert.equal(rejected.code,1);assert.match(rejected.err,/discussion_protocol 1/);assert.equal(actions.length,0);
 }finally{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('discussions are the default, negotiated per server, and --events decisions opts out',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-default-events-'));
 const decisionId='66666666-6666-4666-8666-666666666666';
 const deliveryId='77777777-7777-4777-8777-777777777777';
 const sockets=new Set();let actions=[],capability=1,decided=false;
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/events-ticket'))return res.end(JSON.stringify({ticket:'t'}));
  if(req.url.endsWith('/snapshot'))return res.end(JSON.stringify({session_id:sessionId,current_round:1,delivery_protocol:3,discussion_protocol:capability,review_status:decided?'approved':'in_review',latest_review:decided?{id:decisionId,round:1,decision:'approved'}:null,open_comments:[],discussions:[],updated_at:decided?'t1':'t0'}));
  if(req.url.endsWith('/delivery')){let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);actions.push(data);res.end(JSON.stringify(data.action==='claim'?{status:'waiting',delivery_id:deliveryId}:{ok:true}))});return;}
  res.writeHead(404);res.end('{}');
 });
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('data',data=>{if((data[0]&15)===8)socket.end(Buffer.from([0x88,0]));});
  const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: relaynote\r\n\r\n`);
  socket.write(frame({type:'ready'}));
  setTimeout(()=>{decided=true;socket.write(frame({type:'changed'}));},150);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const started=result=>result.out.trim().split('\n').map(line=>JSON.parse(line)).find(line=>line.type==='relaynote.watch.started');
 try{
  await run(dir,['login','--server',`http://127.0.0.1:${server.address().port}`,'--api-key-stdin'],'test-key');
  // A capable server needs no flag: comments reach the conversation out of the box.
  const auto=await run(dir,['watch',sessionId,'--consumer','auto']);
  assert.equal(auto.code,0,auto.err);
  assert.equal(actions[0].action,'bind');assert.equal(actions[0].discussions,true);
  assert.equal(started(auto).events,'discussions');
  // The same default degrades instead of failing when the server cannot deliver discussions.
  capability=0;decided=false;actions=[];
  const legacy=await run(dir,['watch',sessionId,'--consumer','legacy']);
  assert.equal(legacy.code,0,legacy.err);
  assert.equal(actions[0].discussions,false);
  assert.equal(started(legacy).events,'decisions');
  // Opting out stays available on a capable server.
  capability=1;decided=false;actions=[];
  const only=await run(dir,['watch',sessionId,'--consumer','only','--events','decisions']);
  assert.equal(only.code,0,only.err);
  assert.equal(actions[0].discussions,false);
  assert.equal(started(only).events,'decisions');
 }finally{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
