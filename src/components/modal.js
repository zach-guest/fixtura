import { S } from '../state.js';
import { saveLastView } from '../account.js';
import { markNav } from '../app.js';
import { hasDrives, renderDrive, startDriveRefresh, stopDriveRefresh, wireDrive } from './drive.js';
import { API, BAD_IMG, CORE, GEO, LEAGUES, WEB, WIKI, WXAPI, WX_CODES } from '../config.js';
import { $, esc, get, initials, logoOf, num, teamName, titleCase, unslug, wikiArticleUrl, wikiPhoto, wikiSearchUrl } from '../util.js';
import { normalizeRoster, playerRow, posGroup, renderTeamsShell } from '../views/teams.js';

/* ---- stat bucket + position ordering ---- */
const BUCKET_LABELS={offense:'Offense',defense:'Defense',special:'Special Teams',batting:'Batting',pitching:'Pitching',skaters:'Skaters',goalies:'Goalies',other:'Other'};

function bucketOf(name,kind){
  const n=String(name||'').toLowerCase();
  if(kind==='baseball')return /pitch/.test(n)?'pitching':'batting';
  if(kind==='hockey')return /goal(ie|tend|keep)/.test(n)?'goalies':'skaters';
  if(/kick|punt|return/.test(n))return 'special';
  if(/defen|interception|goalkeep|goalie|saves/.test(n))return 'defense';
  if(/pass|rush|receiv|offens|fumble|scoring|shoot/.test(n))return 'offense';
  return 'other';
}

function groupRank(name,kind){
  const n=String(name||'').toLowerCase();
  if(kind==='soccer')return /goal|keeper/.test(n)?0:/defen|back/.test(n)?1:/mid/.test(n)?2:/forward|strik|attack|wing/.test(n)?3:4;
  if(kind==='football')return /offen/.test(n)?0:/defen/.test(n)?1:/special/.test(n)?2:3;
  if(kind==='basketball')return /guard/.test(n)?0:/forward/.test(n)?1:/cent/.test(n)?2:3;
  if(kind==='baseball')return /pitch/.test(n)?0:/catch/.test(n)?1:/infield|base|short/.test(n)?2:/outfield/.test(n)?3:4;
  if(kind==='hockey')return /forward|center|wing/.test(n)?0:/defen/.test(n)?1:/goal/.test(n)?2:3;
  return 0;
}

function rosterHTML(list,path,kind){
  const g={};list.forEach(a=>{const k=posGroup(a);(g[k]=g[k]||[]).push(a);});
  return Object.keys(g).sort((a,b)=>groupRank(a,kind)-groupRank(b,kind)||a.localeCompare(b))
    .map(k=>'<div class="grptitle">'+esc(k)+' ('+g[k].length+')</div>'+
      g[k].sort((x,y)=>(+x.jersey||999)-(+y.jersey||999)).map(a=>playerRow(a,path)).join('')).join('');
}

function wirePlayers(){document.querySelectorAll('[data-aid]').forEach(el=>el.onclick=e=>{e.stopPropagation();openPlayer(el.dataset.aid,el.dataset.path);});}

async function openPlayer(id,path){
  if(!id)return;
  $('#pbackdrop').classList.add('open');document.body.style.overflow='hidden';
  $('#playerInner').innerHTML='<div class="mhead"><button class="mclose" onclick="closePlayer()">&times;</button></div><div class="msg">Loading profile\u2026</div>';
  const p=path.split('/'),coreUrl=CORE+'/sports/'+p[0]+'/leagues/'+p[1]+'/athletes/'+id;
  try{
    const r=await Promise.all([get(WEB+'/'+path+'/athletes/'+id).catch(()=>null),
      get(WEB+'/'+path+'/athletes/'+id+'/bio').catch(()=>null),
      get(WEB+'/'+path+'/athletes/'+id+'/stats').catch(()=>null),
      get(coreUrl).catch(()=>null)]);
    const base=r[0]||{},a=Object.assign({},r[3]||{},base.athlete||base);
    let college='';
    const cref=r[3]&&r[3].college&&r[3].college.$ref;
    if(cref){try{const c=await get(cref.replace('http://','https://'));college=c.name||c.shortName||'';}catch(e){}}
    $('#playerInner').innerHTML=renderPlayer(a,r[2],r[1],college);
    // soccer & anyone missing an ESPN headshot: try Wikipedia
    if(!(a.headshot&&(a.headshot.href||a.headshot))){
      const hint=p[0]==='soccer'?'footballer':(a.team?teamName(a.team):p[1]);
      const hit=await wikiPhoto(a.fullName||a.displayName||'',hint);
      const slot=$('#pPhoto');
      if(hit&&hit.url&&slot)slot.outerHTML='<img id="pPhoto" src="'+esc(hit.url)+'" alt="">';
      // we resolved a real article, so upgrade the search link to point straight at it
      const wl=$('#pWiki');
      if(hit&&hit.title&&wl)wl.href=wikiArticleUrl(hit.title);
    }
  }catch(e){$('#playerInner').innerHTML='<div class="mhead"><button class="mclose" onclick="closePlayer()">&times;</button></div><div class="msg err">Couldn\'t load this player.</div>';}
}

function closePlayer(){$('#pbackdrop').classList.remove('open');if(!$('#backdrop').classList.contains('open'))document.body.style.overflow='';}

