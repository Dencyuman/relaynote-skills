import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-auth-test-'));
process.env.RELAYNOTE_HOME=home;
// Import dynamically: a static import would evaluate state.mjs before RELAYNOTE_HOME is set and
// point every test at the real user auth home.
const {login,credentials,AuthError}=await import('../skills/relaynote/scripts/lib/auth.mjs');
test('OAuth callback waits for token storage and separates success, failure, denial',async()=>{
 let mode='success',registration,base,tokenRequests=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/.well-known/'))return res.end(JSON.stringify({authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',scopes_supported:['relaynote:events','relaynote:upload']}));
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/register'){registration=JSON.parse(body);return res.end(JSON.stringify({client_id:'test-client'}));}
  if(req.url==='/token'){tokenRequests++;await new Promise(r=>setTimeout(r,30));if(mode==='failure'){res.statusCode=400;return res.end('{}');}return res.end(JSON.stringify({access_token:'test-token',expires_in:3600}));}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(mode of ['success','failure','denied']){
   let callback;
   const pending=login(base,{open:false,onUrl:async value=>{
    const url=new URL(value),redirect=url.searchParams.get('redirect_uri'),state=url.searchParams.get('state');
    const invalid=await fetch(redirect+'?state=wrong&code=test',{redirect:'manual'});assert.equal(invalid.status,400);
    callback=fetch(redirect+'?'+new URLSearchParams({state,...(mode==='denied'?{error:'access_denied'}:{code:'test-code'})}),{redirect:'manual'});
   }});
   if(mode==='success')await pending;else await assert.rejects(pending);
   const response=await callback;
   assert.equal(response.status,303);assert.equal(response.headers.get('location'),base+'/oauth/complete?result='+({success:'connected',failure:'failed',denied:'denied'}[mode]));
   assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(registration.logo_uri,base+'/logo.svg');
   if(mode==='success'){assert.equal((await credentials()).accessToken,'test-token');assert.equal((await fs.stat(path.join(home,'auth.json'))).mode&0o777,0o600);}
  }
  assert.equal(tokenRequests,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
});

test('an account subject is stored only when the server itself supplies one',async()=>{
 const jwt=header=>[Buffer.from('{"alg":"none"}').toString('base64url'),Buffer.from(JSON.stringify(header)).toString('base64url'),''].join('.');
 let base,mode='jwt',userinfo=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/.well-known/'))return res.end(JSON.stringify({authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',...(mode==='userinfo'?{userinfo_endpoint:base+'/userinfo'}:{})}));
  if(req.url==='/userinfo'){userinfo++;return res.end(JSON.stringify({sub:'user-from-userinfo'}));}
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/register')return res.end(JSON.stringify({client_id:'test-client'}));
  if(req.url==='/token')return res.end(JSON.stringify({access_token:mode==='jwt'?jwt({sub:'user-from-jwt'}):'opaque-token',expires_in:3600}));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 // The callback response is held until the token exchange finishes, so never await that fetch here.
 const connect=()=>login(base,{open:false,onUrl:value=>{const url=new URL(value);fetch(url.searchParams.get('redirect_uri')+'?'+new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'}),{redirect:'manual'}).catch(()=>{})}});
 try{
  await connect();
  assert.equal((await credentials()).subject,'user-from-jwt');assert.equal(userinfo,0);
  mode='userinfo';await connect();
  assert.equal((await credentials()).subject,'user-from-userinfo');assert.equal(userinfo,1);
  mode='opaque';await connect();
  assert.equal((await credentials()).subject,undefined);
  assert.equal((await credentials()).clientId,'test-client');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
});

test('an authentication failure is a 401 the daemon can stop on',()=>{
 const error=new AuthError('Run login again');
 // Without .status the daemon's [401,403,404] stop checks never fired and it retried a dead
 // refresh token forever on a 60 s backoff.
 assert.equal(error.status,401);
 assert.equal(error.reason,'auth');
 assert.equal([401,403,404].includes(error.status),true);
});
