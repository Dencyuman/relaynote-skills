import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../skills/relaynote/scripts/relaynote-feedback.mjs',import.meta.url));
const sessionId='11111111-1111-4111-8111-111111111111';
// A minimal environment: the host detection must see only what a test sets, never this runner's own host.
const run=(dir,args,{env={},input=''}={})=>new Promise(resolve=>{
 const p=spawn(process.execPath,[cli,...args],{env:{PATH:process.env.PATH,HOME:os.homedir(),...env,RELAYNOTE_HOME:dir??path.join(os.tmpdir(),'relaynote-unset-home')},stdio:['pipe','pipe','pipe']});
 let out='',err='';const timer=setTimeout(()=>p.kill('SIGTERM'),10000);
 p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);
 p.on('exit',code=>{clearTimeout(timer);resolve({code,out,err})});
});
const temp=async name=>fs.mkdtemp(path.join(os.tmpdir(),'relaynote-'+name+'-'));
const DEAD=4194304; // above every pid_max: process.kill(pid,0) always reports it gone
const id=n=>String(n).repeat(24).slice(0,24);
const record=async(dir,state)=>{await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'watch-'+state.id+'.json'),JSON.stringify(state))};
const auth=async(dir,data)=>{await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'auth.json'),JSON.stringify(data))};
const live=extra=>({id:id(1),sessionId,delivery:'stdout',pid:process.pid,status:'waiting',mode:'websocket',startedAt:new Date().toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),...extra});
const A='http://127.0.0.1:9',B='http://127.0.0.1:10';

test('re-login to the connected server is a no-op that leaves live watchers alone',async()=>{
 const dir=await temp('login-same');
 try{
  await auth(dir,{base:A,clientId:'c',refreshToken:'r',accessToken:'a',expiresAt:Date.now()+3600000,scope:'relaynote:events offline_access'});
  await record(dir,live());
  const stored=await fs.readFile(path.join(dir,'auth.json'),'utf8');
  const result=await run(dir,['login','--server',A]);
  assert.equal(result.code,0,result.err);
  assert.match(result.out,/^Already connected to http:\/\/127\.0\.0\.1:9 \(scope: relaynote:events offline_access\); 1 live watcher\(s\) keep working and pick up rotated tokens automatically\. Pass --force to reauthorize\.$/m);
  assert.equal(await fs.readFile(path.join(dir,'auth.json'),'utf8'),stored);
  // --force must skip the shortcut and really try to reauthorize (which fails: nothing listens on :9).
  const forced=await run(dir,['login','--server',A,'--force','--no-open']);
  assert.equal(forced.code,1);assert.doesNotMatch(forced.out,/Already connected/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('a live watcher blocks a different server and an API key that would drop its refresh token',async()=>{
 const dir=await temp('login-switch');
 try{
  await auth(dir,{base:A,clientId:'c',refreshToken:'r',accessToken:'a',expiresAt:Date.now()+3600000,scope:'relaynote:events'});
  await record(dir,live());
  await record(dir,{...live({id:id(2)}),pid:DEAD});
  const switched=await run(dir,['login','--server',B]);
  assert.equal(switched.code,1);
  assert.match(switched.err,/1 watcher\(s\) are bound to http:\/\/127\.0\.0\.1:9; stop them before switching to http:\/\/127\.0\.0\.1:10/);
  const key=await run(dir,['login','--server',A,'--api-key-stdin'],{input:'secret'});
  assert.equal(key.code,1);assert.match(key.err,/API key drops the refresh token 1 live watcher\(s\) rely on; stop them first or pass --force/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'auth.json'),'utf8')).refreshToken,'r');
  // The guard reads state; it never prunes or rewrites the dead record it saw.
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'watch-'+id(2)+'.json'),'utf8')).status,'waiting');
  // Without a live watcher an API key switch is allowed.
  await fs.unlink(path.join(dir,'watch-'+id(1)+'.json'));
  const allowed=await run(dir,['login','--server',A,'--api-key-stdin'],{input:'secret'});
  assert.equal(allowed.code,0,allowed.err);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'auth.json'),'utf8')).apiKey,'secret');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('--help answers for one subcommand without touching state or starting login',async()=>{
 const dir=path.join(await temp('help'),'never-created');
 const help=await run(dir,['login','--help']);
 assert.equal(help.code,0,help.err);
 assert.match(help.out,/^login \[--server ORIGIN\]/);assert.match(help.out,/--force/);
 assert.doesNotMatch(help.out,/Relaynote connected|Already connected/);
 await assert.rejects(fs.stat(dir),{code:'ENOENT'});
 for(const command of ['watch','start','upload','status','stop','agents','describe','bind','hook','adapter-template','bridge']){
  const result=await run(dir,[command,'-h']);
  assert.equal(result.code,0,command+': '+result.err);
  assert.match(result.out,new RegExp('^'+command+'\\b'));
  await assert.rejects(fs.stat(dir),{code:'ENOENT'});
 }
 const unknown=await run(dir,['frobnicate']);
 assert.equal(unknown.code,1);assert.match(unknown.err,/Unknown command: frobnicate/);assert.match(unknown.err,/Relaynote feedback bridge \d+\.\d+\.\d+/);
 const banner=await run(dir,[]);
 assert.equal(banner.code,0);assert.match(banner.out,/Relaynote feedback bridge \d+\.\d+\.\d+/);
});

