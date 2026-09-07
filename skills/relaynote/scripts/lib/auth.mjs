import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { home, init, read, write, endpoint } from './state.mjs';
const file=path.join(home,'auth.json');
export class AuthError extends Error {}
async function post(url,body,form=false){const r=await fetch(url,{method:'POST',headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'},body:form?new URLSearchParams(body):JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});if(r.status>=500||r.status===429)throw new Error('Authentication service temporarily unavailable');if(!r.ok)throw new AuthError(`Authentication failed (${r.status}); run login again`);return r.json()}
function sameOrigin(url,base){if(new URL(url).origin!==base)throw new Error('Unexpected OAuth endpoint');return url;}
let refreshing;
export async function credentials(){return read(file).catch(()=>{throw new AuthError('Run relaynote login first')})}
export async function accessToken(){const a=await credentials();if(a.apiKey)return{base:a.base,token:a.apiKey};if(a.expiresAt>Date.now()+60000)return{base:a.base,token:a.accessToken};
 refreshing??=(async()=>{if(!a.refreshToken)throw new AuthError('Run login again');const t=await post(sameOrigin(a.tokenEndpoint,a.base),{grant_type:'refresh_token',client_id:a.clientId,refresh_token:a.refreshToken,resource:a.base+'/mcp'},true);if(!t.access_token)throw new AuthError('No access token');await write(file,{...a,accessToken:t.access_token,refreshToken:t.refresh_token??a.refreshToken,expiresAt:Date.now()+t.expires_in*1000});return{base:a.base,token:t.access_token}})().finally(()=>{refreshing=undefined});return refreshing;
}
export async function apiKeyLogin(base,key){await init();if(!key.trim())throw new Error('No key received on stdin');await write(file,{base:endpoint(base),apiKey:key.trim()});}
export async function login(base,{open=true,onUrl}={}){
 base=endpoint(base);await init();
 const r=await fetch(base+'/.well-known/oauth-authorization-server/api/auth',{signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw new Error('OAuth discovery failed');const meta=await r.json();
 for(const k of ['authorization_endpoint','token_endpoint','registration_endpoint'])sameOrigin(meta[k],base);
 const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url');
 let resolveCode,rejectCode;const code=new Promise((a,b)=>{resolveCode=a;rejectCode=b});
 const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname!=='/callback'||u.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid callback');return}if(!u.searchParams.get('code')){res.end('Authorization was not completed.');rejectCode(new AuthError('Authorization denied'));return}res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Relaynoteに接続しました。この画面を閉じてください。');resolveCode(u.searchParams.get('code'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const redirect=`http://127.0.0.1:${server.address().port}/callback`;
 const timeout=setTimeout(()=>rejectCode(new AuthError('Login timed out')),180000);code.catch(()=>{});
 try{
  const client=await post(meta.registration_endpoint,{client_name:'Relaynote background watcher',application_type:'native',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  const url=new URL(meta.authorization_endpoint);url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'relaynote offline_access',resource:base+'/mcp',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  if(onUrl)await onUrl(url.href);else console.log(`Authorize Relaynote in your browser:\n${url.href}`);
  if(open){const command=process.platform==='darwin'?'open':process.platform==='win32'?null:'xdg-open';if(command){const p=spawn(command,[url.href],{stdio:'ignore'});p.on('error',()=>{});p.unref()}}
  const t=await post(meta.token_endpoint,{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code:await code,code_verifier:verifier,resource:base+'/mcp'},true);if(!t.access_token)throw new AuthError('No access token');
  await write(file,{base,clientId:client.client_id,tokenEndpoint:meta.token_endpoint,accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+t.expires_in*1000});
 }finally{clearTimeout(timeout);server.closeAllConnections();await new Promise(r=>server.close(r));}
}
