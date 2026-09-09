import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {accessToken,AuthError} from './auth.mjs';

// Reviewers read on a phone and the lightbox zooms, so 1x at 1600px wide is plenty.
// Height gets more room: a stitched full-page capture is tall, not wide, and
// shrinking it by its longest side would leave the text unreadable.
export const DEFAULTS={maxSide:1600,quality:76};
export const TALL=5;
const limits=maxSide=>({width:maxSide,height:maxSide*TALL});
const oversize=(size,maxSide)=>size?size.width>maxSide||size.height>maxSide*TALL:null;
const TYPES=[
 ['image/png',b=>b.length>=8&&b.readUInt32BE(0)===0x89504e47],
 ['image/jpeg',b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff],
 ['image/gif',b=>b.length>=6&&b.toString('latin1',0,4)==='GIF8'],
 ['image/webp',b=>b.length>=12&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'],
 ['image/avif',b=>b.length>=12&&b.toString('latin1',4,8)==='ftyp'&&/^avi[fs]$/.test(b.toString('latin1',8,12))],
];
export function contentType(buffer){return TYPES.find(([,test])=>test(buffer))?.[0]??null}

/** Pixel size from the header alone; null when the format needs a decoder (AVIF). */
export function dimensions(buffer){
 const type=contentType(buffer);
 if(type==='image/png')return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
 if(type==='image/gif')return {width:buffer.readUInt16LE(6),height:buffer.readUInt16LE(8)};
 if(type==='image/jpeg'){let i=2;while(i+9<buffer.length){if(buffer[i]!==0xff){i++;continue}const marker=buffer[i+1];if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){i+=2;continue}if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {height:buffer.readUInt16BE(i+5),width:buffer.readUInt16BE(i+7)};i+=2+buffer.readUInt16BE(i+2)}return null}
 if(type==='image/webp'){const chunk=buffer.toString('latin1',12,16);
  if(chunk==='VP8 '&&buffer.length>=30)return {width:buffer.readUInt16LE(26)&0x3fff,height:buffer.readUInt16LE(28)&0x3fff};
  if(chunk==='VP8L'&&buffer.length>=25){const bits=buffer.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>14)&0x3fff)+1}}
  if(chunk==='VP8X'&&buffer.length>=30)return {width:buffer.readUIntLE(24,3)+1,height:buffer.readUIntLE(27,3)+1}}
 return null;
}

function run(command,args){const r=spawnSync(command,args,{stdio:['ignore','ignore','pipe'],timeout:60000});if(r.error||r.status!==0)throw new Error(`${command} failed: ${r.stderr?.toString().trim()||r.error?.message||r.status}`)}
const has=command=>spawnSync(process.platform==='win32'?'where':'which',[command],{stdio:'ignore'}).status===0;
const loadSharp=()=>{for(const base of [process.cwd()+'/',path.join(os.homedir(),'/')]){try{return createRequire(base)('sharp')}catch{}}return null};