function renderPlayer(a,stats,bio,college){
  const img=(a.headshot&&(a.headshot.href||a.headshot))||'';
  const pos=(a.position&&(a.position.displayName||a.position.name))||'';
  const team=(a.team&&teamName(a.team))||'';
  const bp=a.birthPlace?[a.birthPlace.city,a.birthPlace.state,a.birthPlace.country].filter(Boolean).join(', '):'';
  const dob=a.dateOfBirth?new Date(a.dateOfBirth).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}):'';
  const draft=a.draft?(a.draft.displayText||[a.draft.year,a.draft.round&&('Rd '+a.draft.round),a.draft.selection&&('Pick '+a.draft.selection)].filter(Boolean).join(' \u00b7 ')):'';
  const exp=a.experience?(a.experience.displayValue||(a.experience.years!==undefined?a.experience.years+' yrs':'')):'';
  const nm=a.fullName||a.displayName||'';
  const f=[['Height',a.displayHeight],['Weight',a.displayWeight],['Age',a.age],['Born',dob],['Birthplace',bp],
    ['College',college||(a.college&&(a.college.name||a.college))||''],['Experience',exp],['Draft',draft],
    ['Jersey',a.jersey?'#'+a.jersey:''],['Status',(a.status&&(a.status.name||a.status.type))||''],['Debut',a.debutYear]].filter(x=>x[1]);
  let html='<div class="mhead"><button class="mclose" onclick="closePlayer()">&times;</button><div class="phero">'+
    (img?'<img id="pPhoto" src="'+esc(img)+'" alt="">':'<div class="ph" id="pPhoto">'+esc(initials(nm))+'</div>')+
    '<div><h2 class="cond">'+esc(nm)+'</h2><div class="pmeta">'+esc([a.jersey?'#'+a.jersey:'',pos,team].filter(Boolean).join('  \u00b7  '))+'</div>'+
    (nm?'<a id="pWiki" class="wlink" target="_blank" rel="noopener noreferrer" href="'+esc(wikiSearchUrl(nm))+'">Wikipedia \u2197</a>':'')+
    '</div></div></div><div class="mbody">';
  if(f.length)html+='<div class="sublabel">Personal &amp; career details</div><div class="bio">'+
    f.map(x=>'<div><div class="k">'+esc(x[0])+'</div><div class="v">'+esc(x[1])+'</div></div>').join('')+'</div>';
  const th=(bio&&(bio.teamHistory||bio.teams))||[];
  if(th.length)html+='<div class="sublabel">Team history</div><div class="tscroll"><table class="st plain"><thead><tr>'+
    '<th style="text-align:left">Team</th><th style="text-align:left">Seasons</th></tr></thead><tbody>'+
    th.map(t=>'<tr><td style="text-align:left">'+esc(t.displayName||teamName(t.team)||t.name||'')+'</td><td style="text-align:left">'+
      esc((t.seasons&&(t.seasons.displayValue||[t.seasons.start,t.seasons.end].filter(Boolean).join('\u2013')))||'')+'</td></tr>').join('')+'</tbody></table></div>';
  const aw=(bio&&bio.awards)||[];
  if(aw.length)html+='<div class="sublabel">Awards</div><div style="font-size:12.5px;color:var(--dim);line-height:1.9">'+
    aw.map(x=>esc(x.displayName||x.name||'')+(x.season&&x.season.displayValue?' <span style="color:var(--dim-2)">('+esc(x.season.displayValue)+')</span>':'')).join('<br>')+'</div>';
  let wrote=false;
  ((stats&&stats.categories)||[]).forEach(c=>{
    const labels=c.labels||c.names||[],rows=c.statistics||[];
    if(!rows.length||!labels.length)return;wrote=true;
    html+='<div class="sublabel">'+esc(c.displayName||titleCase(c.name))+'</div><div class="tscroll"><table class="st"><thead><tr><th>Season</th><th>Team</th>'+
      labels.map(l=>'<th>'+esc(l)+'</th>').join('')+'</tr></thead><tbody>'+
      rows.map(r=>'<tr><td>'+esc((r.season&&(r.season.displayName||r.season.year))||'')+'</td><td>'+
        esc((r.team&&(r.team.abbreviation||teamName(r.team)))||unslug(r.teamSlug)||'')+'</td>'+
        (r.stats||[]).map(s=>'<td>'+esc(s)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  });
  if(!wrote)html+='<div class="msg">No career stats published for this player.</div>';
  return html+'</div>';
}

/* ========================= GAME DETAIL ========================= */
async function openGame(id,lk){
  if(!id||!LEAGUES[lk])return;
  $('#backdrop').classList.add('open');document.body.style.overflow='hidden';
  $('#modalInner').innerHTML='<div class="msg">Loading game\u2026</div>';
  S.modalTab='box';S.boxTeam=0;S.boxFilter='all';S.rosterTeam=0;S.lineupTeam=0;S.driveOpen=-1;S.lastAnimPlay=null;stopDriveRefresh();S.gameRosters=null;S.venueHTML=null;
  try{
    const data=await get(API+'/'+LEAGUES[lk].path+'/summary?event='+id);
    S.modalData={data:data,kind:LEAGUES[lk].kind,path:LEAGUES[lk].path,lk:lk,id:id};
    drawModal();
  }catch(e){$('#modalInner').innerHTML='<div class="msg err">Couldn\'t load this game.</div>';}
}

function closeModal(){stopDriveRefresh();$('#backdrop').classList.remove('open');document.body.style.overflow='';}

function drawModal(){
  const data=S.modalData.data,h=data.header;
  const comp=h&&h.competitions&&h.competitions[0],cs=(comp&&comp.competitors)||[];
  const home=cs.find(c=>c.homeAway==='home')||cs[0],away=cs.find(c=>c.homeAway==='away')||cs[1];
  const stype=comp&&comp.status&&comp.status.type,live=stype&&stype.state==='in',pre=stype&&stype.state==='pre';
  const tb=(t,r)=>{if(!t)return '';
    const lg=logoOf(t.team,S.modalData.lk);
    const rec=(t.record&&t.record[0]&&t.record[0].displayValue)||(t.records&&t.records[0]&&t.records[0].summary)||'';
    return '<div class="mteam gototeam" data-tid="'+esc(t.team&&t.team.id)+'" style="cursor:pointer;'+(r?'flex-direction:row-reverse;text-align:right':'')+'" title="Open team page">'+
      (lg?'<img src="'+esc(lg)+'" alt="" onerror="this.style.visibility=\'hidden\'">':'')+
      '<div style="min-width:0"><div class="n">'+esc(teamName(t.team))+'</div><div class="r">'+esc(rec)+'</div></div>'+
      (pre?'':'<div class="p '+(t.winner?'w':'')+'">'+esc(num(t.score))+'</div>')+'</div>';};
  const gi=data.gameInfo||{};
  const venue=(gi.venue&&gi.venue.fullName)||(comp&&comp.venue&&comp.venue.fullName)||'';
  const ad=gi.venue&&gi.venue.address,city=ad?[ad.city,ad.state].filter(Boolean).join(', '):'';
  const bc=(comp&&comp.broadcasts&&comp.broadcasts[0]&&comp.broadcasts[0].media&&comp.broadcasts[0].media.shortName)||'';
  const l3=[bc&&'TV: '+bc,gi.attendance&&'Att: '+Number(gi.attendance).toLocaleString(),
    (data.pickcenter&&data.pickcenter[0]&&data.pickcenter[0].details)&&'Line: '+data.pickcenter[0].details].filter(Boolean).join('   \u00b7   ');
  const tabs=[['box','Box Score'],['lineup','Lineups'],['roster','Rosters'],['inj','Injuries'],['team','Team Stats']]
    .concat(hasDrives(data)?[['drive','Drive']]:[])
    .concat([['plays','Plays'],['odds','Odds'],['venue','Venue'],['info','Info']]);
  if(!tabs.some(t=>t[0]===S.modalTab))S.modalTab='box';
  $('#modalInner').innerHTML='<div class="mhead"><button class="mclose" onclick="closeModal()">&times;</button>'+
    '<div class="mscore">'+tb(away,false)+'<div class="mmid"><div class="st '+(live?'live':'')+'">'+esc((stype&&stype.shortDetail)||'')+'</div></div>'+tb(home,true)+'</div>'+
    '<div class="minfo">'+esc(comp?new Date(comp.date).toLocaleString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):'')+
    (venue?'<br>'+esc(venue)+(city?' \u00b7 '+esc(city):''):'')+(l3?'<br>'+esc(l3):'')+'</div></div>'+
    '<div class="mtabs">'+tabs.map(t=>'<button class="'+(t[0]===S.modalTab?'on':'')+'" data-t="'+t[0]+'">'+t[1]+'</button>').join('')+'</div>'+
    '<div class="mbody" id="mbody"></div>';
  document.querySelectorAll('.mtabs button').forEach(b=>b.onclick=()=>{S.modalTab=b.dataset.t;drawModal();});
  document.querySelectorAll('.gototeam').forEach(el=>el.onclick=()=>{
    const id=el.dataset.tid;if(!id)return;
    const c=cs.find(x=>x.team&&String(x.team.id)===String(id));
    closeModal();
    S.activeTeam={name:teamName(c&&c.team),short:teamName(c&&c.team),league:S.modalData.lk,id:id};
    S.teamTab='schedule';S.showAllGames=false;S.view='teams';
    saveLastView();markNav();
    renderTeamsShell();
  });
  drawModalBody();
}

