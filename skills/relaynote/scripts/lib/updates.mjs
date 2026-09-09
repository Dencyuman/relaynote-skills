import {VERSION, endpoint} from './state.mjs';
const version = value => typeof value==='string' && value.length<=32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(n=>Number.isSafeInteger(Number(n)));
const compare = (a,b) => {const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]};

// Return only locally constructed, allowlisted fields. Never forward server prose,
// URLs, commands, or exception messages into an agent conversation.
export function updateInfo(release, installed=VERSION) {
  const s=release?.skill;
  if(release?.schema!==1 || !version(release?.app?.version) || !s || ![installed,s.minimum,s.maximumExclusive,s.recommended].every(version) || typeof s.revision!=='string' || !/^[a-f0-9]{40}$/.test(s.revision) || compare(s.minimum,s.recommended)>0 || compare(s.recommended,s.maximumExclusive)>=0)return {status:'unavailable'};
  const compatible=compare(installed,s.minimum)>=0 && compare(installed,s.maximumExclusive)<0;
  return {status:compatible?(compare(installed,s.recommended)<0?'recommended':'current'):'incompatible',installed,app:release.app.version,minimum:s.minimum,maximumExclusive:s.maximumExclusive,recommended:s.recommended,revision:s.revision};
}
export function updateMessage(release, installed=VERSION) {
  const info=updateInfo(release,installed);
  if(!['recommended','incompatible'].includes(info.status))return '';
  return `Relaynote skill compatibility: ${info.status}; installed ${info.installed}; app ${info.app}; supported >=${info.minimum} <${info.maximumExclusive}; recommended ${info.recommended}; revision ${info.revision}. Do not install automatically. Ask the user before updating; use the pinned release in references/setup.md.`;
}
export async function checkUpdates(base, fetcher=fetch) {
  try {
    const response=await fetcher(`${endpoint(base)}/api/version`,{redirect:'error',signal:AbortSignal.timeout(3000),headers:{Accept:'application/json'}});
    if(!response.ok)return {status:'unavailable'};
    // Cap the body before parsing; no credentials and no remote text in output.
    let text='';
    for await(const chunk of response.body){text+=new TextDecoder().decode(chunk);if(text.length>8192)return {status:'unavailable'};}
    return updateInfo(JSON.parse(text));
  } catch {return {status:'unavailable'};}
}
