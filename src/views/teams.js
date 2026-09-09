import { S } from '../state.js';
import { favIndex, saveFavs, toggleFav } from '../account.js';
import { wireCards } from '../components/gamecard.js';
import { leaderSectionHTML, newsSectionHTML, openLeaderDetail, wireLeaderSection, wireNewsSection } from '../components/dashboard.js';
import { openPlayer, rosterHTML, wirePlayers } from '../components/modal.js';
import { API, CORE, LEAGUES, WIKI } from '../config.js';
import { fetchNFLLeaderGroup, fetchNFLNews, resolveNFLSeason } from '../nfl.js';
import { $, esc, gameTime, get, initials, logoOf, oddsLine, store, teamName, ymd } from '../util.js';

/* ========================= TEAMS ========================= */
function renderTeamsShell(){
  const btns=S.MY_TEAMS.length?S.MY_TEAMS.map((t,i)=>'<button class="teambtn '+(S.activeTeam&&String(S.activeTeam.id)===String(t.id)&&S.activeTeam.league===t.league?'on':'')+'" data-i="'+i+'">'+
    '<img src="'+esc(t.logo||logoOf({id:t.id},t.league))+'" alt="" onerror="this.style.display=\'none\'">'+
    esc(t.short||t.name)+'<span class="x" data-rm="'+i+'">&times;</span></button>').join('')
    :'<div class="msg" style="padding:6px 0;text-align:left">No favorites yet &mdash; search below and tap the star.</div>';
  const keys=Object.keys(LEAGUES);
  $('#main').innerHTML='<div class="grouplabel">My teams</div><div class="teampick">'+btns+'</div>'+
    '<div class="browse"><select id="brLeague"><option value="all">All leagues</option>'+
    keys.map(k=>'<option value="'+k+'">'+esc(LEAGUES[k].label)+'</option>').join('')+'</select>'+
    '<input id="brSearch" placeholder="Search any team, any league..." autocomplete="off">'+
    '<span id="brNote" style="font-family:\'Roboto Mono\',monospace;font-size:10.5px;color:var(--dim-2)"></span></div>'+
    '<div class="hits" id="hits"></div><div id="teamBody"></div>';
  document.querySelectorAll('[data-rm]').forEach(x=>x.onclick=e=>{e.stopPropagation();S.MY_TEAMS.splice(+x.dataset.rm,1);saveFavs();renderTeamsShell();});
  document.querySelectorAll('.teambtn').forEach(b=>b.onclick=()=>{
    if(b.dataset.i===undefined)return;
    S.activeTeam=S.MY_TEAMS[+b.dataset.i];S.teamTab='schedule';S.showAllGames=false;renderTeamsShell();});
  $('#brLeague').value=S.searchScope;
  $('#brLeague').onchange=()=>{S.searchScope=$('#brLeague').value;$('#hits').innerHTML='';loadTeamList();};
  $('#brSearch').oninput=()=>runSearch();
  loadTeamList();
  // in-flight and finished are different states: one blocks a second run, the other stops
  // it being started again on every re-render of this tab
  if(!S.allLeaguesLoading&&!S.allLeaguesDone){S.allLeaguesLoading=true;loadAllLeagues();}
  if(S.activeTeam)loadTeam();else $('#teamBody').innerHTML='<div class="msg">Pick a team for schedule, roster, and player profiles.</div>';
}

const SEARCH_LEAGUES=['nfl','ncaaf','nba','wnba','ncaam','ncaaw','mlb','nhl',
  'soc:eng.1','soc:esp.1','soc:ger.1','soc:ita.1','soc:fra.1','soc:usa.1','soc:uefa.champions'];

function slimTeam(t){return {id:String(t.id),displayName:teamName(t),
  shortDisplayName:t.shortDisplayName||'',abbreviation:t.abbreviation||''};}

function cacheKey(lg){return 'sb-teams-'+lg;}

function readTeamCache(lg){
  try{
    const raw=store(cacheKey(lg));if(!raw)return null;
    const o=JSON.parse(raw);
    if(!o||!o.t||!o.list||Date.now()-o.t>30*86400000)return null;
    return o.list;
  }catch(e){return null;}
}

