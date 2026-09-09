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
// Account identity for later "is this the same account" checks. Only what the server itself hands
// over: the token response, a JWT `sub` inside the access token, or a userinfo endpoint published in
// OAuth discovery. Nothing is guessed. // TODO subject: this server publishes no userinfo endpoint
// today, so a non-JWT token leaves clientId+base as the only account identifiers.
const jwtSubject=token=>{const parts=String(token??'').split('.');if(parts.length!==3)return undefined;
 try{const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));return typeof claims.sub==='string'&&claims.sub?claims.sub:undefined}catch{return undefined}};
async function subjectOf(token,meta,base){
 if(typeof token.sub==='string'&&token.sub)return token.sub;
 const fromToken=jwtSubject(token.access_token);if(fromToken)return fromToken;
 if(!meta.userinfo_endpoint)return undefined;
 try{const r=await fetch(sameOrigin(meta.userinfo_endpoint,base),{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!r.ok)return undefined;const info=await r.json();return [info.sub,info.id,info.user_id].find(v=>typeof v==='string'&&v)}catch{return undefined}
}
// Read-only events plus the upload-only scope: the watcher can store report images but never write anything else.
const watcherScope=meta=>{const supported=name=>meta.scopes_supported?.includes(name);return [supported('relaynote:events')?'relaynote:events':'relaynote',...(supported('relaynote:upload')?['relaynote:upload']:[]),'offline_access'].join(' ')};
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
 let callbackResponse,claimed=false;
 const complete=async(result)=>{if(!callbackResponse||callbackResponse.writableEnded||callbackResponse.destroyed)return;const res=callbackResponse;await new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve);res.writeHead(303,{'Location':base+'/oauth/complete?result='+result,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();});};
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(req.method!=='GET'||u.pathname!=='/callback'||u.searchParams.get('state')!==state||claimed){res.writeHead(400);res.end('Invalid callback');return;}
  claimed=true;callbackResponse=res;
  if(u.searchParams.has('error')||!u.searchParams.get('code')){rejectCode(new AuthError('Authorization denied'));return;}
  resolveCode(u.searchParams.get('code'));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const redirect=`http://127.0.0.1:${server.address().port}/callback`;
 const timeout=setTimeout(()=>rejectCode(new AuthError('Login timed out')),180000);code.catch(()=>{});
 try{
  const client=await post(meta.registration_endpoint,{client_name:'Relaynote background watcher',logo_uri:base+'/logo.svg',application_type:'native',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  const url=new URL(meta.authorization_endpoint);url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:watcherScope(meta),resource:base+'/mcp',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  if(onUrl)await onUrl(url.href);else console.log(`Authorize Relaynote in your browser:\n${url.href}`);
  if(open){const command=process.platform==='darwin'?'open':process.platform==='win32'?null:'xdg-open';if(command){const p=spawn(command,[url.href],{stdio:'ignore'});p.on('error',()=>{});p.unref()}}
  const t=await post(meta.token_endpoint,{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code:await code,code_verifier:verifier,resource:base+'/mcp'},true);if(!t.access_token)throw new AuthError('No access token');
  const subject=await subjectOf(t,meta,base);
  await write(file,{base,clientId:client.client_id,tokenEndpoint:meta.token_endpoint,accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+t.expires_in*1000,scope:t.scope,...(subject?{subject}:{})});
  await complete('connected');
 }catch(error){await complete(error.message==='Authorization denied'?'denied':'failed');throw error;}finally{clearTimeout(timeout);server.closeAllConnections();await new Promise(r=>server.close(r));}
}

export async function deviceLogin(base,{onUrl}={}) {
 base=endpoint(base);await init();
 const response=await fetch(base+'/.well-known/oauth-authorization-server/api/auth',{signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!response.ok)throw new AuthError('OAuth discovery failed');
 const meta=await response.json();
 for(const k of ['device_authorization_endpoint','token_endpoint','registration_endpoint'])sameOrigin(meta[k],base);
 const scope=watcherScope(meta);
 const client=await post(meta.registration_endpoint,{client_name:'Relaynote background watcher',logo_uri:base+'/logo.svg',application_type:'native',redirect_uris:[base+'/oauth/device'],token_endpoint_auth_method:'none',grant_types:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],response_types:[],scope});
 const device=await post(meta.device_authorization_endpoint,{client_id:client.client_id,scope,resource:base+'/mcp'},true);
 sameOrigin(device.verification_uri_complete,base);
 if(onUrl)await onUrl(device.verification_uri_complete,device.user_code);
 else console.log(`Open this link on your phone or computer and confirm code ${device.user_code}:\n${device.verification_uri_complete}`);
 const deadline=Date.now()+Math.min(device.expires_in,900)*1000;
 let interval=Math.max(5,device.interval||5)*1000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,interval));
  const response=await fetch(meta.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:client.client_id,device_code:device.device_code,resource:base+'/mcp'}),signal:AbortSignal.timeout(20000),redirect:'error'});
  const t=await response.json();
  if(response.ok && t.access_token){const subject=await subjectOf(t,meta,base);await write(file,{base,clientId:client.client_id,tokenEndpoint:meta.token_endpoint,accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+t.expires_in*1000,scope:t.scope,...(subject?{subject}:{})});return;}
  if(t.error==='authorization_pending')continue;
  if(t.error==='slow_down'){interval+=5000;continue;}
  throw new AuthError(`Device authorization ${t.error||'failed'}`);
 }
 throw new AuthError('Device authorization expired. Run login --device again.');
}
