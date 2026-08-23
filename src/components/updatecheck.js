import { S } from '../state.js';
import { headSelf, staleAgainst } from './settings.js';
import { $ } from '../util.js';

/* ===== UPDATE CHECK =====
   Deploying is instant but the client can sit on a stale copy for a long time:
   GitHub Pages sends `cache-control: max-age=600`, and the Safari "Add to Dock" web
   app (how this actually gets used on the Mac) suspends rather than reloads, so it
   can serve a build from days ago. A service worker would be the textbook fix, but
   that needs a second same-origin file and would break the single-file constraint.
   Instead: HEAD our own URL and watch the ETag. Same-origin, so the header is
   readable; HEAD, so it costs no body. Checking on focus is the important one —
   that's exactly when a suspended web app comes back up. */

async function checkForUpdate(){
  if(!/^https?:$/.test(location.protocol))return;      // no-op on file://
  if(S.updateShown)return;
  let h;
  try{h=await headSelf();}
  catch(e){return;}                                    // offline is not an error worth showing
  if(!h||!h.tag)return;
  S.latestTag=h.tag;
  if(h.tag===S.dismissedTag)return;                      // already said no to this exact build
  // An ETag baseline can only catch a deploy that lands *after* this point, so on the first
  // run compare timestamps as well: the document may already be stale, having been served
  // from the 10-minute Pages cache moments after a deploy.
  if(S.buildTag===null)S.buildTag=h.tag;
  if(h.tag!==S.buildTag||staleAgainst(h.lm)){
    S.updateShown=true;
    const b=$('#updBanner');
    if(b)b.classList.add('show');
  }
}

(function wireUpdate(){
  const b=$('#updBanner');
  if(!b)return;
  const rl=$('#updReload'),x=$('#updDismiss');
  if(rl)rl.onclick=()=>location.reload();
  // Dismiss means "not this build". Clearing the baseline instead would let the timestamp
  // check re-raise the banner on the very next tick, since the loaded document is still old.
  if(x)x.onclick=()=>{b.classList.remove('show');S.updateShown=false;S.dismissedTag=S.latestTag;};
  checkForUpdate();
  setInterval(checkForUpdate,600000);                  // matches the Pages max-age
  window.addEventListener('focus',checkForUpdate);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkForUpdate();});
})();
