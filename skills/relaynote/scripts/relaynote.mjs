#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { home,VERSION,init,read,write,jobs,jobPath,endpoint,lock } from './lib/state.mjs';
import { login,apiKeyLogin,credentials } from './lib/auth.mjs';
import { getReview,waitReview } from './lib/mcp.mjs';
import { daemon,agentCommand } from './lib/daemon.mjs';
const [command,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1]};
const flag=name=>args.includes('--'+name);
const run=(exe,args)=>{const r=spawnSync(exe,args,{encoding:'utf8'});if(r.error||r.status!==0)throw new Error(`${exe} failed: ${r.stderr?.trim()||r.error?.message||r.status}`);return r.stdout};
const suffix=process.env.RELAYNOTE_HOME?'.'+crypto.createHash('sha256').update(home).digest('hex').slice(0,8):'';
const serviceId='jp.co.dencyu.relaynote'+suffix;
const linuxUnit='relaynote'+suffix+'.service';
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function install(){await init();if((await jobs()).some(j=>['starting','running'].includes(j.status)))throw new Error('Wait for the current background run before updating the service');const source=path.dirname(fileURLToPath(import.meta.url)),dest=path.join(home,'runtime');if(source!==dest){await fs.mkdir(dest,{recursive:true,mode:0o700});await fs.cp(source,dest,{recursive:true})}const entry=path.join(dest,'relaynote.mjs');
 if(process.platform==='darwin'){
  const file=path.join(os.homedir(),'Library/LaunchAgents',serviceId+'.plist');await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${serviceId}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string><string>daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH||'/usr/bin:/bin')}</string><key>RELAYNOTE_HOME</key><string>${xml(home)}</string></dict><key>StandardOutPath</key><string>${xml(path.join(home,'daemon.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home,'daemon.log'))}</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>`,{mode:0o600});
  await fs.writeFile(path.join(home,'daemon.log'),'',{mode:0o600,flag:'a'});
  spawnSync('launchctl',['bootout',`gui/${process.getuid()}/${serviceId}`],{stdio:'ignore'});
  run('launchctl',['bootstrap',`gui/${process.getuid()}`,file]);
 }else if(process.platform==='linux'){
  const dir=path.join(os.homedir(),'.config/systemd/user');await fs.mkdir(dir,{recursive:true});
  const quote=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  await fs.writeFile(path.join(dir,linuxUnit),`[Unit]\nDescription=Relaynote review watcher\n[Service]\nExecStart=${quote(process.execPath)} ${quote(entry)} daemon\nEnvironment=${quote('RELAYNOTE_HOME='+home)}\nEnvironment=${quote('PATH='+(process.env.PATH||'/usr/bin:/bin'))}\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n`,{mode:0o600});run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','enable','--now',linuxUnit]);run('systemctl',['--user','restart',linuxUnit]);
 }else throw new Error('Automatic service installation supports macOS and Linux. Run daemon under your process supervisor on other systems.');
 console.log(JSON.stringify({installed:true,version:VERSION,cli:entry,home}));
}
async function watch(){await init();if(process.env.RELAYNOTE_BACKGROUND_JOB)throw new Error('Do not recursively register watchers from a background continuation');
 const sessionId=args[0],round=Number(option('round')),agent=option('agent'),cwd=await fs.realpath(option('cwd')||process.cwd());
 if(!/^[0-9a-f-]{36}$/i.test(sessionId)||!Number.isInteger(round)||round<1)throw new Error('Specify a session UUID and --round');
 if(!option('task-file'))throw new Error('--task-file is required: write the authorized next steps first');
 const task=await fs.readFile(option('task-file'),'utf8');if(!task.trim()||Buffer.byteLength(task)>32000)throw new Error('Task file must contain 1–32000 bytes');
 const [exe]=agentCommand(agent);run(exe,['--version']);
 const a=await credentials();const review=await getReview(sessionId);if(review.current_round!==round)throw new Error('ROUND_CHANGED');
 const status=await read(path.join(home,'daemon-status.json')).catch(()=>null);if(!status||Date.now()-Date.parse(status.heartbeat)>90000)throw new Error('Run install to start the background service first');
 const id=crypto.createHash('sha256').update(`${a.base}:${sessionId}:${round}`).digest('hex').slice(0,32);
 await lock(path.join(home,'register.lock'),async()=>{const existing=await read(jobPath(id)).catch(()=>null);if(existing){console.log(JSON.stringify({id,status:existing.status,alreadyRegistered:true}));return}if((await jobs()).filter(j=>j.status==='waiting').length>=8)throw new Error('At most 8 waiting jobs are supported; stop one before registering another');const job={id,base:a.base,sessionId,round,agent,cwd,task,follow:flag('follow'),depth:0,status:'waiting',createdAt:new Date().toISOString(),expiresAt:Date.now()+7*86400000};await write(jobPath(id),job);console.log(JSON.stringify({id,status:'waiting',agent,cwd,newBackgroundConversation:true}))});
}
try{
 switch(command){
  case 'install':await install();break;
  case 'login':{const busy=(await jobs()).some(j=>['waiting','starting','running'].includes(j.status));if(busy)throw new Error('Stop waiting jobs and let running jobs finish before changing credentials');if(flag('api-key-stdin')){let key='';for await(const chunk of process.stdin)key+=chunk;await apiKeyLogin(endpoint(option('server')),key)}else await login(endpoint(option('server')),{open:!flag('no-open')});console.log('Relaynote connected');break}
  case 'daemon':await daemon();break;
  case 'watch':await watch();break;
  case 'status':console.log(JSON.stringify({version:VERSION,service:await read(path.join(home,'daemon-status.json')).catch(()=>null),jobs:(await jobs()).map(({task,...job})=>job)},null,2));break;
  case 'stop':{const file=jobPath(args[0]);await lock(file+'.lock',async()=>{const job=await read(file);if(['running','starting'].includes(job.status))throw new Error('Agent is already running; inspect its log before stopping it manually');await write(file,{...job,status:'stopped'})});console.log('Watcher stopped');break}
  case 'resume':{const file=jobPath(args[0]);await lock(file+'.lock',async()=>{const job=await read(file);if(!['blocked','stopped','expired'].includes(job.status)||job.reviewId)throw new Error('Only a job that has never launched an AI can be resumed');const auth=await credentials();if(auth.base!==job.base)throw new Error('Log in to the original server');const review=await getReview(job.sessionId);if(review.current_round!==job.round)throw new Error('ROUND_CHANGED');await write(file,{...job,status:'waiting',error:undefined,expiresAt:Date.now()+7*86400000})});console.log('Watcher resumed');break}
  case 'wait':{const id=args[0],round=Number(option('round'));if(!Number.isInteger(round)||round<1)throw new Error('--round is required');for(;;){const result=await waitReview(id,round);if(result){console.log(JSON.stringify(result));break}}break}
  case 'uninstall':{if(process.platform==='darwin'){spawnSync('launchctl',['bootout',`gui/${process.getuid()}/${serviceId}`],{stdio:'ignore'});await fs.unlink(path.join(os.homedir(),'Library/LaunchAgents',serviceId+'.plist')).catch(()=>{})}else if(process.platform==='linux'){run('systemctl',['--user','disable','--now',linuxUnit]);await fs.unlink(path.join(os.homedir(),'.config/systemd/user/relaynote.service')).catch(()=>{});run('systemctl',['--user','daemon-reload'])}console.log('Service removed; local credentials, jobs, and logs retained');break}
  case '--version':console.log(VERSION);break;
  default:console.log('Relaynote '+VERSION+'\nCommands: install | login [--server ORIGIN] [--no-open | --api-key-stdin] | watch SESSION --round N --agent codex|claude-code --cwd DIR --task-file FILE [--follow] | status | stop JOB | resume JOB | wait SESSION --round N | uninstall');
 }
}catch(error){console.error(error.message);process.exitCode=1}