function drawModalBody(){
  const d=S.modalData.data,el=$('#mbody');
  if(S.modalTab!=='drive')stopDriveRefresh();
  if(S.modalTab==='box'){el.innerHTML=renderBox(d,S.modalData.kind);wireBoxControls();wirePlayers();}
  else if(S.modalTab==='lineup')renderLineups();
  else if(S.modalTab==='roster')renderGameRosters();
  else if(S.modalTab==='inj'){el.innerHTML=renderGameInjuries(d);wirePlayers();}
  else if(S.modalTab==='team')el.innerHTML=renderTeamStats(d);
  else if(S.modalTab==='drive'){el.innerHTML=renderDrive(d);wireDrive();startDriveRefresh();}
  else if(S.modalTab==='plays')el.innerHTML=renderPlays(d);
  else if(S.modalTab==='odds')el.innerHTML=renderOdds(d);
  else if(S.modalTab==='venue')renderVenue();
  else{el.innerHTML=renderInfo(d);wirePlayers();}
}

function periodHeads(kind,n){
  const h=[];
  for(let i=1;i<=n;i++){
    if(kind==='soccer')h.push(i===1?'1H':i===2?'2H':'ET');
    else if(kind==='basketball')h.push(i<=4?'Q'+i:'OT'+(i-4));
    else if(kind==='hockey')h.push(i<=3?'P'+i:(i===4?'OT':'SO'));
    else if(kind==='baseball')h.push(String(i));
    else h.push(i<=4?String(i):'OT'+(i-4));
  }
  return h;
}

