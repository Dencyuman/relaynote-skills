import { accessToken, AuthError } from './auth.mjs';
let nextId=0;
// `signal` lets a stop request abort a long-poll that is still in flight; `timeoutMs` bounds the request itself.
async function rpc(method,params,{timeoutMs=35000,signal}={}){const {base,token}=await accessToken();const id=++nextId;const deadline=AbortSignal.timeout(timeoutMs);let r;
 try{r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:signal?AbortSignal.any([signal,deadline]):deadline,redirect:'error'});}
 catch(e){if(signal?.aborted)throw e;throw new Error(`MCP request failed (${method}): ${String(e?.message??e).slice(0,200)}`,{cause:e})}if(r.status===401||r.status===403)throw new AuthError('Access denied. Reconnect from login or Settings.');if(!r.ok)throw new Error(`MCP request failed (${r.status})`);
 if(r.headers.get('content-type')?.includes('application/json'))return r.json();
 const reader=r.body.getReader(),decoder=new TextDecoder();let buf='';try{while(true){const {done,value}=await reader.read();if(done)throw new Error('MCP stream ended without a result');buf+=decoder.decode(value,{stream:true});let end;while((end=buf.indexOf('\n\n'))>=0){const frame=buf.slice(0,end);buf=buf.slice(end+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data){const m=JSON.parse(data);if(m.id===id)return m}}if(buf.length>4000000)throw new Error('MCP response too large')}}finally{await reader.cancel().catch(()=>{})}}
export async function tool(name,args,options){const message=await rpc('tools/call',{name,arguments:args},options);if(message.error)throw new Error(`MCP protocol error: ${String(message.error.message??message.error.code??'unknown').slice(0,200)}`);if(message.result?.isError)throw new Error(message.result.content?.find(c=>c.type==='text')?.text??'MCP tool failed');if(!message.result?.structuredContent)throw new Error('Missing structured result');return message.result.structuredContent;}
export const getReview=(session_id,options)=>tool('get_session_review',{session_id},options);
// One held request that returns the moment ANY human feedback lands after `since`, or pending=true at the timeout.
export async function waitForChange(session_id,since,timeoutSeconds=300,options={}){
 return tool('wait_for_review',{session_id,timeout_seconds:timeoutSeconds,wait_for:'any_change',...(since?{since}:{})},{...options,timeoutMs:timeoutSeconds*1000+15000});
}
