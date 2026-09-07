import fs from 'node:fs/promises';import{spawn}from'node:child_process';import assert from'node:assert/strict';
const base=process.env.RELAYNOTE_BASE_URL||'http://localhost:8788',qa={cookie:process.env.RELAYNOTE_TEST_COOKIE};
if(!qa.cookie||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Set RELAYNOTE_TEST_COOKIE for a local test account');
const api=async(path,body,method='POST')=>{const r=await fetch(base+path,{method,headers:{Cookie:qa.cookie,Origin:base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,'HTTP '+r.status);return r.status===204?null:r.json()};
const key=(await api('/api/account/api-keys',{name:'CLI watcher integration'})).apiKey;
const root=await fs.mkdtemp('/tmp/relaynote-watcher-'),home=root+'/home',bin=root+'/bin';await fs.mkdir(bin);const cli=new URL('../skills/relaynote/scripts/relaynote.mjs',import.meta.url).pathname;
if(!process.env.RELAYNOTE_REAL_AGENT)await fs.writeFile(bin+'/codex',`#!${process.execPath}\nimport fs from 'node:fs';if(process.argv.includes('--version')){console.log('codex-test');process.exit()}let s='';for await(const c of process.stdin)s+=c;fs.appendFileSync(process.env.RELAYNOTE_HOME+'/launches.jsonl',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:s})+'\\n');`,{mode:0o700});
const env={...process.env,RELAYNOTE_HOME:home,PATH:bin+':'+process.env.PATH};
if(process.env.RELAYNOTE_REAL_AGENT)await new Promise(r=>spawn('git',['init',root],{stdio:'ignore'}).on('exit',r));
const run=(args,input='')=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cli,...args],{env,cwd:root,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);p.on('exit',code=>code?reject(new Error(err)):resolve(out))});
let daemon;
try{
 await run(['login','--server',base,'--api-key-stdin'],key.token);daemon=spawn(process.execPath,[cli,'daemon'],{env,stdio:'ignore'});
 for(let i=0;i<100;i++){try{await fs.access(home+'/daemon-status.json');break}catch{}await new Promise(r=>setTimeout(r,50))}
 const session=(await api('/api/sessions',{title:'Background watcher integration',markdown:'Local test'})).session;
 await fs.writeFile(root+'/task.md','Reply with RELAYNOTE_BACKGROUND_OK only. Do not use tools, read files, or make changes. This is a launch verification, so no review updates or follow-up work are required.');
 const args=['watch',session.id,'--round','1','--agent','codex','--cwd',root,'--task-file',root+'/task.md'];
 const registered=JSON.parse(await run(args));assert.equal(registered.status,'waiting');const duplicate=JSON.parse(await run(args));assert.equal(duplicate.alreadyRegistered,true);
 await api('/api/sessions/'+session.id+'/review',{decision:'changes_requested',note:'Use the same review session'});
 let job;for(let i=0;i<1800;i++){job=JSON.parse(await fs.readFile(home+'/jobs/'+registered.id+'.json','utf8'));if(['completed','failed','blocked'].includes(job.status))break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(job.status,'completed',JSON.stringify(job));let launches=[];if(process.env.RELAYNOTE_REAL_AGENT){const log=await fs.readFile(home+'/jobs/'+registered.id+'.log','utf8');assert(log.includes('RELAYNOTE_BACKGROUND_OK'));}else{const launches=(await fs.readFile(home+'/launches.jsonl','utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,1);assert.deepEqual(launches[0].args,['exec','--json','-']);assert.equal(launches[0].cwd,await fs.realpath(root));assert(launches[0].prompt.includes('changes_requested'));assert(!launches[0].prompt.includes(key.token));}assert.equal((await fs.stat(home+'/auth.json')).mode&0o777,0o600);
 console.log(JSON.stringify({realMcp:true,decision:job.decision,jobStatus:job.status,realAgent:Boolean(process.env.RELAYNOTE_REAL_AGENT),launchCount:process.env.RELAYNOTE_REAL_AGENT?1:launches.length,duplicateSuppressed:true,credentialsPrivate:true}));
}finally{daemon?.kill('SIGTERM');await api('/api/account/api-keys/'+key.id,null,'DELETE');}
