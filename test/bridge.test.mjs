import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {spawn}from'node:child_process';import {fileURLToPath}from'node:url';import {deliverBridge}from'../skills/relaynote/scripts/lib/bridge.mjs';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
test('ACP bridge targets its attached session and preserves the one original process',async()=>{
 const dir=await fs.mkdtemp('/tmp/rn-bridge-'),socket=dir+'/agent.sock';
 const fake=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='session/new'?{sessionId:'origin'}:{stopReason:'end_turn'}})+'\\n')});`;
 const child=spawn(process.execPath,[cli,'bridge','--protocol','acp','--socket',socket,'--',process.execPath,'-e',fake],{env:{...process.env,RELAYNOTE_HOME:dir},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const exit=new Promise(resolve=>child.once('exit',resolve));
 const until=async fn=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('Bridge timeout '+err);await new Promise(r=>setTimeout(r,10));}};
 try{
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'session/new',params:{}})+'\n');
  await until(()=>out.includes('origin'));await until(()=>true);
  await assert.rejects(deliverBridge(socket,'other','feedback'),/rejected/);
  await deliverBridge(socket,'origin','feedback');
  assert.equal(child.exitCode,null);assert.equal((await fs.stat(socket)).mode&0o777,0o600);
 }finally{child.stdin.end();await exit;await fs.rm(dir,{recursive:true,force:true});}
});