function renderBox(data,kind){
  let html='';
  const comp=data.header&&data.header.competitions&&data.header.competitions[0],cs=(comp&&comp.competitors)||[];
  const home=cs.find(c=>c.homeAway==='home'),away=cs.find(c=>c.homeAway==='away');
  if(home&&away&&home.linescores&&away.linescores&&home.linescores.length){
    const n=Math.max(home.linescores.length,away.linescores.length),hd=periodHeads(kind,n);
    const rf=t=>{let c='';for(let i=0;i<n;i++){const l=t.linescores[i];c+='<td>'+esc(l?(l.displayValue!==undefined?l.displayValue:l.value):'-')+'</td>';}
      return '<tr><td>'+esc((t.team&&t.team.abbreviation)||'')+'</td>'+c+'<td><b>'+esc(num(t.score))+'</b></td></tr>';};
    html+='<div class="sublabel">'+(kind==='baseball'?'Line score':'Score by period')+'</div><div class="tscroll"><table class="st linescore"><thead><tr><th></th>'+
      hd.map(x=>'<th>'+x+'</th>').join('')+'<th>'+(kind==='baseball'?'R':'T')+'</th></tr></thead><tbody>'+rf(away)+rf(home)+'</tbody></table></div>';
  }
  const players=(data.boxscore&&data.boxscore.players)||[];
  if(!players.length)return html+'<div class="msg">Player stats aren\'t posted for this game yet.</div>';
  if(S.boxTeam>=players.length)S.boxTeam=0;
  const groups=(players[S.boxTeam].statistics||[]).filter(g=>(g.athletes||[]).length);
  const bk={};groups.forEach(g=>bk[bucketOf(g.name,kind)]=1);
  const order=['offense','defense','special','batting','pitching','skaters','goalies','other'];
  html+='<div class="subbar">'+players.map((p,i)=>'<button class="chip sm '+(i===S.boxTeam?'on':'')+'" data-bt="'+i+'">'+
    esc((p.team&&(p.team.abbreviation||teamName(p.team)))||('Team '+(i+1)))+'</button>').join('');
  const avail=order.filter(b=>bk[b]);
  if(avail.length>1)html+='<span class="sep"></span><button class="chip sm '+(S.boxFilter==='all'?'on':'')+'" data-bf="all">All</button>'+
    avail.map(b=>'<button class="chip sm '+(S.boxFilter===b?'on':'')+'" data-bf="'+b+'">'+BUCKET_LABELS[b]+'</button>').join('');
  html+='</div>';
  const show=groups.filter(g=>S.boxFilter==='all'||bucketOf(g.name,kind)===S.boxFilter);
  if(!groups.length)html+='<div class="msg">Stats appear once the game gets underway.</div>';
  else if(!show.length)html+='<div class="msg">No '+(BUCKET_LABELS[S.boxFilter]||'')+' stats for this team.</div>';
  show.forEach(g=>{
    const labels=g.labels||g.keys||[],de=g.descriptions||[];
    html+='<div class="grptitle">'+esc(g.text||titleCase(g.name||''))+'</div><div class="tscroll"><table class="st"><thead><tr><th>Player</th>'+
      labels.map((l,i)=>'<th title="'+esc(de[i]||l)+'">'+esc(l)+'</th>').join('')+'</tr></thead><tbody>'+
      (g.athletes||[]).map(a=>{const at=a.athlete||{},ps=(at.position&&at.position.abbreviation)||'';
        return '<tr><td><span class="lnk" data-aid="'+esc(at.id)+'" data-path="'+esc(S.modalData.path)+'">'+
          esc(at.displayName||at.shortName||'')+'</span>'+(ps?' <span class="pos">'+esc(ps)+'</span>':'')+'</td>'+
          (a.stats||[]).map(s=>'<td>'+esc(s)+'</td>').join('')+'</tr>';}).join('')+
      (g.totals&&g.totals.length?'<tr class="tot"><td>Total</td>'+g.totals.map(s=>'<td>'+esc(s)+'</td>').join('')+'</tr>':'')+
      '</tbody></table></div>';
  });
  return html;
}

function wireBoxControls(){
  document.querySelectorAll('[data-bt]').forEach(b=>b.onclick=()=>{S.boxTeam=+b.dataset.bt;drawModalBody();});
  document.querySelectorAll('[data-bf]').forEach(b=>b.onclick=()=>{S.boxFilter=b.dataset.bf;drawModalBody();});
}

/* ---- lineups ---- */
function isStarter(r){if(r.starter===true)return true;if(r.starter===false)return false;return +(r.formationPlace||0)>0;}

function flatAthlete(r){const a=Object.assign({},r.athlete||r);
  if(!a.jersey&&r.jersey)a.jersey=r.jersey;if(r.position)a.position=r.position;return a;}

function posAbbr(r){const a=r.athlete||r,p=r.position||a.position||{};return String(p.abbreviation||p.name||'').toUpperCase();}

/* split a match position like "CD-L", "RWB", "AM-R" into its base role and which flank it sits on */
function parsePos(ab){
  let a=String(ab||'').toUpperCase().trim(),side=0;
  if(/-L$/.test(a)){side=-1;a=a.replace(/-L$/,'');}
  else if(/-R$/.test(a)){side=1;a=a.replace(/-R$/,'');}
  else if(/^L./.test(a)){side=-1;a=a.slice(1);}
  else if(/^R./.test(a)){side=1;a=a.slice(1);}
  return {base:a.replace(/-/g,''),side:side};
}

function lineOf(ab){
  const b=parsePos(ab).base;
  if(!b)return 'M';
  if(/^G/.test(b))return 'G';
  if(/^(WB|FB|B|CB|CD|D|SW)$/.test(b))return 'D';   // exact matches so DM doesn't get read as D
  if(/M$/.test(b))return 'M';                        // DM, CM, AM, M
  if(/^(F|ST|CF|W|SS|A|CA)$/.test(b))return 'F';
  return 'M';
}

/* wide roles sit further from centre than central ones, so full-backs go outside centre-backs */
function lateral(ab){
  const p=parsePos(ab);
  const wide=/^(B|WB|FB|W|M)$/.test(p.base)?2:1;
  return p.side*wide;
}

/* how advanced a midfielder is, used to split one midfield block into formation rows */
function attackRank(ab){
  const b=parsePos(ab).base;
  if(b==='DM'||b==='CDM')return 0;
  if(/^A/.test(b))return 2;
  return 1;
}