function writeTeamCache(lg,list){try{store(cacheKey(lg),JSON.stringify({t:Date.now(),list:list}));}catch(e){}}

/* pull every team out of the core API, following its pagination */
async function coreTeams(L,onProgress){
  const p=L.path.split('/'),out=[];
  let page=1,pages=1;
  while(page<=pages&&page<=8){
    const d=await get(CORE+'/sports/'+p[0]+'/leagues/'+p[1]+'/teams?limit=100&page='+page);
    pages=d.pageCount||1;
    const refs=(d.items||[]).map(x=>x&&x.$ref).filter(Boolean);
    if(!refs.length)break;
    for(let i=0;i<refs.length;i+=40){
      const b=await Promise.all(refs.slice(i,i+40).map(u=>get(u.replace('http://','https://')).catch(()=>null)));
      b.filter(Boolean).forEach(t=>{if(t.id)out.push(t);});
      if(onProgress)onProgress(out.length);
    }
    page++;
  }
  return out;
}

async function ensureTeams(lg,onProgress){
  if(S.teamCache[lg])return S.teamCache[lg];
  const cached=readTeamCache(lg);
  if(cached&&cached.length){S.teamCache[lg]=cached;return cached;}
  const L=LEAGUES[lg];if(!L)return [];
  // fast paths first
  for(const u of [API+'/'+L.path+'/teams?limit=1000',API+'/'+L.path+'/teams']){
    try{
      const d=await get(u);
      let list=[];
      const sp=d.sports&&d.sports[0],lgs=sp&&sp.leagues&&sp.leagues[0];
      if(lgs&&lgs.teams)list=lgs.teams.map(x=>x.team||x);
      else if(d.teams)list=d.teams.map(x=>x.team||x);
      list=dedupeTeams(list).map(slimTeam);
      if(list.length>1){S.teamCache[lg]=list;writeTeamCache(lg,list);return list;}
    }catch(e){}
  }
  // slow but reliable path
  try{
    const raw=await coreTeams(L,onProgress);
    const list=dedupeTeams(raw).map(slimTeam);
    if(list.length){S.teamCache[lg]=list;writeTeamCache(lg,list);return list;}
  }catch(e){}
  return [];
}

function dedupeTeams(list){
  const seen={};
  return (list||[]).filter(t=>{if(!t||!t.id||seen[t.id])return false;seen[t.id]=1;return true;})
    .sort((a,b)=>teamName(a).localeCompare(teamName(b)));
}

async function loadTeamList(force){
  const sel=$('#brLeague');if(!sel)return;
  const lg=sel.value,note=$('#brNote');
  if(lg==='all'){
    const have=SEARCH_LEAGUES.filter(k=>S.teamCache[k]||readTeamCache(k)).length;
    note.textContent=have+'/'+SEARCH_LEAGUES.length+' leagues ready';
    SEARCH_LEAGUES.forEach(k=>{const c=readTeamCache(k);if(c&&!S.teamCache[k])S.teamCache[k]=c;});
    runSearch();
    return;
  }
  if(force)delete S.teamCache[lg];
  const L=LEAGUES[lg];if(!L){note.textContent='';return;}
  if(S.teamCache[lg]){note.textContent=S.teamCache[lg].length+' teams';runSearch();return;}
  note.textContent='loading teams\u2026';
  const list=await ensureTeams(lg,n=>{note.textContent='loading teams\u2026 '+n;});
  note.innerHTML=list.length?(list.length+' teams'):
    (esc(L.label)+' list unavailable <button class="chip sm" id="tlRetry" style="padding:2px 8px">Retry</button>');
  if($('#tlRetry'))$('#tlRetry').onclick=()=>loadTeamList(true);
  runSearch();
}

/* Runs for a while \u2014 fifteen league lists, some of which fall back to the paginated core
   API. Leaving the Teams tab and coming back rebuilds the shell, so the note element must
   be looked up each pass rather than captured once: the captured node is detached by then
   and every progress message goes into a node that is no longer in the document. The
   in-flight flag has to be released too, or a run interrupted by a failure leaves search
   permanently showing "loading" with no way to retry. */
