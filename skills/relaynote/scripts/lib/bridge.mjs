import fs from 'node:fs/promises';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

/** Start once as the host's ACP command / Amp stream owner, never in response to feedback. */
export async function bridge(protocol,socketPath,command,args) {
  if(!['acp','amp'].includes(protocol)||!socketPath?.startsWith('/')||!command)throw new Error('bridge requires --protocol acp|amp --socket ABSOLUTE_PATH -- COMMAND ARGS');
  // Never unlink an existing listener: it might own another live conversation.
  try{await fs.lstat(socketPath);throw new Error('Bridge socket already exists')}catch(error){if(error.code!=='ENOENT')throw error;}
  const sessions=new Set(),pending=new Map(),requests=new Map();let sequence=0,exited=false;
  const child=spawn(command,args,{stdio:['pipe','pipe','inherit']});
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const server=http.createServer(async(req,res)=>{
    const match=/^\/sessions\/([^/]+)\/message$/.exec(req.url??'');
    if(req.method!=='POST'||!match){res.writeHead(404);res.end();return;}
    const thread=decodeURIComponent(match[1]);
    if(exited||!sessions.has(thread)){res.writeHead(409);res.end('Originating conversation is not attached');return;}
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000){res.writeHead(413);res.end();return;}}
    let body;try{body=JSON.parse(raw)}catch{res.writeHead(400);res.end();return;}
    if(typeof body.message!=='string'){res.writeHead(400);res.end();return;}
    if(protocol==='amp'){
      // Amp keeps this one conversation alive until stdin closes.
      send({type:'user',message:{role:'user',content:[{type:'text',text:body.message}]}});
      res.writeHead(202);res.end();return;
    }
    const id=`relaynote:${++sequence}`;
    // ACP notifications continue to the real host; only our response is consumed here.
    pending.set(id,res);
    send({jsonrpc:'2.0',id,method:'session/prompt',params:{sessionId:thread,prompt:[{type:'text',text:body.message}]}});
    // The request has been accepted by the owning bridge. No second agent is created.
  });
  const input=createInterface({input:process.stdin});
  input.on('line',line=>{
    try{
      const message=JSON.parse(line);
      if(protocol==='acp'&&['session/new','session/load','session/resume'].includes(message.method))requests.set(message.id,message);
      send(message);
    }catch{process.stderr.write('Invalid bridge input JSON\n');}
  });
  const output=createInterface({input:child.stdout});
  output.on('line',line=>{
    try{
      const message=JSON.parse(line);
      if(protocol==='amp'&&typeof message.session_id==='string')sessions.add(message.session_id);
      if(protocol==='acp'){
        const request=requests.get(message.id);
        if(request){requests.delete(message.id);if(!message.error){const id=message.result?.sessionId??request.params?.sessionId;if(id)sessions.add(id);}}
        if(pending.has(message.id)){const response=pending.get(message.id);pending.delete(message.id);response.writeHead(message.error?409:202);response.end();return;}
      }
    }catch{ /* Preserve the actual agent's stdout. */ }
    process.stdout.write(line+'\n');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});
  await fs.chmod(socketPath,0o600);
  const stop=()=>{exited=true;child.kill('SIGTERM');server.close();};
  input.once('close',()=>{if(protocol==='acp')stop();});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});}
  finally{stop();input.close();output.close();await fs.unlink(socketPath).catch(()=>{});process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}

export async function deliverBridge(socketPath,thread,message) {
  await new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:`/sessions/${encodeURIComponent(thread)}/message`,method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.statusCode===202?resolve():reject(new Error('Originating bridge rejected feedback'));});
    req.setTimeout(30000,()=>req.destroy(new Error('Delivery outcome unknown; inspect the original conversation')));
    req.on('error',reject);req.end(JSON.stringify({message}));
  });
}
