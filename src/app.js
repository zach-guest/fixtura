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

/* ========================= WELCOME ========================= */
/* A first-visit-only orientation panel, mainly to point at PICK'EM — the one
   feature that needs an invite to be discovered at all (see DECISIONS.md).
   Reuses the game-detail modal's own backdrop/#modalInner rather than adding a
   second one to index.html; nothing else could have it open this early in boot. */
function checkWelcome(){
  try{
    if(store('sb-welcomeseen'))return;
    if(store('sb-pk-pendingjoin'))return;   // an invite link already explains itself
  }catch(e){return;}
  $('#modalInner').innerHTML='<div class="mhead"><button class="mclose" id="welcomeX">&times;</button></div>'+
    '<div class="pktext" style="padding:0 4px 4px">'+
    '<h2 class="cond" style="margin:0 0 8px">Welcome to Fixtura</h2>'+
    '<p class="pktext">Scores, schedules, rosters, stats, F1, and a fixture calendar — one dashboard '+
    'instead of a pile of apps.</p>'+
    '<p class="pktext">One thing worth knowing up front: the <b>PICK’EM</b> tab lets you and friends pick '+
    'winners against each other every week. It needs a quick Google sign-in, and joining a friend’s pool '+
    'is one tap on their invite link.</p>'+
    '<button class="chip" id="welcomeOk">Got it</button></div>';
  $('#backdrop').classList.add('open');document.body.style.overflow='hidden';
  /* Marked seen on SHOW, not on close. This shares the game modal's backdrop, so
     Escape and a backdrop click both go through closeModal(), which knows nothing
     about this panel — recording it in the buttons' own handler meant those two
     exits dismissed the panel and brought it back on the next visit. */
  try{store('sb-welcomeseen','1');}catch(e){}
  const close=()=>{$('#backdrop').classList.remove('open');document.body.style.overflow='';};
  $('#welcomeX').onclick=close;$('#welcomeOk').onclick=close;
}

clock();

setInterval(clock,30000);

initSettings();

renderNav();

render();

loadTicker();

stamp();

checkWelcome();

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
