import { S } from './state.js';
import { APIBASE } from './config.js';

/* ========================= ACCOUNT =========================
   Everything here talks to our own Worker (APIBASE), never to ESPN. Signing in is
   entirely optional: with no account the app behaves exactly as it always has,
   backed by localStorage. An account adds cross-device sync and pick'em.

   The Worker is the only thing that ever sees the Google client secret; this file
   only ever holds a bearer token the Worker issued. */

/* One place where the bearer header gets attached, so no call can forget it.
   Mirrors get() above, but for our API rather than ESPN's. */
async function api(path,opts){
  const o=Object.assign({},opts||{});
  const h=Object.assign({},o.headers||{});
  if(S.authToken)h['Authorization']='Bearer '+S.authToken;
  if(o.body!==undefined&&typeof o.body!=='string'){h['Content-Type']='application/json';o.body=JSON.stringify(o.body);}
  o.headers=h;
  const r=await fetch(APIBASE+path,o);
  let j=null;try{j=await r.json();}catch(e){}
  if(!r.ok){
    // The Worker names what went wrong and why; carry that through rather than
    // throwing a bare status, so a failure is diagnosable from the console.
    const e=new Error((j&&j.error)||('HTTP '+r.status));
    e.status=r.status;e.detail=j&&j.detail;e.requestId=j&&j.requestId;
    throw e;
  }
  return j;
}

export { api };
