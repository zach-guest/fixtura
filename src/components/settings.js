import { S } from '../state.js';
import { saveLastView, saveTicker, saveViews } from '../account.js';
import { render, renderNav } from '../app.js';
import { loadTicker } from './ticker.js';
import { DEFAULT_TICKER, DEFAULT_VIEWS, LEAGUES, VIEW_LABELS } from '../config.js';
import { $, esc } from '../util.js';

/* ========================= SETTINGS PANEL ========================= */
function cfgHTML(){
  const keys=Object.keys(LEAGUES);
  const hidden=Object.keys(VIEW_LABELS).filter(k=>S.VIEW_ORDER.indexOf(k)<0);
  return '<div class="panel"><div class="grouplabel" style="margin:0 0 4px">Tabs &mdash; order and visibility</div>'+
    '<div class="vwlist">'+S.VIEW_ORDER.map((k,i)=>'<div class="vwrow">'+
      '<button class="vwbtn" data-vmove="'+k+'" data-dir="-1"'+(i===0?' disabled':'')+' aria-label="Move up">&uarr;</button>'+
      '<button class="vwbtn" data-vmove="'+k+'" data-dir="1"'+(i===S.VIEW_ORDER.length-1?' disabled':'')+' aria-label="Move down">&darr;</button>'+
      '<span class="vwname">'+esc(VIEW_LABELS[k])+'</span>'+
      '<button class="chip sm" data-vhide="'+k+'"'+(S.VIEW_ORDER.length<2?' disabled':'')+'>Hide</button></div>').join('')+
    hidden.map(k=>'<div class="vwrow off"><span class="vwname" style="margin-left:64px">'+esc(VIEW_LABELS[k])+'</span>'+
      '<button class="chip sm" data-vshow="'+k+'">Show</button></div>').join('')+'</div>'+
    '<div style="margin-top:8px"><button class="chip sm" id="vwDef">Reset tabs</button></div></div>'+
    '<div class="panel"><div class="grouplabel" style="margin:0 0 4px">Top ribbon &mdash; pick what scrolls</div>'+
    '<div class="cbgrid">'+keys.map(k=>'<label class="cbrow"><input type="checkbox" data-tk="'+k+'"'+
      (S.TICKER_LEAGUES.indexOf(k)>=0?' checked':'')+'> '+esc(LEAGUES[k].label)+'</label>').join('')+'</div>'+
    '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">'+
      '<button class="chip sm" id="tkAll">Select all</button><button class="chip sm" id="tkNone">Clear</button>'+
      '<button class="chip sm" id="tkDef">Reset to default</button></div></div>'+
    '<div class="panel"><div class="grouplabel" style="margin:0 0 4px">This build</div>'+
    '<div class="cbrow" style="justify-content:space-between">'+
      '<span id="buildInfo" style="font-family:\'Roboto Mono\',monospace;font-size:11px;color:var(--dim)">checking\u2026</span>'+
      '<button class="chip sm" id="buildReload">Reload now</button></div></div>';
}

/* "Which build am I running?" and "which build is deployed?" are different questions, and
   only the second one is a network call. HEADing our own URL answers the second; the first
   is `document.lastModified`, which reflects the Last-Modified header of the document that
   actually loaded. Asking only the server — which this used to do — reports the deploy time
   and calls it your version, so a stale client is told the *new* date and reads as current,
   which is the one case the panel exists to catch. */
const BUILD_SKEW_MS=2000;

// document.lastModified is second-resolution
function runningBuild(){
  const t=Date.parse(document.lastModified);
  return isNaN(t)?null:t;
}

async function headSelf(){
  const r=await fetch(location.pathname+'?_v='+Date.now(),{method:'HEAD',cache:'no-store'});
  if(!r.ok)return null;
  return {tag:r.headers.get('etag')||r.headers.get('last-modified'),lm:r.headers.get('last-modified')};
}

/* True only when the deployed copy is genuinely newer than the loaded one. Both guards
   matter: with no Last-Modified header document.lastModified defaults to "now", which must
   not read as permanently stale, and second-resolution timestamps need the skew allowance. */
function staleAgainst(lm){
  const mine=runningBuild(),theirs=lm?Date.parse(lm):NaN;
  if(mine===null||isNaN(theirs))return false;
  return theirs-mine>BUILD_SKEW_MS;
}

async function showBuildInfo(){
  const el=$('#buildInfo');
  if(!el)return;
  if(!/^https?:$/.test(location.protocol)){el.textContent='running from a local file';return;}
  try{
    const h=await headSelf();
    if(!h||!h.lm){el.textContent='unknown';return;}
    const when=new Date(h.lm).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    el.textContent=staleAgainst(h.lm)?('stale — '+when+' is live, reload'):('current — deployed '+when);
  }catch(e){el.textContent='offline';}
}

function wireCfg(){
  const redrawTabs=()=>{saveViews();renderNav();render();};
  if($('#buildReload'))$('#buildReload').onclick=()=>location.reload();
  showBuildInfo();
  document.querySelectorAll('[data-vmove]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.vmove,i=S.VIEW_ORDER.indexOf(k),j=i+ +b.dataset.dir;
    if(i<0||j<0||j>=S.VIEW_ORDER.length)return;
    S.VIEW_ORDER.splice(j,0,S.VIEW_ORDER.splice(i,1)[0]);redrawTabs();
  });
  document.querySelectorAll('[data-vhide]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.vhide;
    if(S.VIEW_ORDER.length<2)return;                 // never hide the last tab
    S.VIEW_ORDER=S.VIEW_ORDER.filter(x=>x!==k);
    if(S.view===k){S.view=S.VIEW_ORDER[0];saveLastView();}  // don't strand the user on a hidden view
    redrawTabs();
  });
  document.querySelectorAll('[data-vshow]').forEach(b=>b.onclick=()=>{
    S.VIEW_ORDER.push(b.dataset.vshow);redrawTabs();});
  if($('#vwDef'))$('#vwDef').onclick=()=>{S.VIEW_ORDER=DEFAULT_VIEWS.slice();redrawTabs();};
  document.querySelectorAll('[data-tk]').forEach(cb=>cb.onchange=()=>{
    const k=cb.dataset.tk,i=S.TICKER_LEAGUES.indexOf(k);
    if(cb.checked&&i<0)S.TICKER_LEAGUES.push(k);
    if(!cb.checked&&i>=0)S.TICKER_LEAGUES.splice(i,1);
    saveTicker();S.tickerSig='';loadTicker();
  });
  if($('#tkAll'))$('#tkAll').onclick=()=>{S.TICKER_LEAGUES=Object.keys(LEAGUES).slice(0,25);saveTicker();S.tickerSig='';render();loadTicker();};
  if($('#tkNone'))$('#tkNone').onclick=()=>{S.TICKER_LEAGUES=[];saveTicker();S.tickerSig='';render();loadTicker();};
  if($('#tkDef'))$('#tkDef').onclick=()=>{S.TICKER_LEAGUES=DEFAULT_TICKER.slice();saveTicker();S.tickerSig='';render();loadTicker();};
}

export { cfgHTML, headSelf, staleAgainst, wireCfg };
