import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareFile,uploadArtifact} from '../skills/relaynote/scripts/lib/artifact.mjs';

test('rendered file upload preserves bytes and refuses changed input',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relaynote-artifact-test-'));
 try{
  const file=path.join(dir,'data.json'),manifestPath=path.join(dir,'manifest.json');
  const source='{"ok":true}';await fs.writeFile(file,source);
  await fs.writeFile(manifestPath,JSON.stringify({type:'file',format:'json',title:'Data',input:file,inputHash:createHash('sha256').update(source).digest('hex'),receipt:{sourceHash:createHash('sha256').update(source).digest('hex'),rendererVersion:'relaynote-report-1'}}));
  let uploads=0;
  const upload=async(session,asset)=>{uploads++;assert.equal(asset.buffer.toString(),source);return {asset_id:'asset'}};
  assert.equal((await uploadArtifact(manifestPath,file,'session',{upload})).asset_id,'asset');
  await fs.writeFile(file,'{"ok":false}');
  await assert.rejects(uploadArtifact(manifestPath,file,'session',{upload}),/changed/);
  assert.equal(uploads,1);
  await assert.rejects(prepareFile(path.join(dir,'file.docx')),/must be/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
