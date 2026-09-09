import { S } from '../state.js';
import { gameCard, sortEvents, wireCards } from '../components/gamecard.js';
import { leaderSectionHTML, openLeaderDetail, wireLeaderSection } from '../components/dashboard.js';
import { openPlayer } from '../components/modal.js';
import { cfgHTML, wireCfg } from '../components/settings.js';
import { API, LEAGUES, LIVE_SCAN, PRIMARY, SOCCER_GROUPS } from '../config.js';
import { fetchNFLLeaderGroup, resolveNFLSeason } from '../nfl.js';
import { $, dayKey, dayLabel, esc, get, inputDate, stamp, weekBounds, ymd } from '../util.js';

/* ========================= SCORES ========================= */
function renderScoresShell(){
  let html=S.showCfg?cfgHTML():'';
  html+='<div class="controls"><div class="chips">'+
    '<button class="chip livechip '+(S.liveMode?'on':'')+'" data-live="1">\u25CF LIVE NOW</button>'+
    PRIMARY.map(p=>'<button class="chip '+(!S.liveMode&&S.league===p[0]?'on':'')+'" data-lg="'+p[0]+'">'+p[1]+'</button>').join('')+
    '</div><div class="datenav">'+
    (S.liveMode?'':'<button id="mode">'+(S.weekMode?'Week':'Day')+'</button><button id="prev">&lsaquo;</button>'+
      '<input type="date" id="dpick" value="'+inputDate(S.dateObj)+'"><button id="today">Today</button><button id="next">&rsaquo;</button>')+
    '</div></div>';
  if(!S.liveMode&&S.league==='soccer'){
    html+='<div class="subchips"><button class="chip sm '+(S.socMode==='club'?'on':'')+'" data-sm="club">Club</button>'+
      '<button class="chip sm '+(S.socMode==='international'?'on':'')+'" data-sm="international">International</button></div>'+
      '<div class="subchips"><button class="chip sm '+(S.socFilter==='all'?'on':'')+'" data-sf="all">All</button>'+
      SOCCER_GROUPS[S.socMode].map(g=>'<button class="chip sm '+(S.socFilter===g.country?'on':'')+'" data-sf="'+esc(g.country)+'">'+esc(g.country)+'</button>').join('')+'</div>';
  }
  const lbl=S.liveMode?'LIVE RIGHT NOW':(S.weekMode?(()=>{const b=weekBounds(S.dateObj);
    return 'WEEK OF '+b[0].toLocaleDateString('en-US',{month:'short',day:'numeric'})+' \u2013 '+b[1].toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});})():dayLabel(S.dateObj));
  if(!S.liveMode&&S.league==='nfl')html+='<div id="nflLeaders"></div>';
  html+='<div class="daylabel cond">'+lbl+'</div><div id="games"><div class="msg">Loading...</div></div>';
  $('#main').innerHTML=html;
  if(S.showCfg)wireCfg();
  document.querySelectorAll('[data-live]').forEach(b=>b.onclick=()=>{S.liveMode=!S.liveMode;renderScoresShell();loadScores();});
  document.querySelectorAll('[data-lg]').forEach(c=>c.onclick=()=>{S.liveMode=false;S.league=c.dataset.lg;renderScoresShell();loadScores();});
  document.querySelectorAll('[data-sm]').forEach(c=>c.onclick=()=>{S.socMode=c.dataset.sm;S.socFilter='all';renderScoresShell();loadScores();});
  document.querySelectorAll('[data-sf]').forEach(c=>c.onclick=()=>{S.socFilter=c.dataset.sf;renderScoresShell();loadScores();});
  if($('#mode'))$('#mode').onclick=()=>{S.weekMode=!S.weekMode;renderScoresShell();loadScores();};
  if($('#prev'))$('#prev').onclick=()=>{S.dateObj.setDate(S.dateObj.getDate()-(S.weekMode?7:1));renderScoresShell();loadScores();};
  if($('#next'))$('#next').onclick=()=>{S.dateObj.setDate(S.dateObj.getDate()+(S.weekMode?7:1));renderScoresShell();loadScores();};
  if($('#today'))$('#today').onclick=()=>{S.dateObj=new Date();renderScoresShell();loadScores();};
  if($('#dpick'))$('#dpick').onchange=e=>{const p=e.target.value.split('-');S.dateObj=new Date(+p[0],+p[1]-1,+p[2]);renderScoresShell();loadScores();};
  if($('#nflLeaders')){if(S.nflLeadersExpanded)loadNFLLeaders();else drawNFLLeaders();}
}

let nflLeaderRequest=0;

function drawNFLLeaders({categories=[],loading=false,error=null}={}){
  const root=$('#nflLeaders');
  if(!root||S.liveMode||S.league!=='nfl')return;
  root.innerHTML=leaderSectionHTML({scope:'league',label:'Across the NFL',season:S.nflLeadersSeason,
    expanded:S.nflLeadersExpanded,filter:S.nflLeadersFilter,categories:categories,loading:loading,error:error});
  wireLeaderSection(root,{
    onToggle:()=>{S.nflLeadersExpanded=!S.nflLeadersExpanded;if(S.nflLeadersExpanded)loadNFLLeaders();else{nflLeaderRequest++;drawNFLLeaders();}},
    onFilter:filter=>{S.nflLeadersFilter=filter;loadNFLLeaders();},
    onDetail:definitionId=>openLeaderDetail({scope:'league',label:'Across the NFL',season:S.nflLeadersSeason,
      definitionId:definitionId,onPlayer:id=>openPlayer(id,'football/nfl')}),
    onPlayer:id=>openPlayer(id,'football/nfl')
  });
}

