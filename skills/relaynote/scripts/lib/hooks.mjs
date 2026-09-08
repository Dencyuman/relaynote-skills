import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {home,read,write} from './state.mjs';
import {fingerprint} from './feedback.mjs';
import {conversationFromHook,hookResponse} from './adapters.mjs';
const bindingFile=(host,thread)=>path.join(home,`hook-${fingerprint({host,thread}).slice(0,24)}.json`);
export async function bindHook(host,thread,sessionId) {
  if(!host||!thread||!/^[0-9a-f-]{36}$/i.test(sessionId))throw new Error('Host, originating conversation, and review UUID are required');
  hookResponse(host,{event_id:'probe',session_id:sessionId,round:1,instruction:''});
  await write(bindingFile(host,thread),{host,thread,sessionId,bindingId:randomUUID()});
}
export async function runHook(host,entry) {
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>1000000)throw new Error('Hook input too large');}
  const input=JSON.parse(text),thread=conversationFromHook(input);
  let binding;try{binding=await read(bindingFile(host,thread))}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(binding.host!==host||binding.thread!==thread)throw new Error('Hook origin mismatch');
  // The native hook owns this child. It waits for a WS event, never for an LLM poll.
  const child=spawn(process.execPath,[entry,'watch',binding.sessionId,'--events','decisions','--consumer',`${host}:${thread}`],{stdio:['ignore','pipe','inherit']});
  const stop=()=>child.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let buffer='',eventToDeliver;
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
      try {const event=JSON.parse(line);if(!eventToDeliver && event.type==='relaynote.feedback')eventToDeliver=event;}
      catch {child.kill('SIGTERM');}
    }
  });
  try{
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Review hook stopped before delivery')));});
    if(eventToDeliver){
      // A Stop hook is armed for one review response, not all future turns.
      const current=await read(bindingFile(host,thread)).catch(()=>null);
      if(current?.bindingId===binding.bindingId)await fs.unlink(bindingFile(host,thread));
      process.stdout.write(JSON.stringify(hookResponse(host,eventToDeliver))+'\n');
    }
  }
  finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