async function loadAllLeagues(){
  const note=()=>$('#brNote');
  try{
    for(let i=0;i<SEARCH_LEAGUES.length;i++){
      const k=SEARCH_LEAGUES[i],n=note();
      if(n)n.textContent='loading '+LEAGUES[k].label+' ('+(i+1)+'/'+SEARCH_LEAGUES.length+')\u2026';
      await ensureTeams(k);
      if($('#brLeague')&&$('#brLeague').value==='all')runSearch(true);
    }
    S.allLeaguesDone=true;
    const n=note();if(n)n.textContent='all leagues ready';
  }finally{S.allLeaguesLoading=false;}
}

function runSearch(quiet){
  const inp=$('#brSearch');if(!inp)return;
  const scope=$('#brLeague').value,q=inp.value.trim().toLowerCase(),hits=$('#hits');
  if(q.length<2){hits.innerHTML='';return;}
  const scopes=scope==='all'?SEARCH_LEAGUES:[scope];
  const m=[];
  scopes.forEach(k=>{
    (S.teamCache[k]||[]).forEach(t=>{
      const n=teamName(t).toLowerCase();
      if(n.indexOf(q)!==-1||String(t.abbreviation||'').toLowerCase().indexOf(q)===0)m.push({t:t,lg:k});
    });
  });
  m.sort((a,b)=>{
    const an=teamName(a.t).toLowerCase(),bn=teamName(b.t).toLowerCase();
    return (an.indexOf(q)-bn.indexOf(q))||an.localeCompare(bn);
  });
  const top=m.slice(0,15);
  const missing=scopes.filter(k=>!S.teamCache[k]).length;
  if(!top.length){
    hits.innerHTML='<div class="msg" style="padding:8px 0">'+
      (missing?'Still loading '+missing+' league list'+(missing>1?'s':'')+'\u2026':'No match')+'</div>';
    return;
  }
  hits.innerHTML=top.map(x=>{
    const isf=favIndex(x.lg,x.t.id)>=0;
    return '<div class="hit" data-tid="'+esc(x.t.id)+'" data-hlg="'+esc(x.lg)+'">'+
      '<img src="'+esc(logoOf(x.t,x.lg))+'" alt="" onerror="this.style.visibility=\'hidden\'">'+
      '<span style="flex:1">'+esc(teamName(x.t))+'</span>'+
      '<span style="font-family:\'Roboto Mono\',monospace;font-size:10px;color:var(--dim-2)">'+esc(LEAGUES[x.lg].label)+'</span>'+
      '<span class="favstar '+(isf?'on':'')+'" data-star="'+esc(x.t.id)+'" data-slg="'+esc(x.lg)+'" style="margin:0;padding:3px 9px">'+
      (isf?'\u2605':'\u2606')+'</span></div>';
  }).join('')+(missing&&!quiet?'<div class="msg" style="padding:6px 0;font-size:11px">'+missing+' more league list'+(missing>1?'s':'')+' still loading\u2026</div>':'');
  document.querySelectorAll('[data-star]').forEach(el=>el.onclick=e=>{
    e.stopPropagation();
    const lg=el.dataset.slg,t=(S.teamCache[lg]||[]).find(x=>String(x.id)===el.dataset.star);
    if(!t)return;
    toggleFav({name:teamName(t),short:t.shortDisplayName||teamName(t),league:lg,id:t.id});
    renderTeamsShell();
  });
  document.querySelectorAll('[data-tid]').forEach(el=>el.onclick=()=>{
    const lg=el.dataset.hlg,t=(S.teamCache[lg]||[]).find(x=>String(x.id)===el.dataset.tid);
    if(!t)return;
    S.activeTeam={name:teamName(t),short:teamName(t),league:lg,id:t.id};
    S.teamTab='schedule';S.showAllGames=false;hits.innerHTML='';inp.value='';
    document.querySelectorAll('.teambtn').forEach(b=>b.classList.remove('on'));
    loadTeam();
  });
}

