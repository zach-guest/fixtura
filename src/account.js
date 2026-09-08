import { S } from './state.js';
import { api } from './api.js';
import { render } from './app.js';
import { APIBASE, DEFAULT_TEAMS, DEFAULT_TICKER, DEFAULT_VIEWS, GOLF_TOURS, VIEW_LABELS } from './config.js';
import { $, esc, store } from './util.js';

function readAuth(){
  let a=null;try{const r=store('sb-auth');if(r)a=JSON.parse(r);}catch(e){}
  if(!a||!a.token)return;
  if(a.exp&&a.exp*1000<=Date.now())return;      // expired locally; don't bother the server
  S.authToken=a.token;S.authExp=a.exp||0;
}

function saveAuth(){try{store('sb-auth',JSON.stringify({token:S.authToken,exp:S.authExp}));}catch(e){}}

function clearAuth(){S.authToken=null;S.authExp=0;S.me=null;try{store('sb-auth','');}catch(e){}}

async function initAuth(){
  /* The callback returns the token in the URL *fragment*: a fragment is never sent
     to a server, so it stays out of access logs and out of the Referer header of
     whatever the page loads next. Take it, then strip it — otherwise it sits in the
     address bar waiting to be copied into a message. */
  try{
    const h=location.hash||'';
    if(h.indexOf('fixtura_token=')>=0){
      const p=new URLSearchParams(h.replace(/^#/,''));
      const t=p.get('fixtura_token');
      if(t){S.authToken=t;S.authExp=+(p.get('fixtura_expires')||0)||0;saveAuth();}
      history.replaceState(null,'',location.pathname+location.search);
    }
  }catch(e){}
  if(!S.authToken)readAuth();
  if(!S.authToken)return;
  try{
    const r=await api('/me');
    S.me=(r&&r.user)||null;
  }catch(e){
    S.me=null;
    // Only a 401 means the token is actually dead. Being unable to reach the Worker
    // is not the same as being signed out, and must not silently log anyone out.
    if(e.status===401)clearAuth();
  }
}

function signIn(){
  // Only the origin is checked by the Worker's allow-list, but send a clean URL
  // anyway so nobody comes back to a stale query string.
  location.href=APIBASE+'/auth/google/start?return='+encodeURIComponent(location.origin+location.pathname);
}

async function signOut(){
  try{await api('/auth/logout',{method:'POST'});}catch(e){}   // already gone is not an error
  clearAuth();S.authMenu=false;renderAuth();render();
}

function renderAuth(){
  const b=$('#authBtn');if(!b)return;
  b.textContent=S.me?(S.me.name||S.me.email||'Account'):'Sign in';
  b.classList.toggle('on',!!S.me);
  const m=$('#authMenu');if(!m)return;
  m.classList.toggle('open',S.authMenu&&!!S.me);
  if(S.authMenu&&S.me){
    m.innerHTML='<div class="amname">'+esc(S.me.name||'')+'</div>'+
      '<div class="amsub">'+esc(S.me.email||'')+'</div>'+
      (S.me.role==='admin'?'<div class="amsub">admin</div>':'')+
      '<button class="chip sm" id="authOut">Sign out</button>';
    if($('#authOut'))$('#authOut').onclick=signOut;
  }
}

/* ---- cross-device settings sync ----
   The keys are exactly the existing sb-* localStorage names, so the server never
   learns a second shape and store() stays the only writer. Semantics are: the
   account wins on load, this device pushes on change. Real timestamp merging would
   need a per-key mtime that store() does not track, and for one person on two
   devices this is both correct and far simpler. */
const SYNC_KEYS=['sb-favs','sb-ticker','sb-views','sb-theme','sb-viewsseen'];

function localSettings(){
  const o={};
  SYNC_KEYS.forEach(k=>{const v=store(k);if(v)o[k]=v;});
  return o;
}

async function pullSettings(){
  if(!S.me)return false;
  let r;try{r=await api('/me/settings');}catch(e){return false;}
  const s=(r&&r.settings)||{},keys=Object.keys(s).filter(k=>SYNC_KEYS.indexOf(k)>=0);
  if(!keys.length){pushSettings();return false;}    // first sign-in: seed the account from this device
  keys.forEach(k=>store(k,s[k].value));
  return true;
}

function pushSettings(){
  if(!S.me)return;
  const out=localSettings();
  if(!Object.keys(out).length)return;
  // Fire and forget. A failed sync must never block a local write — store() already
  // swallows its own failures for exactly the same reason.
  api('/me/settings',{method:'PUT',body:{settings:out}}).catch(()=>{});
}

/* Re-apply what the account sent, using the same guards initSettings() uses: keep
   only views that still exist, and never strand the user on a hidden tab. */
function reloadFromStore(){
  let s=null;try{const r=store('sb-favs');if(r)s=JSON.parse(r);}catch(e){}
  if(Array.isArray(s)){S.MY_TEAMS=s;syncFavNames();S.calCache=null;}
  let t=null;try{const r=store('sb-ticker');if(r)t=JSON.parse(r);}catch(e){}
  if(Array.isArray(t)){S.TICKER_LEAGUES=t;S.tickerSig='';}
  let v=null;try{const r=store('sb-views');if(r)v=JSON.parse(r);}catch(e){}
  if(Array.isArray(v)){
    const nv=v.filter(k=>VIEW_LABELS[k]);
    // Same reconciliation as on boot: an account's saved layout is just as old
    // as a local one, and would otherwise hide any newly added view.
    if(nv.length){S.VIEW_ORDER=reconcileViews(nv);if(S.VIEW_ORDER.indexOf(S.view)<0){S.view=S.VIEW_ORDER[0];saveLastView();}}
  }
  const th=store('sb-theme');
  if(th){document.documentElement.setAttribute('data-theme',th);const el=$('#theme');if(el)el.value=th;}
}

/* ---- settings persistence ---- */
function initSettings(){
  let s=null;try{const r=store('sb-favs');if(r)s=JSON.parse(r);}catch(e){}
  S.MY_TEAMS=Array.isArray(s)?s:DEFAULT_TEAMS.slice();syncFavNames();
  let t=null;try{const r=store('sb-ticker');if(r)t=JSON.parse(r);}catch(e){}
  S.TICKER_LEAGUES=Array.isArray(t)?t:DEFAULT_TICKER.slice();
  let v=null;try{const r=store('sb-views');if(r)v=JSON.parse(r);}catch(e){}
  // keep only keys that still exist, so removing a view can't strand a saved layout
  S.VIEW_ORDER=(Array.isArray(v)?v:DEFAULT_VIEWS.slice()).filter(k=>VIEW_LABELS[k]);
  if(!S.VIEW_ORDER.length)S.VIEW_ORDER=DEFAULT_VIEWS.slice();
  S.VIEW_ORDER=reconcileViews(S.VIEW_ORDER);
  S.pkOdds=store('sb-pk-odds')==='1';
  const last=store('sb-lastview');
  S.view=(last&&S.VIEW_ORDER.indexOf(last)>=0)?last:S.VIEW_ORDER[0];
  // ?view=golf&tour=lpga — lets a shared link open on a specific view instead of
  // whatever the recipient last had open. Beats "open it and click GOLF".
  try{
    const p=new URLSearchParams(location.search),qv=p.get('view'),qt=p.get('tour');
    if(qv&&VIEW_LABELS[qv]){
      S.view=qv;
      if(S.VIEW_ORDER.indexOf(qv)<0)S.VIEW_ORDER.unshift(qv);  // don't land on a hidden tab
    }
    if(qt&&GOLF_TOURS.some(t=>t[0]===qt))S.golfTour=qt;
    // ?join=CODE — a pool invite link. The code isn't sensitive (it's meant to be
    // shared), so unlike the OAuth token fragment this is left in the address bar;
    // reloading it just re-runs a join, which the server already treats as a no-op.
    // Stashed under the same sb-pk- prefix pickem.js's own pkGet/pkSet use, so it
    // survives the full-page redirect through Google sign-in if the visitor isn't
    // signed in yet — renderPickem() picks it up and joins once S.me exists.
    const qj=p.get('join');
    if(qj){
      S.view='pickem';
      if(S.VIEW_ORDER.indexOf('pickem')<0)S.VIEW_ORDER.unshift('pickem');
      try{store('sb-pk-pendingjoin',qj.toUpperCase());}catch(e){}
    }
  }catch(e){}
}

/* The set of views that existed before this reconciliation was introduced. Only
   used to bootstrap `sb-viewsseen` for people whose layout predates it. */
const VIEWS_KNOWN_BEFORE=['scores','teams','f1','golf','calendar'];

/* A saved tab layout is a snapshot of the views that existed when it was saved,
   so adding a view would leave it permanently invisible to anyone who had ever
   reordered their tabs — they would simply never find out it exists. This
   appends any view the layout has not been reconciled against, exactly once.
   Hide it afterwards and it stays hidden, because by then it is in the seen list.
   Found the hard way: PICK'EM vanished the moment a saved layout was synced.

   This is deliberately PURE. Writing the marker here looked right and was not:
   boot reconciles the *local* layout first, so the marker was already written by
   the time the account's older layout arrived, and the new view was suppressed
   again. The marker is only written when the user actually changes their tabs —
   which is the moment their intent is real. Until then a new view keeps
   reappearing, which is the behaviour you want; hide it and the write in
   saveViews() records that, so it stays hidden. */
function reconcileViews(order){
  let seen=null;try{const r=store('sb-viewsseen');if(r)seen=JSON.parse(r);}catch(e){}
  if(!Array.isArray(seen))seen=VIEWS_KNOWN_BEFORE.slice();
  const out=order.slice();
  Object.keys(VIEW_LABELS).forEach(k=>{if(seen.indexOf(k)<0&&out.indexOf(k)<0)out.push(k);});
  return out;
}

function saveViews(){
  try{
    store('sb-views',JSON.stringify(S.VIEW_ORDER));
    store('sb-viewsseen',JSON.stringify(Object.keys(VIEW_LABELS)));  // their layout is now a decision
  }catch(e){}
  pushSettings();
}

function saveLastView(){try{store('sb-lastview',S.view);}catch(e){}}

function syncFavNames(){S.FAV_NAMES=S.MY_TEAMS.map(t=>t.name).filter(Boolean);}

function saveFavs(){try{store('sb-favs',JSON.stringify(S.MY_TEAMS));}catch(e){}syncFavNames();S.calCache=null;pushSettings();}

function saveTicker(){try{store('sb-ticker',JSON.stringify(S.TICKER_LEAGUES));}catch(e){}pushSettings();}

function favIndex(lg,id){return S.MY_TEAMS.findIndex(t=>t.league===lg&&String(t.id)===String(id));}

function toggleFav(t){
  const i=favIndex(t.league,t.id);
  if(i>=0)S.MY_TEAMS.splice(i,1);else S.MY_TEAMS.push({name:t.name,short:t.short||t.name,league:t.league,id:String(t.id),logo:t.logo||''});
  saveFavs();
}

export { favIndex, initAuth, initSettings, pullSettings, pushSettings, reloadFromStore, renderAuth, saveFavs, saveLastView, saveTicker, saveViews, signIn, toggleFav };
