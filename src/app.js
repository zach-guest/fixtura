import { S } from './state.js';
import { initAuth, initSettings, pullSettings, pushSettings, reloadFromStore, renderAuth, saveLastView, signIn } from './account.js';
import { closeModal, closePlayer } from './components/modal.js';
import { loadTicker } from './components/ticker.js';
// Side-effect-only import: wires the "new version available" banner. Nothing in
// this file calls into updatecheck.js by name — it self-invokes on load — so an
// import driven off the reference graph alone would never pull it in, which is
// exactly how this got dropped the first time the split was generated. The
// original single-file version wired it via the same pattern (an IIFE at the
// bottom of the script), so keep this import even though nothing appears to
// "use" it.
import './components/updatecheck.js';
import { VIEW_LABELS } from './config.js';
import { $, clock, esc, modalOpen, stamp, store } from './util.js';
import { renderCalendar } from './views/calendar.js';
import { loadF1 } from './views/f1.js';
import { refreshGolf, renderGolf } from './views/golf.js';
import { renderPickem } from './views/pickem.js';
import { loadScores, renderScoresShell } from './views/scores.js';
import { renderTeamsShell } from './views/teams.js';

function renderNav(){
  $('#viewNav').innerHTML=S.VIEW_ORDER.map(k=>'<button'+(S.view===k?' class="on"':'')+' data-view="'+k+'">'+
    esc(VIEW_LABELS[k])+'</button>').join('');
  document.querySelectorAll('#viewNav button').forEach(b=>b.onclick=()=>{
    S.view=b.dataset.view;saveLastView();renderNav();render();});
}

function markNav(){document.querySelectorAll('#viewNav button').forEach(x=>x.classList.toggle('on',x.dataset.view===S.view));}

/* ========================= THEME ========================= */
(function(){
  const saved=store('sb-theme')||'paper';
  document.documentElement.setAttribute('data-theme',saved);
  const s=$('#theme');s.value=saved;
  s.onchange=()=>{document.documentElement.setAttribute('data-theme',s.value);store('sb-theme',s.value);pushSettings();};
})();

/* ========================= ROUTER ========================= */
function render(){
  if(S.view==='scores'){renderScoresShell();loadScores();}
  else if(S.view==='calendar')renderCalendar();
  else if(S.view==='teams')renderTeamsShell();
  else if(S.view==='golf')renderGolf();
  else if(S.view==='pickem')renderPickem();
  else loadF1();
}

$('#cfgBtn').onclick=()=>{S.showCfg=!S.showCfg;
  if(S.view!=='scores'&&S.VIEW_ORDER.indexOf('scores')>=0){S.view='scores';saveLastView();markNav();}
  render();};

$('#authBtn').onclick=e=>{
  e.stopPropagation();
  if(!S.me){signIn();return;}
  S.authMenu=!S.authMenu;renderAuth();
};

// Any click outside closes the menu. Registered once, not per render.
document.addEventListener('click',e=>{
  if(!S.authMenu)return;
  if(e.target.closest&&e.target.closest('.authwrap'))return;
  S.authMenu=false;renderAuth();
});

$('#refresh').onclick=()=>{render();loadTicker();stamp();};

$('#autoBtn').onclick=()=>{S.autoRefresh=!S.autoRefresh;
  $('#autoBtn').textContent='Auto-refresh: '+(S.autoRefresh?'on':'off');
  $('#autoBtn').classList.toggle('on',S.autoRefresh);};

$('#backdrop').onclick=e=>{if(e.target.id==='backdrop')closeModal();};

$('#pbackdrop').onclick=e=>{if(e.target.id==='pbackdrop')closePlayer();};

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if($('#pbackdrop').classList.contains('open'))closePlayer();else closeModal();return;}
  if(S.view!=='scores'||modalOpen()||S.liveMode)return;
  const t=document.activeElement&&document.activeElement.tagName;
  if(t==='INPUT'||t==='SELECT')return;
  if(e.key==='ArrowLeft'){S.dateObj.setDate(S.dateObj.getDate()-(S.weekMode?7:1));renderScoresShell();loadScores();}
  if(e.key==='ArrowRight'){S.dateObj.setDate(S.dateObj.getDate()+(S.weekMode?7:1));renderScoresShell();loadScores();}});

clock();

setInterval(clock,30000);

initSettings();

renderNav();

render();

loadTicker();

stamp();

/* Auth resolves after the first paint on purpose: the app is fully usable signed
   out, so nothing should wait on a network round trip to our Worker. If an account
   turns out to have settings, they are applied and the view redrawn. */
initAuth().then(async()=>{
  renderAuth();
  if(!S.me)return;
  if(await pullSettings()){reloadFromStore();renderNav();render();loadTicker();}
}).catch(()=>{});

// The ticker sits above the tab row, so it is on screen on every view — refresh it
// regardless of which one is open. It used to be inside the scores branch, which left
// a bar labelled LIVE showing whatever the scores were when the app was opened.
setInterval(()=>{
  if(!S.autoRefresh||modalOpen())return;
  loadTicker();
  if(S.view==='scores'){loadScores();return;}
  if(S.view==='golf')refreshGolf();
},60000);

export { markNav, render, renderNav };