async function loadTeam(){
  const body=$('#teamBody'),t=S.activeTeam;
  if(t.league!=='nfl'&&(S.teamTab==='stats'||S.teamTab==='news'))S.teamTab='schedule';
  body.innerHTML='<div class="msg">Loading '+esc(t.name)+'\u2026</div>';
  try{
    const info=await get(API+'/'+LEAGUES[t.league].path+'/teams/'+t.id).catch(()=>null);
    const ti=info&&info.team;
    const rec=(ti&&ti.record&&ti.record.items&&ti.record.items[0]&&ti.record.items[0].summary)||'';
    const logo=ti&&ti.logos&&ti.logos[0]&&ti.logos[0].href;
    const isf=favIndex(t.league,t.id)>=0;
    body.innerHTML='<div class="teamhero">'+(logo?'<img src="'+esc(logo)+'" alt="">':'')+
      '<div><h2 class="cond">'+esc((ti&&ti.displayName)||t.name)+'</h2><div class="sub">'+
      esc([rec,(ti&&ti.standingSummary)||'',LEAGUES[t.league].label].filter(Boolean).join(' \u00b7 '))+'</div></div>'+
      '<button class="favstar '+(isf?'on':'')+'" id="favBtn">'+(isf?'\u2605 Favorite':'\u2606 Add')+'</button></div>'+
      '<div class="subbar"><button class="chip '+(S.teamTab==='schedule'?'on':'')+'" data-tt="schedule">Schedule</button>'+
      '<button class="chip '+(S.teamTab==='roster'?'on':'')+'" data-tt="roster">Roster</button>'+
      (t.league==='nfl'?'<button class="chip '+(S.teamTab==='stats'?'on':'')+'" data-tt="stats">Stats</button>':'')+
      '<button class="chip '+(S.teamTab==='inj'?'on':'')+'" data-tt="inj">Injuries</button>'+
      (t.league==='nfl'?'<button class="chip '+(S.teamTab==='news'?'on':'')+'" data-tt="news">News</button>':'')+
      '</div>'+
      '<div id="ttBody"><div class="msg">Loading\u2026</div></div>';
    $('#favBtn').onclick=()=>{toggleFav({name:(ti&&ti.displayName)||t.name,short:(ti&&ti.shortDisplayName)||t.short||t.name,
      league:t.league,id:t.id,logo:logo||''});renderTeamsShell();};
    document.querySelectorAll('[data-tt]').forEach(b=>b.onclick=()=>{S.teamTab=b.dataset.tt;loadTeam();});
    if(S.teamTab==='schedule')(t.league==='nfl'?loadNFLTeamSchedule():loadTeamSchedule());else if(S.teamTab==='roster')loadTeamRoster();
    else if(S.teamTab==='stats')loadTeamStats((ti&&ti.displayName)||t.name);
    else if(S.teamTab==='news')loadTeamNews();else loadTeamInjuries();
  }catch(e){body.innerHTML='<div class="msg err">Couldn\'t load this team.</div>';}
}

let teamLeaderRequest=0;

function drawTeamLeaders(label,{categories=[],loading=false,error=null}={}){
  const root=$('#ttBody'),t=S.activeTeam;
  if(!root||!t||t.league!=='nfl'||S.teamTab!=='stats')return;
  root.innerHTML=leaderSectionHTML({scope:'team',label:label+' leaders',season:S.nflLeadersSeason,
    expanded:S.teamLeadersExpanded,filter:S.teamLeadersFilter,categories:categories,loading:loading,error:error});
  wireLeaderSection(root,{
    onToggle:()=>{S.teamLeadersExpanded=!S.teamLeadersExpanded;if(S.teamLeadersExpanded)loadTeamStats(label);else{teamLeaderRequest++;drawTeamLeaders(label);}},
    onFilter:filter=>{S.teamLeadersFilter=filter;loadTeamStats(label);},
    onDetail:definitionId=>openLeaderDetail({scope:'team',label:label+' leaders',season:S.nflLeadersSeason,
      teamId:String(t.id),definitionId:definitionId,onPlayer:id=>openPlayer(id,'football/nfl')}),
    onPlayer:id=>openPlayer(id,'football/nfl')
  });
}