async function loadNFLLeaders(){
  const request=++nflLeaderRequest;
  drawNFLLeaders({loading:true});
  try{
    const season=S.nflLeadersSeason||await resolveNFLSeason();
    if(request!==nflLeaderRequest||!$('#nflLeaders')||S.liveMode||S.league!=='nfl')return;
    S.nflLeadersSeason=season;
    const categories=await fetchNFLLeaderGroup({season:season,scope:'league',group:S.nflLeadersFilter});
    if(request!==nflLeaderRequest||!$('#nflLeaders')||S.liveMode||S.league!=='nfl')return;
    drawNFLLeaders({categories:categories});
  }catch(e){if(request===nflLeaderRequest)drawNFLLeaders({error:e});}
}

function dateParam(){
  if(!S.weekMode)return ymd(S.dateObj);
  const b=weekBounds(S.dateObj);return ymd(b[0])+'-'+ymd(b[1]);
}

function groupByDay(evs,lk){
  const m={};evs.forEach(e=>{const k=dayKey(e.date);(m[k]=m[k]||[]).push(e);});
  return Object.keys(m).sort().map(k=>{
    const d=new Date(k+'T12:00:00');
    return '<div class="grouplabel">'+esc(d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'}))+
      ' ('+m[k].length+')</div>'+sortEvents(m[k]).map(e=>gameCard(e,lk)).join('');
  }).join('');
}

async function loadScores(){
  const box=$('#games');
  if(S.liveMode)return loadLive(box);
  if(S.league==='soccer')return loadSoccerScores(box);
  const L=LEAGUES[S.league];
  try{
    const d=await get(API+'/'+L.path+'/scoreboard?dates='+dateParam()+(L.extra||''));
    if(S.league==='nfl'&&Number.isInteger(d&&d.season&&d.season.year))S.nflLeadersSeason=d.season.year;
    const evs=d.events||[];
    box.innerHTML=evs.length?(S.weekMode?groupByDay(evs,S.league):sortEvents(evs).map(e=>gameCard(e,S.league)).join(''))
      :'<div class="msg">No '+L.label+' games in this '+(S.weekMode?'week':'date')+'</div>';
    wireCards();stamp();
  }catch(e){box.innerHTML='<div class="msg err">Couldn\'t load '+L.label+'.</div>';}
}

async function loadSoccerScores(box){
  const groups=SOCCER_GROUPS[S.socMode].filter(g=>S.socFilter==='all'||g.country===S.socFilter);
  const jobs=[];groups.forEach(g=>g.comps.forEach(c=>jobs.push({g:g.country,c:c})));
  box.innerHTML='<div class="msg">Loading '+jobs.length+' competitions...</div>';
  const res=await Promise.all(jobs.map(j=>get(API+'/soccer/'+j.c.k+'/scoreboard?dates='+dateParam())
    .then(d=>({j:j,evs:d.events||[]})).catch(()=>({j:j,evs:[]}))));
  let html='';
  groups.forEach(g=>{
    const mine=res.filter(r=>r.j.g===g.country&&r.evs.length);
    if(!mine.length)return;
    html+='<div class="grouplabel">'+esc(g.country)+'</div>';
    mine.forEach(r=>{html+='<div class="grptitle">'+esc(r.j.c.label)+' ('+r.evs.length+')</div>'+
      sortEvents(r.evs).map(e=>gameCard(e,'soc:'+r.j.c.k)).join('');});
  });
  box.innerHTML=html||'<div class="msg">No matches found.</div>';
  wireCards();stamp();
}

async function loadLive(box){
  box.innerHTML='<div class="msg">Scanning every league for live games...</div>';
  const today=ymd(new Date());
  const res=await Promise.all(LIVE_SCAN.map(k=>{
    const L=LEAGUES[k];if(!L)return Promise.resolve(null);
    return get(API+'/'+L.path+'/scoreboard?dates='+today+(L.extra||'')).then(d=>({k:k,evs:d.events||[]})).catch(()=>null);
  }));
  let html='',total=0;
  res.filter(Boolean).forEach(r=>{
    const live=r.evs.filter(e=>{const c=e.competitions&&e.competitions[0];
      return c&&c.status&&c.status.type&&c.status.type.state==='in';});
    if(!live.length)return;total+=live.length;
    html+='<div class="grouplabel">'+esc(LEAGUES[r.k].label)+' ('+live.length+')</div>'+
      sortEvents(live).map(e=>gameCard(e,r.k)).join('');
  });
  box.innerHTML=total?html:'<div class="msg">Nothing live right now across '+LIVE_SCAN.length+' leagues.</div>';
  wireCards();stamp();
}

export { loadScores, renderScoresShell };
