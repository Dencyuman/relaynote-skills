import {accessToken,AuthError} from './auth.mjs';
export class StaleDelivery extends Error {}
export function deliveryClient(sessionId,bindingId,base) {
  return async (action,data={}) => {
    const auth=await accessToken();
    if(auth.base!==base)throw new AuthError('Access denied: server changed');
    const response=await fetch(`${base}/api/sessions/${sessionId}/delivery`,{
      method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({action,binding_id:bindingId,...data}),redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if([401,403].includes(response.status))throw new AuthError('Access denied. Reconnect the watcher.');
    if(response.status===409)throw new StaleDelivery((await response.json()).error);
    if(!response.ok)throw new Error(`Delivery report failed (${response.status}); no replacement conversation was started`);
    return response.json();
  };
}

/** Claim before delivery, revalidate at the actual send point, and never replay an ambiguous send. */
export async function deliverDecision(event,{post,snapshot,send}) {
  let claim;
  try { claim=await post('claim',{decision_id:event.decision_id}); }
  catch(error) { if(error instanceof StaleDelivery)return false;throw error; }
  if(claim.status!=='waiting')return false;
  event.delivery_id=claim.delivery_id;
  const ids={decision_id:event.decision_id,delivery_id:event.delivery_id};
  const beforeSend=async()=>{
    const current=await snapshot();
    if(current.current_round!==event.round || current.latest_review?.id!==event.decision_id)return false;
    try { await post('sending',ids);return true; }
    catch(error) { if(error instanceof StaleDelivery)return false;throw error; }
  };
  try {
    if(await send(beforeSend)===false)return false;
    await post('sent',ids);
    return true;
  }catch(error){
    // A transport error may follow acceptance. Preserve that uncertainty; never replay automatically.
    await post('failed',ids).catch(()=>{});
    throw error;
  }
}