async function loadTeamStats(label){
  const t=S.activeTeam,request=++teamLeaderRequest;
  drawTeamLeaders(label,{loading:S.teamLeadersExpanded});
  if(!S.teamLeadersExpanded)return;
  try{
    const season=S.nflLeadersSeason||await resolveNFLSeason();
    if(request!==teamLeaderRequest||S.activeTeam!==t||S.teamTab!=='stats')return;
    S.nflLeadersSeason=season;
    const categories=await fetchNFLLeaderGroup({season:season,scope:'team',teamId:String(t.id),group:S.teamLeadersFilter});
    if(request!==teamLeaderRequest||S.activeTeam!==t||S.teamTab!=='stats')return;
    drawTeamLeaders(label,{categories:categories});
  }catch(e){if(request===teamLeaderRequest)drawTeamLeaders(label,{error:e});}
}

let teamNewsRequest=0;

async function loadTeamNews(){
  const root=$('#ttBody'),t=S.activeTeam,request=++teamNewsRequest;
  root.innerHTML=newsSectionHTML({loading:true});
  try{
    const articles=await fetchNFLNews({limit:20,teamId:t.id});
    if(request!==teamNewsRequest||S.activeTeam!==t||S.teamTab!=='news')return;
    root.innerHTML=newsSectionHTML({articles,emptyText:'No recent news for this team.'});
    wireNewsSection(root);
  }catch(e){if(request===teamNewsRequest)root.innerHTML=newsSectionHTML({error:e});}
}

async function fetchTeamEvents(t){
  const L=LEAGUES[t.league];if(!L)return {events:[],year:''};
  const base=API+'/'+L.path+'/teams/'+t.id+'/schedule';
  const seen={},all=[];
  const add=d=>((d&&d.events)||[]).forEach(ev=>{if(ev&&ev.id&&!seen[ev.id]){seen[ev.id]=1;all.push(ev);}});

  let year=null;
  try{const first=await get(base);add(first);year=(first.season&&first.season.year)||null;}catch(e){}

  // if the default call already returned fixtures, only fill in that same season's other phases
  if(all.length){
    if(L.kind!=='soccer'&&year){
      const more=await Promise.all([1,2,3].map(s=>get(base+'?season='+year+'&seasontype='+s).catch(()=>null)));
      more.forEach(add);
    }
    all.sort((a,b)=>new Date(a.date)-new Date(b.date));
    return {events:all,year:year||''};
  }

  // nothing came back: guess at the season year (soccer seasons start mid-year)
  const now=new Date();
  const guess=now.getMonth()>=6?now.getFullYear():now.getFullYear()-1;
  const years=[guess,guess+1,now.getFullYear()].filter((v,i,a)=>a.indexOf(v)===i);
  const jobs=[];
  years.forEach(y=>{
    jobs.push(get(base+'?season='+y).catch(()=>null));
    if(L.kind!=='soccer')[1,2,3].forEach(s=>jobs.push(get(base+'?season='+y+'&seasontype='+s).catch(()=>null)));
  });
  (await Promise.all(jobs)).forEach(add);

  // last resort: sweep the league scoreboard across date ranges and pull this team's fixtures out
  if(!all.length){
    const base2=new Date();
    const chunks=[[-60,-1],[0,59],[60,119],[120,179]];
    const res=await Promise.all(chunks.map(c=>{
      const a=new Date(base2);a.setDate(a.getDate()+c[0]);
      const b=new Date(base2);b.setDate(b.getDate()+c[1]);
      return get(API+'/'+L.path+'/scoreboard?dates='+ymd(a)+'-'+ymd(b)+(L.extra||'')).catch(()=>null);
    }));
    res.forEach(d=>((d&&d.events)||[]).forEach(ev=>{
      const cs=(ev.competitions&&ev.competitions[0]&&ev.competitions[0].competitors)||[];
      if(cs.some(c=>c.team&&String(c.team.id)===String(t.id))&&!seen[ev.id]){seen[ev.id]=1;all.push(ev);}
    }));
  }
  all.sort((a,b)=>new Date(a.date)-new Date(b.date));
  return {events:all,year:year||guess};
}