async function renderLineups(){
  const el=$('#mbody'),data=S.modalData.data,path=S.modalData.path,kind=S.modalData.kind;
  const comp=data.header&&data.header.competitions&&data.header.competitions[0],cs=(comp&&comp.competitors)||[];
  if(!cs.length){el.innerHTML='<div class="msg">No lineup data.</div>';return;}
  if(S.lineupTeam>=cs.length)S.lineupTeam=0;
  let src=data.rosters||null;
  if(!src&&data.boxscore&&data.boxscore.players){
    src=data.boxscore.players.map(tb=>{
      const seen={},roster=[];
      (tb.statistics||[]).forEach(g=>(g.athletes||[]).forEach(a=>{
        const id=a.athlete&&a.athlete.id;if(!id||seen[id])return;seen[id]=1;
        roster.push({athlete:a.athlete,starter:a.starter===true,position:a.athlete&&a.athlete.position,jersey:a.athlete&&a.athlete.jersey});}));
      return {team:tb.team,roster:roster};});
  }
  if(!src||!src.length){el.innerHTML='<div class="msg">No confirmed lineup published yet. The Rosters tab has the full squad.</div>';return;}
  let html='<div class="subbar">'+cs.map((c,i)=>'<button class="chip sm '+(i===S.lineupTeam?'on':'')+'" data-lt="'+i+'">'+
    esc(teamName(c.team))+'</button>').join('')+'</div>';
  const blk=src[S.lineupTeam]||src[0],roster=(blk&&(blk.roster||blk.athletes))||[];
  if(!roster.length){el.innerHTML=html+'<div class="msg">No lineup for this team.</div>';
    document.querySelectorAll('[data-lt]').forEach(b=>b.onclick=()=>{S.lineupTeam=+b.dataset.lt;renderLineups();});return;}
  let starters=roster.filter(isStarter).sort((a,b)=>(+a.formationPlace||99)-(+b.formationPlace||99));
  let bench=roster.filter(r=>!isStarter(r));
  const cap=kind==='soccer'?11:(kind==='basketball'?5:null);
  if(cap&&starters.length>cap){bench=starters.slice(cap).concat(bench);starters=starters.slice(0,cap);}
  const formation=blk.formation||'';
  if(kind==='soccer'&&starters.length>=7)html+=pitchHTML(starters,formation,path);
  if(formation)html+='<div class="grptitle">Formation: '+esc(formation)+'</div>';
  if(starters.length)html+='<div class="sublabel">Starting '+(kind==='soccer'?'XI':'lineup')+' ('+starters.length+')</div>'+
    starters.map(r=>playerRow(flatAthlete(r),path,'start')).join('');
  if(bench.length)html+='<div class="sublabel">'+(kind==='soccer'?'Substitutes':'Bench')+' ('+bench.length+')</div>'+
    bench.map(r=>playerRow(flatAthlete(r),path)).join('');
  el.innerHTML=html;
  document.querySelectorAll('[data-lt]').forEach(b=>b.onclick=()=>{S.lineupTeam=+b.dataset.lt;renderLineups();});
  wirePlayers();
}

function pitchHTML(starters,formation,path){
  const fp=r=>+(r.formationPlace||0);
  const grab=k=>starters.filter(r=>lineOf(posAbbr(r))===k);
  const G=grab('G'),D=grab('D'),F=grab('F');
  // order midfielders holding -> attacking so a 4-2-3-1 splits into the right two bands
  const M=grab('M').sort((a,b)=>attackRank(posAbbr(a))-attackRank(posAbbr(b))||fp(a)-fp(b));
  const parts=String(formation||'').split('-').map(Number).filter(n=>n>0);
  let rows;
  if(parts.length>=3&&parts[0]===D.length&&parts[parts.length-1]===F.length&&
     parts.slice(1,-1).reduce((s,n)=>s+n,0)===M.length){
    rows=[G,D];let i=0;parts.slice(1,-1).forEach(n=>{rows.push(M.slice(i,i+n));i+=n;});rows.push(F);
  }else{
    rows=[G,D,M,F];
  }
  rows=rows.filter(r=>r&&r.length).map(r=>r.slice().sort((a,b)=>lateral(posAbbr(a))-lateral(posAbbr(b))||fp(a)-fp(b)));
  const cell=r=>{
    const a=r.athlete||r,seg=String(a.shortName||a.displayName||'').split(' ');
    return '<div class="pp" data-aid="'+esc(a.id)+'" data-path="'+esc(path)+'">'+
      '<div class="num">'+esc(a.jersey||r.jersey||'')+'</div><div class="nm">'+esc(seg[seg.length-1]||'')+'</div>'+
      '<div class="ab">'+esc(posAbbr(r))+'</div></div>';};
  return '<div class="pitch">'+rows.slice().reverse().map(r=>'<div class="pline">'+r.map(cell).join('')+'</div>').join('')+'</div>';
}

/* ---- game rosters + injuries ---- */
async function renderGameRosters(){
  const el=$('#mbody'),data=S.modalData.data,path=S.modalData.path;
  const comp=data.header&&data.header.competitions&&data.header.competitions[0],cs=(comp&&comp.competitors)||[];
  if(!cs.length){el.innerHTML='<div class="msg">No teams found.</div>';return;}
  if(!S.gameRosters){
    el.innerHTML='<div class="msg">Loading rosters\u2026</div>';
    S.gameRosters=await Promise.all(cs.map(c=>get(API+'/'+path+'/teams/'+c.team.id+'/roster').then(normalizeRoster).catch(()=>[])));
  }
  if(S.rosterTeam>=cs.length)S.rosterTeam=0;
  const list=S.gameRosters[S.rosterTeam]||[];
  const inj=(data.injuries||[]).find(x=>x.team&&cs[S.rosterTeam].team&&String(x.team.id)===String(cs[S.rosterTeam].team.id));
  let html='<div class="subbar">'+cs.map((c,i)=>'<button class="chip sm '+(i===S.rosterTeam?'on':'')+'" data-rt="'+i+'">'+
    esc(teamName(c.team))+'</button>').join('')+'</div>';
  if(inj&&inj.injuries&&inj.injuries.length)
    html+='<div class="sublabel">Injury report ('+inj.injuries.length+')</div>'+inj.injuries.map(i=>{
      const a=i.athlete||{};
      return '<div class="prow inj" data-aid="'+esc(a.id)+'" data-path="'+esc(path)+'">'+
        ((a.headshot&&a.headshot.href)?'<img src="'+esc(a.headshot.href)+'" alt="">':'<div class="ph">'+esc(initials(a.displayName))+'</div>')+
        '<span class="pn">'+esc(a.displayName||'')+'</span><span class="pd">'+
        esc([i.status,(i.details&&i.details.type)].filter(Boolean).join(' \u00b7 '))+'</span></div>';}).join('');
  html+=list.length?'<div class="sublabel">Squad ('+list.length+')</div>'+rosterHTML(list,path,S.modalData.kind):'<div class="msg">Roster unavailable.</div>';
  el.innerHTML=html;
  document.querySelectorAll('[data-rt]').forEach(b=>b.onclick=()=>{S.rosterTeam=+b.dataset.rt;renderGameRosters();});
  wirePlayers();
}

