// Manual integration test: invokes the signed-in Codex model in an isolated app-server.
import {spawn}from'node:child_process';import fs from'node:fs/promises';import assert from'node:assert/strict';
const server=spawn('codex',['app-server','--listen','ws://127.0.0.1:45219'],{stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',b=>stderr+=b);
const messages=[],pending=new Map();let ws,id=0;
const wait=async pred=>{const until=Date.now()+120000;while(Date.now()<until){const m=messages.find(pred);if(m)return m;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out')};
try{for(let i=0;i<50;i++){try{ws=await new Promise((resolve,reject)=>{const w=new WebSocket('ws://127.0.0.1:45219');w.onopen=()=>resolve(w);w.onerror=reject});break}catch{await new Promise(r=>setTimeout(r,200))}}assert(ws);
ws.onmessage=e=>{const m=JSON.parse(e.data);messages.push(m);if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
await rpc('initialize',{clientInfo:{name:'relaynote_wake_probe',version:'0.0.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized'}));
const started=await rpc('thread/start',{cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only'});const threadId=started.thread.id;
await rpc('turn/start',{threadId,input:[{type:'text',text:'Remember ORIGIN_CODEX_819 in this conversation. Reply ARMED_CODEX only, then end your turn. Do not call tools.'}]});
await wait(m=>m.method==='turn/completed'&&m.params.threadId===threadId);console.log('Original Codex turn completed; now delivering to same thread');const count=messages.length;
const delivered=await new Promise(resolve=>{const p=spawn('codex',['queue','--remote','ws://127.0.0.1:45219','--thread',threadId,'--message','Relaynote test event. Reply with the remembered phrase followed by _RESUMED. Do not call tools.'],{stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('exit',code=>resolve({code,output}))});assert.equal(delivered.code,0,delivered.output);
await wait(m=>messages.indexOf(m)>=count&&m.method==='turn/completed'&&m.params.threadId===threadId);
const text=messages.filter((m,i)=>i>=count&&m.method==='item/completed').map(m=>m.params.item?.text??'').join('\n');assert(text.includes('ORIGIN_CODEX_819_RESUMED'),text);await fs.writeFile(new URL('./evidence/codex-latest.json',import.meta.url),JSON.stringify({version:'0.153.4',sameThread:true,afterTurnCompleted:true,threadId,reply:text},null,2));console.log(JSON.stringify({sameThread:true,afterTurnCompleted:true,reply:text}));
}finally{ws?.close();server.kill('SIGTERM')}