async function loadNFLTeamSchedule(){
  const box=$('#ttBody'),t=S.activeTeam,base=API+'/'+LEAGUES.nfl.path+'/teams/'+t.id+'/schedule';
  try{
    const [reg,post]=await Promise.all([get(base),get(base+'?seasontype=3').catch(()=>null)]);
    const year=(reg.season&&reg.season.year)||'';
    const byeWeek=Number.isInteger(reg.byeWeek)?reg.byeWeek:null;
    const regEvents=(reg.events||[]).filter(e=>e&&e.week&&Number.isInteger(e.week.number));
    const lastWeek=regEvents.reduce((m,e)=>Math.max(m,e.week.number),byeWeek||0);
    let rows='';
    for(let w=1;w<=lastWeek;w++){
      const ev=regEvents.find(e=>e.week.number===w);
      if(ev)rows+='<div class="wk-row"><div class="wk-num">Wk '+w+'</div>'+teamRow(ev,t)+'</div>';
      else if(w===byeWeek)rows+='<div class="wk-row"><div class="wk-num">Wk '+w+'</div><div class="wk-bye">Bye week</div></div>';
    }
    const postEvents=((post&&post.events)||[]).filter(e=>e&&e.week&&Number.isInteger(e.week.number)).sort((a,b)=>a.week.number-b.week.number);
    postEvents.forEach(ev=>{rows+='<div class="wk-row"><div class="wk-num">'+esc((ev.week&&ev.week.text)||'Playoffs')+'</div>'+teamRow(ev,t)+'</div>';});
    box.innerHTML=(year?'<div class="grouplabel">'+esc(year)+' season</div>':'')+
      (rows?'<div class="wk-schedule">'+rows+'</div>':'<div class="msg">No schedule published yet.</div>');
    wireCards();
  }catch(e){box.innerHTML='<div class="msg err">Couldn\'t load the schedule.</div>';}
}

async function loadTeamSchedule(){
  const box=$('#ttBody'),t=S.activeTeam;
  try{
    const r=await fetchTeamEvents(t);
    const all=r.events,year=r.year;
    const now=Date.now(),past=all.filter(e=>new Date(e.date)<now),fut=all.filter(e=>new Date(e.date)>=now);
    let html='';
    if(fut.length)html+='<div class="grouplabel">Upcoming ('+fut.length+')</div>'+(S.showAllGames?fut:fut.slice(0,8)).map(e=>teamRow(e,t)).join('');
    if(past.length)html+='<div class="grouplabel">Results ('+past.length+')</div>'+(S.showAllGames?past.slice().reverse():past.slice().reverse().slice(0,8)).map(e=>teamRow(e,t)).join('');
    if(!all.length)html+='<div class="msg">No fixtures found for '+esc(year)+'. The league may not have published them yet.</div>';
    if(!S.showAllGames&&(fut.length>8||past.length>8))
      html+='<div style="text-align:center;margin-top:14px"><button class="chip" id="showAll">Show all '+all.length+' fixtures</button></div>';
    box.innerHTML=html;
    if($('#showAll'))$('#showAll').onclick=()=>{S.showAllGames=true;loadTeamSchedule();};
    wireCards();
  }catch(e){box.innerHTML='<div class="msg err">Couldn\'t load the schedule.</div>';}
}