function renderGameInjuries(data){
  const inj=data.injuries||[];
  if(!inj.length||!inj.some(t=>t.injuries&&t.injuries.length))return '<div class="msg">No injury report published for this game.</div>';
  return inj.map(t=>{
    if(!t.injuries||!t.injuries.length)return '';
    return '<div class="sublabel">'+esc(teamName(t.team))+' ('+t.injuries.length+')</div>'+t.injuries.map(i=>{
      const a=i.athlete||{};
      const det=[i.status,(i.details&&(i.details.type||i.details.detail)),(i.details&&i.details.returnDate?'ret. '+i.details.returnDate:'')].filter(Boolean).join(' \u00b7 ');
      return '<div class="prow inj" data-aid="'+esc(a.id)+'" data-path="'+esc(S.modalData.path)+'">'+
        ((a.headshot&&a.headshot.href)?'<img src="'+esc(a.headshot.href)+'" alt="">':'<div class="ph">'+esc(initials(a.displayName))+'</div>')+
        '<span class="pn">'+esc(a.displayName||'')+((a.position&&a.position.abbreviation)?' <span style="color:var(--dim-2);font-size:11px">'+esc(a.position.abbreviation)+'</span>':'')+
        '</span><span class="pd">'+esc(det)+'</span></div>';}).join('');
  }).join('');
}

