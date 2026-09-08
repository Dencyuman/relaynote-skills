import fs from 'node:fs/promises';
export const agents = JSON.parse(await fs.readFile(new URL('./agents.json',import.meta.url),'utf8'));
export const feedbackMessage = event => `Relaynote event ${event.event_id}: server ${event.server_url}; session ${event.session_id}, round ${event.round}; decision_id ${event.decision_id}; delivery_id ${event.delivery_id}. ${event.instruction}`;

export function hookResponse(host, event) {
  const message=feedbackMessage(event);
  if(['cursor','cursor-cli'].includes(host))return {followup_message:message};
  if(host==='gemini-cli')return {decision:'deny',reason:message};
  if(['claude-code','codex','goose','qwen-code','trae','augment','junie','github-copilot'].includes(host))return {decision:'block',reason:message};
  throw new Error('This host has no configured Stop hook response');
}

export function conversationFromHook(input) {
  const id=input.session_id??input.conversation_id??input.sessionId;
  if(typeof id!=='string'||!id||id.length>256||/[\r\n\0]/.test(id))throw new Error('Hook must identify the originating conversation');
  return id;
}

/** Data-only templates, not shell snippets. URLs encode IDs and never interpolate review content. */
export function renderAdapter(config,thread,event) {
  if(!thread || config.thread!==thread)throw new Error('Adapter belongs to a different originating conversation');
  const message=feedbackMessage(event);
  const interpolate=value=> typeof value==='string' ? value.replaceAll('{{thread}}',thread).replaceAll('{{message}}',message) : Array.isArray(value)?value.map(interpolate):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,interpolate(v)])):value;
  const url=new URL(config.url.replaceAll('{{thread}}',encodeURIComponent(thread)));
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid adapter endpoint');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Plain HTTP adapters must use loopback');
  if(!['POST','PUT'].includes(config.method??'POST'))throw new Error('Invalid adapter method');
  if(!config.url.includes('{{thread}}')&&!JSON.stringify(config.body).includes('{{thread}}')&&!config.exclusiveConversation)throw new Error('Destination must identify the originating conversation');
  const headers={'Content-Type':'application/json'};
  for(const [name,variable] of Object.entries(config.headersEnv??{})){
    if(typeof variable!=='string'||!process.env[variable])throw new Error(`Missing adapter environment variable: ${variable}`);
    headers[name]=process.env[variable];
  }
  return {url,options:{method:config.method??'POST',headers,body:JSON.stringify(interpolate(config.body)),redirect:'error',signal:AbortSignal.timeout(30000)}};
}
export async function deliverHttp(config,thread,event) {
  const {url,options}=renderAdapter(config,thread,event);
  let response;try{response=await fetch(url,options)}catch{throw new Error('Delivery outcome unknown. Inspect the original conversation before retrying.');}
  if(!response.ok)throw new Error(`Adapter delivery failed (${response.status}). No replacement conversation was created.`);
}
export function adapterTemplate(host,thread,endpoint) {
  if(host==='opencode'||host==='kilo')return {thread,url:`${endpoint}/session/{{thread}}/prompt_async`,body:{parts:[{type:'text',text:'{{message}}'}]}};
  if(host==='continue')return {thread,exclusiveConversation:true,url:`${endpoint}/message`,body:{message:'{{message}}'}};
  if(host==='devin')return {thread,url:`${endpoint}/v1/sessions/{{thread}}/message`,headersEnv:{Authorization:'DEVIN_AUTHORIZATION'},body:{message:'{{message}}'}};
  throw new Error('Read the host reference and supply a data-only adapter config for its current API.');
}