function teamRow(ev,t){
  const comp=ev.competitions&&ev.competitions[0];if(!comp)return '';
  const cs=comp.competitors||[];
  const me=cs.find(c=>c.team&&String(c.team.id)===String(t.id))||cs[0],opp=cs.find(c=>c!==me)||cs[1];
  if(!me||!opp)return '';
  const st=comp.status&&comp.status.type&&comp.status.type.state,done=st==='post',live=st==='in',home=me.homeAway==='home';
  let badge='';
  if(done){const w=me.winner===true?'W':(opp.winner===true?'L':'T');badge='<span class="resbadge '+w+'">'+w+'</span>';}
  const sv=x=>(x&&x.score&&(x.score.displayValue!==undefined?x.score.displayValue:x.score))||'';
  const score=(done||live)?esc(sv(me))+'\u2013'+esc(sv(opp)):'';
  const venue=(comp.venue&&comp.venue.fullName)||'';
  const bc=(comp.broadcasts&&comp.broadcasts[0]&&comp.broadcasts[0].media&&comp.broadcasts[0].media.shortName)||'';
  const ol=logoOf(opp.team,t.league);
  const ln=oddsLine(comp);
  return '<div class="game" data-ev="'+esc(ev.id)+'" data-lg="'+esc(t.league)+'"><div class="rows"><div class="trow">'+
    (ol?'<img class="logo" src="'+esc(ol)+'" alt="" onerror="this.style.visibility=\'hidden\'">':'<div class="logo"></div>')+
    '<span class="tname">'+(home?'vs':'@')+' '+esc(teamName(opp.team))+'</span>'+badge+
    '<span class="sc '+(done&&me.winner?'w':'')+'">'+score+'</span></div>'+
    (venue||ln?'<div class="trow"><span class="gsub">'+esc(venue)+'</span>'+(ln?'<span class="odds">'+esc(ln)+'</span>':'')+'</div>':'')+
    '</div><div class="gmeta"><div class="gstatus '+(live?'live':'')+'">'+esc(live?comp.status.type.shortDetail:gameTime(ev.date))+
    '</div><div class="gsub">'+esc(bc)+'</div></div></div>';
}

async function loadTeamInjuries(){
  const box=$('#ttBody'),t=S.activeTeam,L=LEAGUES[t.league];
  box.innerHTML='<div class="msg">Loading injury report\u2026</div>';
  try{
    const d=await get(API+'/'+L.path+'/teams/'+t.id+'/injuries').catch(()=>null);
    const list=[];
    if(d&&d.injuries)d.injuries.forEach(x=>{if(x.athlete)list.push(x);else if(x.injuries)x.injuries.forEach(i=>list.push(i));});
    if(!list.length){box.innerHTML='<div class="msg">No injuries reported (or not published for this league).</div>';return;}
    box.innerHTML='<div class="grouplabel">'+list.length+' listed</div>'+list.map(i=>{
      const a=i.athlete||{};
      const det=[i.status,(i.details&&(i.details.type||i.details.detail)),(i.details&&i.details.returnDate?'ret. '+i.details.returnDate:'')].filter(Boolean).join(' \u00b7 ');
      return '<div class="prow inj" data-aid="'+esc(a.id)+'" data-path="'+esc(L.path)+'">'+
        ((a.headshot&&a.headshot.href)?'<img src="'+esc(a.headshot.href)+'" alt="">':'<div class="ph">'+esc(initials(a.displayName))+'</div>')+
        '<span class="pn">'+esc(a.displayName||'')+'</span><span class="pd">'+esc(det)+'</span></div>';
    }).join('');
    wirePlayers();
  }catch(e){box.innerHTML='<div class="msg">Injury data unavailable for this league.</div>';}
}

/* ---------- roster helpers ---------- */
function normalizeRoster(d){
  const out=[],a=d&&d.athletes;if(!a)return out;
  if(Array.isArray(a)&&a.length&&a[0].items)a.forEach(g=>(g.items||[]).forEach(x=>out.push(x)));
  else if(Array.isArray(a))a.forEach(x=>out.push(x.athlete||x));
  return out.filter(Boolean);
}

function posGroup(a){const p=a.position||{};return (p.parent&&(p.parent.displayName||p.parent.name))||p.displayName||p.name||'Players';}

