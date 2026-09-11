import {accessToken,AuthError} from './auth.mjs';
export class StaleDelivery extends Error {}
/** The five delivery-failure categories the server stores verbatim (<=300 chars). */
export const reasonText = error => `${error?.reason ?? 'transport_unknown'}: ${String(error?.message ?? error)}`.replace(/\s+/g,' ').slice(0,300);
/** `reason` is only accepted by a server that advertises it; an older `.strict()` schema would 400. */
export const acceptsReason = snapshot => snapshot?.delivery_reason===1 || Number(snapshot?.delivery_protocol)>=4;
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
export async function deliverDecision(event,{post,snapshot,send,onFailure=()=>{}}) {
  const kind=event.event_kind==='discussion'?{event_kind:'discussion'}:{};
  let claim;
  try { claim=await post('claim',{decision_id:event.decision_id,...kind}); }
  catch(error) { if(error instanceof StaleDelivery)return false;throw error; }
  if(claim.status!=='waiting')return false;
  event.delivery_id=claim.delivery_id;
  const ids={decision_id:event.decision_id,delivery_id:event.delivery_id,...kind};
  let sending=false,reasonSupported=null;
  const look=async()=>{const current=await snapshot();reasonSupported=acceptsReason(current);return current};
  const beforeSend=async()=>{
    const current=await look();
    if(current.current_round!==event.round)return false;
    if(event.event_kind==='discussion') {
      if(current.review_status!=='in_review' || !(current.discussions??[]).some(d=>d.id===event.discussion_id && d.reviewRound===event.round))return false;
    } else if(current.latest_review?.id!==event.decision_id)return false;
    try {
      if(sending){
        const currentClaim=await post('claim',{decision_id:event.decision_id,...kind});
        return currentClaim.delivery_id===event.delivery_id&&currentClaim.status==='sending';
      }
      await post('sending',ids);sending=true;return true;
    }
    catch(error) { if(error instanceof StaleDelivery)return false;throw error; }
  };
  try {
    if(await send(beforeSend)===false)return false;
    await post('sent',ids);
    return true;
  }catch(error){
    // A transport error may follow acceptance. Preserve that uncertainty; never replay automatically.
    // The reason says which kind of failure it was, so `failed` is never a silent dead end.
    const reason=reasonText(error);
    onFailure(reason,error);
    if(reasonSupported===null)await look().catch(()=>{});
    await post('failed',{...ids,...(reasonSupported?{reason}:{})}).catch(()=>{});
    throw error;
  }
}