/* ---- venue ---- */
async function renderVenue(){
  const el=$('#mbody'),data=S.modalData.data,gi=data.gameInfo||{};
  const comp=data.header&&data.header.competitions&&data.header.competitions[0];
  const v=gi.venue||(comp&&comp.venue);
  if(!v){el.innerHTML='<div class="msg">No venue information.</div>';return;}
  if(S.venueHTML){el.innerHTML=S.venueHTML;return;}
  el.innerHTML='<div class="msg">Loading venue\u2026</div>';
  let full=v;
  if(v.id){try{full=Object.assign({},v,await get(CORE+'/venues/'+v.id));}catch(e){}}
  const ad=full.address||{},name=full.fullName||'',city=[ad.city,ad.state].filter(Boolean).join(', ');
  let pics=[],extract='';
  try{
    const s=await get(WIKI+'?action=query&list=search&srsearch='+encodeURIComponent(name+' stadium '+(ad.city||''))+
      '&srlimit=1&format=json&origin=*');
    const title=s.query&&s.query.search&&s.query.search[0]&&s.query.search[0].title;
    if(title){
      const p=await get(WIKI+'?action=query&prop=extracts|images|pageimages&exintro=1&explaintext=1&imlimit=60&piprop=original&titles='+
        encodeURIComponent(title)+'&format=json&origin=*');
      const pages=p.query&&p.query.pages,pg=pages&&pages[Object.keys(pages)[0]];
      extract=(pg&&pg.extract)||'';
      if(pg&&pg.original&&pg.original.source)pics.push(pg.original.source);
      const files=((pg&&pg.images)||[]).map(i=>i.title)
        .filter(t=>/\.(jpg|jpeg|png)$/i.test(t)).filter(t=>!BAD_IMG.test(t));
      const scored=files.map(t=>({t:t,s:/interior|inside|pitch|field|stand|panorama|view|bowl|match|during|tribun/i.test(t)?0:1}))
        .sort((a,b)=>a.s-b.s).slice(0,8).map(x=>x.t);
      if(scored.length){
        const ii=await get(WIKI+'?action=query&prop=imageinfo&iiprop=url|size&iiurlwidth=900&titles='+
          encodeURIComponent(scored.join('|'))+'&format=json&origin=*');
        const ip=ii.query&&ii.query.pages;
        if(ip)Object.keys(ip).forEach(k=>{
          const info=ip[k].imageinfo&&ip[k].imageinfo[0];
          if(!info)return;
          if((info.width||0)<600)return;                       // filters out little icons/graphics
          if((info.width||0)/(info.height||1)<0.6)return;       // filters out tall portrait clip-art
          const u=info.thumburl||info.url;
          if(u&&pics.indexOf(u)<0)pics.push(u);
        });
      }
    }
  }catch(e){}
  if(!pics.length&&full.images&&full.images.length)pics=full.images.slice(0,4).map(i=>i.href);
  pics=pics.slice(0,6);
  let html='';
  if(pics.length)html+='<div class="gallery">'+pics.map(u=>'<img src="'+esc(u)+'" alt="'+esc(name)+'" loading="lazy" onerror="this.remove()">').join('')+'</div>';
  html+='<div class="sublabel">'+esc(name||'Venue')+'</div>';
  const f=[['Location',[ad.city,ad.state,ad.country].filter(Boolean).join(', ')],
    ['Capacity',full.capacity?Number(full.capacity).toLocaleString():''],
    ['Surface',full.grass===true?'Grass':(full.grass===false?'Artificial':'')],
    ['Roof',full.indoor===true?'Indoor':(full.indoor===false?'Outdoor':'')],
    ['Attendance',gi.attendance?Number(gi.attendance).toLocaleString():'']].filter(x=>x[1]);
  if(f.length)html+='<div class="bio">'+f.map(x=>'<div><div class="k">'+esc(x[0])+'</div><div class="v">'+esc(x[1])+'</div></div>').join('')+'</div>';
  if(extract)html+='<div class="sublabel">About</div><div class="vtext">'+esc(extract.slice(0,700))+(extract.length>700?'\u2026':'')+'</div>';
  if(ad.city)html+='<div class="sublabel">Conditions</div><div id="wxSlot"><div class="msg">Loading weather\u2026</div></div>';
  S.venueHTML=html;el.innerHTML=html;
  if(ad.city){
    let slot='<div class="msg">Weather unavailable.</div>';
    try{
      const g=await get(GEO+'?name='+encodeURIComponent(ad.city)+'&count=1');
      const loc=g.results&&g.results[0];
      if(loc){
        const w=await get(WXAPI+'?latitude='+loc.latitude+'&longitude='+loc.longitude+
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph');
        const c=w.current||{};
        slot='<div class="wxbox"><div class="t">'+Math.round(c.temperature_2m)+'\u00b0</div><div class="d">'+
          esc(WX_CODES[c.weather_code]||'')+'<br><span>Feels '+Math.round(c.apparent_temperature)+'\u00b0 \u00b7 '+
          c.relative_humidity_2m+'% humidity \u00b7 wind '+Math.round(c.wind_speed_10m)+' mph</span><br><span>'+esc(city)+'</span></div></div>';
      }
    }catch(e){}
    S.venueHTML=html.replace('<div id="wxSlot"><div class="msg">Loading weather\u2026</div></div>','<div id="wxSlot">'+slot+'</div>');
    if($('#wxSlot'))$('#wxSlot').innerHTML=slot;
  }
}

/* ---- team stats / plays / info ---- */
function renderOdds(data){
  const pc=data.pickcenter||[];
  const comp=data.header&&data.header.competitions&&data.header.competitions[0];
  const cs=(comp&&comp.competitors)||[];
  const home=cs.find(c=>c.homeAway==='home'),away=cs.find(c=>c.homeAway==='away');
  const ab=t=>(t&&t.team&&(t.team.abbreviation||teamName(t.team)))||'';
  let html='';
  if(!pc.length)return '<div class="msg">No betting lines published for this game.</div>';
  html+='<div class="sublabel">Lines by sportsbook</div><div class="tscroll"><table class="st"><thead><tr>'+
    '<th>Book</th><th>Spread</th><th>O/U</th><th>'+esc(ab(away))+' ML</th><th>'+esc(ab(home))+' ML</th></tr></thead><tbody>'+
    pc.map(p=>{
      const ao=p.awayTeamOdds||{},ho=p.homeTeamOdds||{};
      const ml=o=>(o.moneyLine!==undefined&&o.moneyLine!==null)?(o.moneyLine>0?'+'+o.moneyLine:o.moneyLine):(o.moneyLineOdds||'');
      return '<tr><td>'+esc((p.provider&&p.provider.name)||'')+'</td><td>'+esc(p.details||(p.spread!==undefined?p.spread:''))+
        '</td><td>'+esc(p.overUnder!==undefined?p.overUnder:'')+'</td><td>'+esc(ml(ao))+'</td><td>'+esc(ml(ho))+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  const p0=pc[0];
  if(p0){
    const rows=[];
    if(p0.awayTeamOdds){
      const o=p0.awayTeamOdds;
      rows.push([ab(away),o.favorite?'Favorite':'Underdog',
        (o.spreadOdds!==undefined?String(o.spreadOdds):''),(o.underdog?'Dog':'')]);
    }
    if(p0.homeTeamOdds){
      const o=p0.homeTeamOdds;
      rows.push([ab(home),o.favorite?'Favorite':'Underdog',
        (o.spreadOdds!==undefined?String(o.spreadOdds):''),(o.underdog?'Dog':'')]);
    }
    if(rows.length)html+='<div class="sublabel">'+esc((p0.provider&&p0.provider.name)||'Primary book')+'</div>'+
      rows.map(r=>'<div class="teamstat"><span class="v a">'+esc(r[0])+'</span><span class="lbl">'+esc(r[1])+
        '</span><span class="v h">'+esc(r[2])+'</span></div>').join('');
  }
  if(data.againstTheSpread&&data.againstTheSpread.length){
    html+='<div class="sublabel">Against the spread</div><div class="tscroll"><table class="st plain"><thead><tr>'+
      '<th style="text-align:left">Team</th><th>W</th><th>L</th><th>P</th></tr></thead><tbody>'+
      data.againstTheSpread.map(t=>{
        const r=(t.records&&t.records[0])||{};
        return '<tr><td style="text-align:left">'+esc(teamName(t.team))+'</td><td>'+esc(r.wins!==undefined?r.wins:'')+
          '</td><td>'+esc(r.losses!==undefined?r.losses:'')+'</td><td>'+esc(r.pushes!==undefined?r.pushes:'')+'</td></tr>';
      }).join('')+'</tbody></table></div>';
  }
  return html;
}

function renderTeamStats(data){
  const t=(data.boxscore&&data.boxscore.teams)||[];
  if(t.length<2)return '<div class="msg">Team stats not available.</div>';
  const a=t[0].statistics||[],b=t[1].statistics||[];
  if(!a.length)return '<div class="msg">Team stats not available.</div>';
  let html='<div class="teamstat" style="border-bottom:1px solid var(--line)"><span class="v a" style="color:var(--accent)">'+
    esc((t[0].team&&t[0].team.abbreviation)||'')+'</span><span class="lbl"></span><span class="v h" style="color:var(--accent)">'+
    esc((t[1].team&&t[1].team.abbreviation)||'')+'</span></div>';
  a.forEach((s,i)=>{const m=b.find(x=>x.name===s.name)||b[i];
    html+='<div class="teamstat"><span class="v a">'+esc(s.displayValue)+'</span><span class="lbl">'+esc(s.label||titleCase(s.name))+
      '</span><span class="v h">'+esc(m?m.displayValue:'')+'</span></div>';});
  return html;
}

function renderPlays(data){
  const sc=data.scoringPlays||[],key=data.keyEvents||[],all=data.plays||[];let html='';
  if(sc.length)html+='<div class="sublabel">Scoring plays</div>'+sc.slice().reverse().map(p=>{
    const per=(p.period&&(p.period.displayValue||('Q'+p.period.number)))||'';
    const clk=[per,p.clock&&p.clock.displayValue].filter(Boolean).join(' ');
    const s=(p.awayScore!==undefined&&p.homeScore!==undefined)?(p.awayScore+'\u2013'+p.homeScore):'';
    return '<div class="play score"><span class="clk">'+esc(clk)+'</span><span class="txt">'+esc(p.text||'')+
      (s?'<span class="pts">'+esc(s)+'</span>':'')+'</span></div>';}).join('');
  if(key.length)html+='<div class="sublabel">Key events</div>'+key.slice().reverse().slice(0,30).map(p=>{
    const who=(p.athletesInvolved||[]).map(x=>x.displayName).join(', ');
    return '<div class="play"><span class="clk">'+esc((p.clock&&p.clock.displayValue)||'')+'</span><span class="txt">'+
      esc(p.text||(p.type&&p.type.text)||'')+(who?' \u2014 '+esc(who):'')+'</span></div>';}).join('');
  if(!sc.length&&!key.length&&all.length)html+='<div class="sublabel">Recent plays</div>'+all.slice(-45).reverse().map(p=>{
    const clk=[p.period&&p.period.number?'P'+p.period.number:'',p.clock&&p.clock.displayValue].filter(Boolean).join(' ');
    return '<div class="play '+(p.scoringPlay?'score':'')+'"><span class="clk">'+esc(clk)+'</span><span class="txt">'+esc(p.text||'')+'</span></div>';}).join('');
  return html||'<div class="msg">No play data for this game.</div>';
}

/* Summary standings are inconsistent: event 401872656 currently supplies
   `entry.team` as "Buffalo", while other summaries inline a team object or only
   leave a team reference. Keep this local to the standings presentation rather
   than fetching each row just to turn a stable provider identifier into a label. */
function standingsTeamLabel(entry){
  const team=entry&&entry.team;
  const text=[
    typeof team==='string'?team:'',
    team&&team.displayName,team&&team.shortDisplayName,team&&team.name,
    entry&&entry.displayName,entry&&entry.shortDisplayName,entry&&entry.name,
    entry&&entry.teamName,entry&&entry.teamSlug,entry&&entry.note,
  ].find(value=>typeof value==='string'&&value.trim());
  if(text)return text.trim();
  const ref=(team&&typeof team==='object'&&(team.$ref||team.ref||team.href))||(entry&&(entry.teamRef||entry.teamHref||entry.$ref));
  if(typeof ref==='string'){
    const slug=ref.match(/\/name\/[^/?#]+\/([^/?#]+)(?:[/?#]|$)/i)||ref.match(/\/teams?\/([^/?#]+)(?:[/?#]|$)/i);
    if(slug&&slug[1]&&!/^\d+$/.test(slug[1])){
      try{return unslug(decodeURIComponent(slug[1]).replace(/[_-]+/g,'-'));}catch(e){return unslug(slug[1].replace(/[_-]+/g,'-'));}
    }
  }
  return 'Team unavailable';
}

function renderInfo(data){
  let html='';
  if(data.leaders&&data.leaders.length){
    html+='<div class="sublabel">Game leaders</div>';
    data.leaders.forEach(t=>(t.leaders||[]).forEach(cat=>{
      const top=cat.leaders&&cat.leaders[0];if(!top)return;
      html+='<div class="teamstat"><span style="flex:1;text-align:left;font-size:12.5px"><span class="lnk" data-aid="'+
        esc(top.athlete&&top.athlete.id)+'" data-path="'+esc(S.modalData.path)+'" style="cursor:pointer">'+
        esc((top.athlete&&top.athlete.displayName)||'')+'</span> <span style="color:var(--dim-2);font-family:\'Roboto Mono\',monospace;font-size:10.5px">'+
        esc((t.team&&t.team.abbreviation)||'')+'</span></span><span style="font-family:\'Roboto Mono\',monospace;color:var(--dim);font-size:11.5px">'+
        esc(cat.displayName)+': '+esc(top.displayValue)+'</span></div>';}));
  }
  const gi=data.gameInfo||{};
  if(gi.officials&&gi.officials.length)html+='<div class="sublabel">Officials</div><div style="font-size:12.5px;color:var(--dim);line-height:1.8">'+
    gi.officials.map(o=>esc(o.displayName)+((o.position&&o.position.displayName)?' <span style="color:var(--dim-2)">('+esc(o.position.displayName)+')</span>':'')).join('<br>')+'</div>';
  if(data.standings&&data.standings.groups&&data.standings.groups.length){
    html+='<div class="sublabel">Standings</div>';
    data.standings.groups.forEach(g=>{
      const en=(g.standings&&g.standings.entries)||[];if(!en.length)return;
      html+='<div class="grptitle">'+esc(g.header||'')+'</div><div class="tscroll"><table class="st plain"><thead><tr>'+
        '<th style="text-align:left">Team</th><th>W</th><th>L</th><th>PCT</th></tr></thead><tbody>'+
        en.map(e=>{const f=n=>{const s=(e.stats||[]).find(x=>x.name===n);return s?s.displayValue:'';};
          return '<tr><td style="text-align:left">'+esc(standingsTeamLabel(e))+'</td><td>'+esc(f('wins'))+'</td><td>'+
            esc(f('losses'))+'</td><td>'+esc(f('winPercent'))+'</td></tr>';}).join('')+'</tbody></table></div>';});
  }
  if(data.article&&data.article.headline)html+='<div class="sublabel">Recap</div><div style="font-size:13px;line-height:1.6;color:var(--dim)"><b>'+
    esc(data.article.headline)+'</b><br>'+esc(data.article.description||'')+'</div>';
  return html||'<div class="msg">No extra info.</div>';
}

export { closeModal, closePlayer, drawModalBody, openGame, openPlayer, rosterHTML, wirePlayers };
window.closePlayer = closePlayer;  // used from an inline onclick= attribute in rendered HTML
window.closeModal = closeModal;  // used from an inline onclick= attribute in rendered HTML
