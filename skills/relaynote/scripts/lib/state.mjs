import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const VERSION = '3.0.1';
export const home = path.resolve(process.env.RELAYNOTE_HOME || path.join(os.homedir(), '.local/share/relaynote-feedback'));
export async function init() { await fs.mkdir(home, {recursive:true, mode:0o700}); await fs.chmod(home,0o700); }
export async function read(file) { return JSON.parse(await fs.readFile(file,'utf8')); }
export async function write(file,data) { const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp'; await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600}); await fs.rename(temp,file); }
export function endpoint(value='https://relaynote.dencyu.co.jp') { const u=new URL(value); if(u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use a server origin'); if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('HTTPS is required'); return u.origin; }
