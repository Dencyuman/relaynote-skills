import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {uploadAsset} from './upload.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = {pdf:'application/pdf',csv:'text/csv',json:'application/json',svg:'image/svg+xml'};
export async function prepareFile(file) {
  const format=path.extname(file).slice(1).toLowerCase();
  if(!types[format])throw new Error('File must be PDF, CSV, JSON, or a generated SVG.');
  const buffer=await fs.readFile(file);
  if(buffer.length>10_000_000)throw new Error('File exceeds 10 MB.');
  return {buffer,filename:path.basename(file),contentType:types[format]};
}

export async function uploadArtifact(manifestPath,file,sessionId,{upload=uploadAsset}={}) {
  if(!file)throw new Error('Explicit --file must identify the original input.');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  if(manifest.receipt?.rendererVersion!=='relaynote-report-1'||!['file','diff','mermaid','chart'].includes(manifest.type))throw new Error('Unsupported render manifest.');
  if(path.resolve(file)!==path.resolve(manifest.input))throw new Error('Input path does not match the manifest.');
  const bytes=await fs.readFile(file);
  if(hash(bytes)!==manifest.inputHash)throw new Error('Input changed after rendering; run preflight again.');
  const source=manifest.type==='chart'?JSON.stringify(manifest.data):manifest.type==='mermaid'?bytes.toString('utf8').trim():bytes;
  if(hash(source)!==manifest.receipt.sourceHash)throw new Error('Input changed after rendering; run preflight again.');
  if(manifest.type==='chart'&&path.extname(file).toLowerCase()==='.json'&&!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),manifest.data))throw new Error('Chart input differs from the rendered data.');
  if(['diff','mermaid'].includes(manifest.type)&&hash(manifest.source)!==manifest.receipt.sourceHash)throw new Error('Manifest source changed after rendering.');
  const {input:_input,inputHash:_inputHash,preview,files:_files,...block}=manifest;
  if(manifest.type==='file') {
    const asset=await upload(sessionId,await prepareFile(file));
    return {...block,asset_id:asset.asset_id};
  }
  if(manifest.type==='diff')return block;
  const expectedPreview=path.join(path.dirname(path.resolve(manifestPath)),'preview.svg');
  if(path.resolve(preview??'')!==expectedPreview)throw new Error('Preview must be the adjacent preflight SVG.');
  const image=await prepareFile(expectedPreview);
  if(hash(image.buffer)!==manifest.receipt.previewHash)throw new Error('Preview changed after rendering; run preflight again.');
  const asset=await upload(sessionId,image);
  return {...block,preview_asset_id:asset.asset_id};
}

/** No shell, textconv, external diff, or unverified revision arguments. */
export function gitPatch({cwd=process.cwd(),base,head,staged=false,paths=[]}={}) {
  const git=args=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:250_000,timeout:30_000});
    if(result.error||result.status!==0)throw new Error(result.error?.message||'git could not produce this diff');
    return result.stdout;
  };
  const revision=value=>git(['rev-parse','--verify','--end-of-options',`${value}^{commit}`]).trim();
  if(staged&&(base||head))throw new Error('Use staged OR base/head, not both.');
  if(Boolean(base)!==Boolean(head))throw new Error('Specify both base and head.');
  return git(['diff','--no-ext-diff','--no-textconv','--no-renames','--unified=3',...(staged?['--cached']:base?[revision(base),revision(head)]:[]),'--',...paths]);
}