test('describe detects the host from the environment and lists valid ids',async()=>{
 const dir=await temp('describe');
 try{
  const cases=[
   [{CLAUDECODE:'1'},'claude-code','CLAUDECODE'],
   [{CLAUDE_CODE_SESSION_ID:'s'},'claude-code','CLAUDE_CODE_SESSION_ID'],
   [{CLAUDECODE:'1',CODEX_THREAD_ID:'t'},'claude-code','CLAUDECODE'],
   [{CODEX_THREAD_ID:'t',ORCA_TERMINAL_HANDLE:'term_1'},'orca','ORCA_TERMINAL_HANDLE'],
   [{CODEX_THREAD_ID:'t'},'codex','CODEX_THREAD_ID'],
   [{ORCA_TERMINAL_HANDLE:'term_1'},null,'no host environment variable set'],
   [{CURSOR_AGENT:'1'},'cursor-cli','CURSOR_AGENT'],
   [{CURSOR_TRACE_ID:'x'},'cursor-cli','CURSOR_TRACE_ID'],
   [{},null,'no host environment variable set'],
  ];
  for(const [env,detected,reason] of cases){
   const result=await run(dir,['describe'],{env});
   assert.equal(result.code,0,result.err);
   const data=JSON.parse(result.out);
   assert.equal(data.detected,detected,JSON.stringify(env));
   assert.match(data.reason,new RegExp(reason));
   assert.equal(data.adapter?.id??null,detected);
   assert(data.hosts.includes('claude-code')&&data.hosts.includes('codex')&&data.hosts.includes('orca')&&data.hosts.includes('cursor-cli'));
  }
  const known=await run(dir,['describe','codex'],{env:{}});
  assert.equal(known.code,0);assert.equal(JSON.parse(known.out).id,'codex');
  const unknown=await run(dir,['describe','nope'],{env:{}});
  assert.equal(unknown.code,1);assert.match(unknown.err,/^Unknown host "nope"\. Valid: codex, claude-code, cursor-cli/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('status prunes on endedAt, keeps live watchers first and never prunes during login',async()=>{
 const dir=await temp('status');
 const week=8*24*3600*1000,old=new Date(Date.now()-week).toISOString(),now=new Date().toISOString();
 try{
  await auth(dir,{base:A,apiKey:'k'});
  await record(dir,live());                                                                    // live
  await record(dir,{...live({id:id(2)}),pid:DEAD});                                            // waiting, process gone
  await record(dir,{...live({id:id(3)}),status:'completed',endedAt:old,lastEventAt:now});      // endedAt decides: pruned
  await record(dir,{...live({id:id(4)}),status:'completed',endedAt:now,lastEventAt:old});      // endedAt decides: kept
  await record(dir,{...live({id:id(5)}),status:'expired',startedAt:old,endedAt:undefined});    // falls back to startedAt: pruned
  await record(dir,{id:id(6),sessionId,delivery:'stdout',status:'failed'});                    // no timestamp at all: pruned now
  await fs.writeFile(path.join(dir,'seen-'+id(3)+'.json'),'{}');
  const kept=await run(dir,['login','--server',A]);
  assert.equal(kept.code,0,kept.err);
  assert.equal((await fs.readdir(dir)).filter(n=>n.startsWith('watch-')).length,6,'login must not prune');
  const table=await run(dir,['status']);
  assert.equal(table.code,0,table.err);
  const lines=table.out.trim().split('\n');
  assert.match(lines[0],/^ID\s+STATUS\s+MODE\s+DELIVERY\s+SESSION\s+STARTED\s+ENDS$/);
  assert.equal(lines.length,2);assert.match(lines[1],new RegExp('^'+id(1)+'\\s+waiting\\s+websocket\\s+stdout\\s+'+sessionId));
  const files=(await fs.readdir(dir)).filter(n=>n.startsWith('watch-')).sort();
  assert.deepEqual(files,['watch-'+id(1)+'.json','watch-'+id(2)+'.json','watch-'+id(4)+'.json']);
  await assert.rejects(fs.stat(path.join(dir,'seen-'+id(3)+'.json')),{code:'ENOENT'});
  const gone=JSON.parse(await fs.readFile(path.join(dir,'watch-'+id(2)+'.json'),'utf8'));
  assert.equal(gone.status,'stopped');assert(Number.isFinite(Date.parse(gone.endedAt)));
  const all=await run(dir,['status','--all']);
  assert.equal(all.out.trim().split('\n').length,4);
  assert.match(all.out,new RegExp(id(4)+'\\s+completed'));
  const json=await run(dir,['status','--json']);
  const data=JSON.parse(json.out);
  assert.equal(data.length,3);assert.deepEqual(data.map(s=>s.status).sort(),['completed','stopped','waiting']);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('watch normalizes the legacy --events value, refuses any other, and needs an absolute adapter file',async()=>{
 const dir=await temp('watch-args');
 try{
  await auth(dir,{base:A,apiKey:'k'});
  const events=await run(dir,['watch',sessionId,'--consumer','c','--events','comments']);
  assert.equal(events.code,1);assert.match(events.err,/--events accepts only "decisions"/);
  // The documented legacy value stays accepted: it is announced, normalized, and the watcher runs on.
  const legacy=await run(dir,['watch',sessionId,'--consumer','c','--events','feedback']);
  assert.match(legacy.err,/^--events feedback is deprecated; using decisions$/m);
  assert.doesNotMatch(legacy.err,/--events accepts only/);
  const [state]=await Promise.all((await fs.readdir(dir)).filter(n=>n.startsWith('watch-')).map(async n=>JSON.parse(await fs.readFile(path.join(dir,n),'utf8'))));
  assert.equal(state.events,'decisions');assert.equal(state.status,'failed');
  const relative=await run(dir,['watch',sessionId,'--delivery','http','--thread','t','--adapter-file','adapter.json']);
  assert.equal(relative.code,1);assert.match(relative.err,/--delivery http requires --adapter-file with an absolute path/);
  const missing=await run(dir,['watch',sessionId,'--delivery','http','--thread','t']);
  assert.equal(missing.code,1);assert.match(missing.err,/--adapter-file/);
  const unreadable=await run(dir,['watch',sessionId,'--delivery','http','--thread','t','--adapter-file',path.join(dir,'nope.json')]);
  assert.equal(unreadable.code,1);assert.match(unreadable.err,/Cannot read --adapter-file .*nope\.json: ENOENT/);
  await fs.writeFile(path.join(dir,'bad.json'),'{oops');
  const invalid=await run(dir,['watch',sessionId,'--delivery','http','--thread','t','--adapter-file',path.join(dir,'bad.json')]);
  assert.equal(invalid.code,1);assert.match(invalid.err,/is not valid JSON/);
  // RELAYNOTE_DEBUG turns the same failure into a stack for a bug report.
  const debug=await run(dir,['watch',sessionId,'--consumer','c','--events','comments'],{env:{RELAYNOTE_DEBUG:'1'}});
  assert.equal(debug.code,1);assert.match(debug.err,/relaynote-feedback\.mjs:\d+/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