function playerRow(a,path,cls){
  const pos=(a.position&&(a.position.abbreviation||a.position.name))||'';
  const bits=[a.displayHeight,a.displayWeight,a.age?('Age '+a.age):''].filter(Boolean).join(' \u00b7 ');
  const img=(a.headshot&&(a.headshot.href||a.headshot))||'';
  const nm=a.displayName||a.fullName||'';
  // no ESPN headshot: tag the placeholder so fillRosterPhotos() can look it up in bulk
  const lookup=a.fullName||a.displayName||'';
  return '<div class="prow '+(cls||'')+'" data-aid="'+esc(a.id)+'" data-path="'+esc(path)+'">'+
    (img?'<img src="'+esc(img)+'" alt="">':'<div class="ph"'+(lookup?' data-nm="'+esc(lookup)+'"':'')+'>'+esc(initials(nm))+'</div>')+
    '<span class="jn">'+esc(a.jersey?'#'+a.jersey:'')+'</span>'+
    '<span class="pn">'+esc(nm)+(pos?' <span style="color:var(--dim-2);font-size:11px">'+esc(pos)+'</span>':'')+'</span>'+
    '<span class="pd">'+esc(bits)+'</span></div>';
}

// Bulk headshot lookup for rosters ESPN has no photos for (soccer, mostly).
// Wikipedia takes up to 50 titles per request, so a whole squad costs one call.
// A name alone can resolve to the wrong person, so a photo is only accepted when the
// page's Wikidata description matches the sport. Ambiguous names land on disambiguation
// pages, which carry no image anyway — those fall back to initials.
const KIND_DESC={soccer:/footbal|soccer/,football:/football/,basketball:/basketball/,
  baseball:/baseball/,hockey:/hockey/};

const wikiRosterCache={};

async function wikiPhotosFor(names,kind){
  const want=KIND_DESC[kind],need=[];
  names.forEach(n=>{if(n&&wikiRosterCache[n]===undefined&&need.indexOf(n)<0)need.push(n);});
  for(let i=0;i<need.length;i+=50){
    const chunk=need.slice(i,i+50);
    try{
      const d=await get(WIKI+'?action=query&format=json&origin=*&redirects=1&prop=pageimages%7Cpageterms'+
        '&piprop=thumbnail&pithumbsize=200&wbptterms=description&titles='+encodeURIComponent(chunk.join('|')));
      const q=d.query||{},alias={},byTitle={};
      (q.normalized||[]).forEach(x=>{alias[x.from]=x.to;});
      (q.redirects||[]).forEach(x=>{alias[x.from]=x.to;});
      const pg=q.pages||{};
      Object.keys(pg).forEach(k=>{byTitle[pg[k].title]=pg[k];});
      chunk.forEach(n=>{
        let t=n;for(let h=0;h<4&&alias[t];h++)t=alias[t];   // requested -> normalized -> redirected
        const p=byTitle[t],desc=((p&&p.terms&&p.terms.description)||[''])[0].toLowerCase();
        wikiRosterCache[n]=(p&&p.thumbnail&&(!want||want.test(desc)))?p.thumbnail.source:null;
      });
    }catch(e){chunk.forEach(n=>{wikiRosterCache[n]=null;});}
  }
}

async function fillRosterPhotos(kind){
  const slots=Array.prototype.slice.call(document.querySelectorAll('.prow .ph[data-nm]'));
  if(!slots.length)return;
  await wikiPhotosFor(slots.map(s=>s.dataset.nm),kind);
  slots.forEach(s=>{
    const u=wikiRosterCache[s.dataset.nm];
    if(u&&s.parentNode)s.outerHTML='<img src="'+esc(u)+'" alt="" onerror="this.style.visibility=\'hidden\'">';
  });
}

async function loadTeamRoster(){
  const box=$('#ttBody'),t=S.activeTeam,L=LEAGUES[t.league];
  box.innerHTML='<div class="msg">Loading roster\u2026</div>';
  try{
    const list=normalizeRoster(await get(API+'/'+L.path+'/teams/'+t.id+'/roster'));
    box.innerHTML=list.length?('<div class="grouplabel">'+list.length+' players &mdash; tap for profile</div>'+rosterHTML(list,L.path,L.kind))
      :'<div class="msg">No roster published.</div>';
    wirePlayers();
    fillRosterPhotos(L.kind);
  }catch(e){box.innerHTML='<div class="msg err">Couldn\'t load the roster.</div>';}
}

export { fetchTeamEvents, normalizeRoster, playerRow, posGroup, renderTeamsShell };