/** Available converters, best first. Each takes (input, {maxSide, quality}) and returns {buffer, extension}. */
export function converters({sharp=loadSharp(),available=has}={}){
 const list=[];
 if(sharp)list.push(['sharp',async(input,{maxSide,quality})=>({buffer:await sharp(input).rotate().resize({...limits(maxSide),fit:'inside',withoutEnlargement:true}).webp({quality}).toBuffer(),extension:'webp'})]);
 const magick=available('magick')?'magick':available('convert')?'convert':null;
 if(magick)list.push([magick,(input,{maxSide,quality})=>viaFiles(input,'webp',(from,to)=>run(magick,[from,'-auto-orient','-resize',`${maxSide}x${maxSide*TALL}>`,'-quality',String(quality),'webp:'+to]))]);
 if(available('cwebp'))list.push(['cwebp',(input,{maxSide,quality})=>{const size=dimensions(input);const scale=size?Math.min(1,maxSide/size.width,maxSide*TALL/size.height):1;return viaFiles(input,'webp',(from,to)=>run('cwebp',['-quiet','-q',String(quality),...(scale<1?['-resize',String(Math.round(size.width*scale)),String(Math.round(size.height*scale))]:[]),from,'-o',to]))}]);
 if(process.platform==='darwin'&&available('sips'))list.push(['sips',(input,{maxSide,quality})=>{const size=dimensions(input);const fit=size&&size.width>maxSide?['--resampleWidth',String(maxSide)]:size&&size.height>maxSide*TALL?['--resampleHeight',String(maxSide*TALL)]:[];return viaFiles(input,'jpg',(from,to)=>run('sips',[...fit,'-s','format','jpeg','-s','formatOptions',String(quality),from,'--out',to]))}]);
 return list;
}
async function viaFiles(input,extension,convert){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-image-'));const from=path.join(dir,'in'),to=path.join(dir,'out.'+extension);
 try{await fs.writeFile(from,input);await convert(from,to);return {buffer:await fs.readFile(to),extension}}finally{await fs.rm(dir,{recursive:true,force:true})}
}

/**
 * Shrink and re-encode an image for a report. Keeps the original when it is
 * already small enough, when re-encoding would not save anything, or for GIFs
 * (animation would be lost). `keep` skips conversion entirely.
 */
export async function prepareImage(file,{maxSide=DEFAULTS.maxSide,quality=DEFAULTS.quality,keep=false,tools=converters()}={}){
 const original=await fs.readFile(file);const type=contentType(original);
 if(!type)throw new Error('Not a PNG, JPEG, GIF, WebP or AVIF image');
 const filename=path.basename(file);const size=dimensions(original);
 const untouched={buffer:original,filename,contentType:type,width:size?.width,height:size?.height,converter:null};
 if(keep||type==='image/gif')return untouched;
 const oversized=size?oversize(size,maxSide):type==='image/avif'?false:true;
 if(!oversized&&original.length<=300_000&&type!=='image/png')return untouched;
 for(const [name,convert] of tools){
  try{
   const result=await convert(original,{maxSide,quality});
   if(!oversized&&result.buffer.length>=original.length)return untouched;
   const after=dimensions(result.buffer);
   return {buffer:result.buffer,filename:filename.replace(/\.[^.]+$/,'')+'.'+result.extension,contentType:contentType(result.buffer)??(result.extension==='jpg'?'image/jpeg':'image/webp'),width:after?.width,height:after?.height,converter:name};
  }catch(e){process.stderr.write(`${name}: ${e.message}\n`)}
 }
 if(oversized||original.length>300_000)process.stderr.write(`No image converter found (sharp, ImageMagick, cwebp or sips); uploading ${filename} as is (${original.length} bytes)\n`);
 return untouched;
}

/** Send the bytes straight to the server; the reply's asset_id is what append_blocks needs. */
export async function uploadAsset(sessionId,{buffer,filename,contentType:type},{fetchImpl=fetch}={}){
 if(!/^[0-9a-f-]{36}$/i.test(sessionId??''))throw new Error('Specify the Relaynote session UUID with --session');
 const {base,token}=await accessToken();
 const r=await fetchImpl(`${base}/api/sessions/${sessionId}/assets`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':type,'X-Relaynote-Filename':encodeURIComponent(filename)},body:buffer,signal:AbortSignal.timeout(120000),redirect:'error'});
 if(r.status===403)throw new AuthError('This login cannot upload: it lacks the relaynote:upload scope. Run login (or login --device) again to grant it.');
 if(r.status===401)throw new AuthError('Access denied. Reconnect with login.');
 if(r.status===404)throw new Error('Session not found for this account');
 if(r.status===413)throw new Error('Image too large for the server');
 if(r.status===415)throw new Error('Image format not accepted by the server');
 if(!r.ok)throw new Error(`Upload failed (${r.status})`);
 const body=await r.json();if(!body?.asset_id)throw new Error('Upload reply had no asset_id');
 return body;
}
