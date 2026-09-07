import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const VERSION = '1.2.1';
export const home = path.resolve(process.env.RELAYNOTE_HOME || path.join(os.homedir(), '.local/share/relaynote'));
export async function init() { await fs.mkdir(home, { recursive:true, mode:0o700 }); await fs.chmod(home,0o700); await fs.mkdir(path.join(home,'jobs'),{recursive:true,mode:0o700}); }
export async function read(file) { return JSON.parse(await fs.readFile(file,'utf8')); }
export async function write(file,data) { const temp=file+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(temp,file); }
export const jobPath = id => { if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid job id');return path.join(home,'jobs',id+'.json'); };
export async function jobs(){await init();const list=await fs.readdir(path.join(home,'jobs'));return Promise.all(list.filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).map(f=>read(path.join(home,'jobs',f))));}
export async function lock(file,fn){let handle;try{handle=await fs.open(file,'wx',0o600)}catch(e){if(e.code==='EEXIST')throw new Error('Another Relaynote operation is running');throw e}try{return await fn()}finally{await handle.close();await fs.unlink(file).catch(()=>{})}}
export function endpoint(value='https://relaynote.dencyu.co.jp'){const u=new URL(value);if(u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use a server origin, without path or credentials');if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('HTTPS is required');return u.origin;}
