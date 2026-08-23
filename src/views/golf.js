import { S } from '../state.js';
import { openPlayer } from '../components/modal.js';
import { API, CORE, GOLF_TOURS, WEBSITE } from '../config.js';
import { $, esc, get } from '../util.js';

/* ========================= GOLF ========================= */
// Golf is a leaderboard, not two teams, so it gets its own renderer rather than
// reusing gameCard(). Competitor.id is the athlete id, so names open the usual profile.
// Leaderboard positions with ties: players sharing a score all get the same rank,
// prefixed T. ESPN leaves status.position empty on finished events, so derive it.
function golfPositions(cs){
  const out=[],n=cs.length;
  for(let i=0;i<n;i++){
    if(cs[i].score===undefined||cs[i].score===null){out.push('');continue;}
    let first=i;while(first>0&&cs[first-1].score===cs[i].score)first--;
    let last=i;while(last<n-1&&cs[last+1].score===cs[i].score)last++;
    out.push((last>first?'T':'')+(first+1));
  }
  return out;
}

/* Course card, live weather, purse and defending champion live on the CORE api, not
   the site scoreboard the leaderboard comes from. `courses[0].holes[]` carries par
   and yardage per hole — real geometry, so hole difficulty needs no third-party
   course data. Cached per event: it changes at most once a round. */
/* Par and yardage never move mid-tournament, but the weather on this record is live, so
   the cache has to expire or the header shows the wind from whenever the tab was opened.
   10 minutes: slow enough that the 60s refresh is a no-op on five ticks out of six. */
const GOLF_COURSE_TTL=600000;

async function ensureGolfCourse(evId){
  if(S.golfCourseFor===evId&&Date.now()-S.golfCourseAt<GOLF_COURSE_TTL)return S.golfCourse;
  try{
    const d=await get(CORE+'/sports/golf/leagues/'+S.golfTour+'/events/'+evId);
    S.golfCourse={course:(d.courses||[])[0]||null,purse:d.displayPurse||'',
      champ:(d.defendingChampion&&d.defendingChampion.athlete&&d.defendingChampion.athlete.displayName)||'',
      playoff:!!d.isCupPlayoff};
  }catch(e){
    // Header detail is a bonus, never a blocker — but now that this refetches, a dropped
    // poll must not blank a card we already hold: par and yardage are still right, only
    // the weather has gone stale. Discard only when there's nothing for this event yet.
    if(S.golfCourseFor!==evId)S.golfCourse=null;
  }
  S.golfCourseFor=evId;S.golfCourseAt=Date.now();
  return S.golfCourse;
}

// par per hole, keyed by hole number
function golfPars(gc){
  const m={};
  ((gc&&gc.course&&gc.course.holes)||[]).forEach(h=>{
    if(h&&h.number!==undefined)m[h.number]={par:h.shotsToPar,yards:h.totalYards};
  });
  return m;
}

/* Hole-by-hole scoring is a PGA / Korn Ferry thing. DP World, LPGA, LIV and Champions
   publish round totals only, so anything hole-level must degrade rather than break. */
function holeEntries(r){return (((r&&r.linescores)||[]).filter(h=>h&&h.value));}

function hasHoleData(cs){return cs.some(c=>(c.linescores||[]).some(r=>holeEntries(r).length>0));}

// Holes played in a round. With no hole detail, a round carrying a score is a finished one.
function playedIn(r){
  const h=holeEntries(r).length;
  if(h)return h;
  return (r&&r.value)?18:0;
}

// Rounds that actually have scores. ESPN pads `linescores` with an empty entry for
// the next round, so a tournament in round 2 reports three.
function activeRounds(cs){
  let n=0;
  cs.forEach(c=>(c.linescores||[]).forEach((r,i)=>{
    if(r&&(r.value||(r.linescores||[]).some(h=>h&&h.value)))n=Math.max(n,i+1);
  }));
  return n;
}

// holes posted in a player's current round — ESPN has no `thru` on the scoreboard
function golfThru(c){
  const ls=c.linescores||[];
  for(let i=ls.length-1;i>=0;i--){
    const n=playedIn(ls[i]);
    if(n)return {round:i+1,holes:n,complete:n>=18};
  }
  return null;
}

function scoreClass(strokes,par){
  if(!strokes||!par)return 'sc';
  const d=strokes-par;
  return d<=-2?'eag':d===-1?'bir':d===0?'sc':d===1?'bog':'dbl';
}

/* Field-wide hole difficulty: average strokes over par across everyone who has
   posted the hole. Real derived analytics from free data — no modelling, no
   fabrication. Needs par from the course card, since the scoreboard omits it. */
function holeDifficulty(cs,pars,roundOnly){
  const agg={};
  cs.forEach(c=>{
    (c.linescores||[]).forEach((rnd,ri)=>{
      if(roundOnly!==undefined&&ri!==roundOnly)return;
      (rnd.linescores||[]).forEach(h=>{
        const p=pars[h.period];
        if(!p||!h.value)return;
        (agg[h.period]=agg[h.period]||[]).push(h.value-p.par);
      });
    });
  });
  return Object.keys(agg).map(k=>{
    const v=agg[k];
    return {hole:+k,par:pars[k].par,yards:pars[k].yards,
            avg:v.reduce((a,b)=>a+b,0)/v.length,n:v.length};
  }).sort((a,b)=>a.hole-b.hole);
}

/* Position now vs position through the previous round. Golf leaderboards are inert
   without this — it's the only thing that shows who is actually moving today.
   Must rank by score TO PAR, never by cumulative strokes: mid-round, a player three
   holes into their round has more strokes than one who hasn't teed off, so ranking
   by strokes buries everyone currently on the course. */
function toPar(v){
  if(v===undefined||v===null||v==='')return null;
  const t=String(v).trim();
  if(t==='E'||t==='e')return 0;
  const n=parseFloat(t.replace('+',''));
  return isNaN(n)?null:n;
}

function golfMovers(cs){
  const rounds=activeRounds(cs);
  if(rounds<2)return [];
  // cumulative to-par through round index `upto`
  const cum=(c,upto)=>{
    let sum=0,any=false;
    (c.linescores||[]).forEach((r,i)=>{
      if(i>upto)return;
      if(!playedIn(r))return;
      const v=toPar(r.displayValue);
      if(v!==null){sum+=v;any=true;}
    });
    return any?sum:null;
  };
  // tie-aware: players on the same score share the better position
  const rank=upto=>{
    const list=cs.map(c=>({id:c.id,t:cum(c,upto)})).filter(x=>x.t!==null).sort((a,b)=>a.t-b.t);
    const m={};
    list.forEach((x,i)=>{
      if(i>0&&list[i-1].t===x.t)m[x.id]=m[list[i-1].id];
      else m[x.id]=i+1;
    });
    return m;
  };
  const before=rank(rounds-2),now=rank(rounds-1);
  return cs.map(c=>{
    const b=before[c.id],n=now[c.id];
    const today=(c.linescores||[])[rounds-1];
    const played=today?playedIn(today):0;
    return {c:c,before:b,now:n,delta:(b&&n)?b-n:null,played:played,
            todayScore:today?today.displayValue:null};
  }).filter(x=>x.delta!==null&&x.played>0);   // only players actually out there today
}

async function renderGolf(){
  const box=$('#main');
  box.innerHTML='<div class="controls"><div class="chips">'+
    GOLF_TOURS.map(t=>'<button class="chip '+(S.golfTour===t[0]?'on':'')+'" data-gt="'+t[0]+'">'+esc(t[1])+'</button>').join('')+
    '</div></div><div id="golfBody"><div class="msg">Loading…</div></div>';
  document.querySelectorAll('[data-gt]').forEach(b=>b.onclick=()=>{S.golfTour=b.dataset.gt;S.golfTab='board';S.golfOpen=null;renderGolf();});
  const body=$('#golfBody');
  try{
    const d=await get(API+'/golf/'+S.golfTour+'/scoreboard');
    const ev=(d.events||[])[0];
    if(!ev){body.innerHTML='<div class="msg">No tournament listed for this tour.</div>';return;}
    S.golfData=ev;
    await ensureGolfCourse(ev.id);
    drawGolf();
  }catch(e){body.innerHTML='<div class="msg err">Couldn\'t load the leaderboard.</div>';}
}

/* Re-pull the leaderboard in place. Keeps the sub-tab, the expanded player and the
   scroll position, so a refresh mid-tournament doesn't yank the view around. The course
   card comes along too — it is TTL-gated, so it costs a request every 10 minutes, not
   every tick, and that is what keeps the wind reading live rather than frozen at open. */
async function refreshGolf(){
  if(S.view!=='golf'||!S.golfData)return;
  let d;
  try{d=await get(API+'/golf/'+S.golfTour+'/scoreboard');}catch(e){return;}
  if(S.view!=='golf')return;
  const ev=(d.events||[])[0];
  if(!ev)return;
  const y=window.scrollY,open=S.golfOpen;
  S.golfData=ev;
  await ensureGolfCourse(ev.id);        // cheap: TTL-gated, so this is a no-op most ticks
  drawGolf();
  window.scrollTo(0,y);
  if(open)loadGolfStats(open);
}

function drawGolf(){
  const body=$('#golfBody');
  if(!body||!S.golfData)return;
  const ev=S.golfData;
  const comp=(ev.competitions||[])[0]||{},cs=comp.competitors||[];
  const st=(ev.status&&ev.status.type&&ev.status.type.description)||'';
  const when=ev.date?new Date(ev.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
  const endW=ev.endDate?new Date(ev.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
  const gc=S.golfCourse,course=gc&&gc.course,wx=course&&course.weather;
  const pars=golfPars(gc);

  let html='<div class="grouplabel">'+esc(ev.name||'')+'</div>'+
    '<div class="sublabel">'+esc([when&&endW&&when!==endW?when+' – '+endW:when,st].filter(Boolean).join('  ·  '))+'</div>';

  // header strip: course, par/yardage, wind, purse
  if(course||wx){
    const bits=[];
    if(course&&course.name)bits.push(['Course',course.name]);
    if(course&&course.shotsToPar)bits.push(['Par',course.shotsToPar+(course.totalYards?'  ·  '+Number(course.totalYards).toLocaleString()+' yds':'')]);
    if(wx&&wx.temperature!==undefined)bits.push(['Conditions',wx.temperature+'°  '+esc(wx.conditionId||'')]);
    if(wx&&wx.windSpeed!==undefined)bits.push(['Wind',wx.windSpeed+' mph '+(wx.windDirection||'')+(wx.gust?'  (G '+wx.gust+')':''),true]);
    if(gc&&gc.purse)bits.push(['Purse',gc.purse]);
    if(gc&&gc.champ)bits.push(['Defending',gc.champ]);
    html+='<div class="ghead">'+bits.map(b=>'<span class="gitem'+(b[2]?' gwx':'')+'">'+esc(b[0])+'<b>'+esc(b[1])+'</b></span>').join('')+'</div>';
  }

  const tabs=[['board','Leaderboard'],['course','Course'],['today','Today']];
  html+='<div class="gtabs">'+
    tabs.map(t=>'<button class="'+(S.golfTab===t[0]?'on':'')+'" data-gsec="'+t[0]+'">'+t[1]+'</button>').join('')+'</div>';

  if(!cs.length)html+='<div class="msg">Field not published yet.</div>';
  else if(S.golfTab==='course')html+=golfCourseHTML(cs,pars);
  else if(S.golfTab==='today')html+=golfTodayHTML(cs);
  else html+=golfBoardHTML(cs,pars);

  body.innerHTML=html;
  document.querySelectorAll('[data-gsec]').forEach(b=>b.onclick=()=>{S.golfTab=b.dataset.gsec;S.golfOpen=null;drawGolf();});
  document.querySelectorAll('[data-gid]').forEach(r=>r.onclick=()=>{
    const id=r.dataset.gid;
    S.golfOpen=(S.golfOpen===id)?null:id;
    drawGolf();
    if(S.golfOpen)loadGolfStats(S.golfOpen);
  });
  document.querySelectorAll('[data-gprof]').forEach(b=>b.onclick=e=>{
    e.stopPropagation();openPlayer(b.dataset.gprof,'golf/'+S.golfTour);
  });
}

function golfBoardHTML(cs,pars){
  const rounds=activeRounds(cs);
  const pos=golfPositions(cs);
  const hasPars=Object.keys(pars).length>0,hasHole=hasHoleData(cs);
  return '<div class="sublabel">Tap a player for their scorecard and round stats</div>'+
    '<div class="tscroll"><table class="st"><thead><tr><th>Pos</th><th style="text-align:left">Player</th>'+
    '<th>Total</th><th>Thru</th>'+Array.from({length:rounds},(_,i)=>'<th>R'+(i+1)+'</th>').join('')+
    '</tr></thead><tbody>'+cs.map((c,ci)=>{
      const a=c.athlete||{},ls=c.linescores||[];
      const flag=(a.flag&&a.flag.href)||'';
      const sc=(c.score===0||c.score==='0')?'E':(c.score===undefined||c.score===null?'':c.score);
      const th=golfThru(c);
      const thru=!th?'':(th.holes===0?'—':th.holes>=18?'F':String(th.holes));
      const open=S.golfOpen===String(c.id);
      let row='<tr'+(c.id?' data-gid="'+esc(c.id)+'" class="'+(open?'gopen':'')+'" style="cursor:pointer"':'')+'>'+
        '<td>'+esc(pos[ci])+'</td>'+
        '<td style="text-align:left"><span class="gcar">\u203a</span>'+(flag?'<img src="'+esc(flag)+'" alt="" style="width:14px;height:10px;object-fit:cover;margin-right:6px;vertical-align:middle" onerror="this.style.display=\'none\'">':'')+
          esc(a.displayName||a.fullName||'')+'</td>'+
        '<td style="color:var(--accent);font-weight:600">'+esc(sc)+'</td>'+
        '<td style="color:var(--dim-2);font-family:\'Roboto Mono\',monospace;font-size:10.5px">'+esc(thru)+'</td>'+
        Array.from({length:rounds},(_,i)=>{
          const r=ls[i]||{};
          const played=playedIn(r);
          if(!played)return '<td></td>';
          // A round in progress carries running strokes (10 after 3 holes), which reads
          // as a score. Show the to-par instead until the round is complete.
          if(played<18)return '<td style="color:var(--accent)">'+esc(r.displayValue||'')+'</td>';
          return '<td>'+esc(r.value!==undefined&&r.value!==null?Math.round(r.value):(r.displayValue||''))+'</td>';
        }).join('')+'</tr>';
      if(open)row+='<tr class="gexp"><td colspan="'+(4+rounds)+'"><div class="gwrap" id="gx-'+esc(c.id)+'">'+
        (!hasHole?'<div class="msg">ESPN doesn\'t publish hole-by-hole scoring for this tour \u2014 only round totals.</div>':
          hasPars?golfScorecardHTML(c,pars):'<div class="msg">Course card unavailable, so holes can\'t be scored against par.</div>')+
        '<div class="gstat" id="gs-'+esc(c.id)+'"><span>Loading round stats…</span></div>'+
        '</div></td></tr>';
      return row;
    }).join('')+'</tbody></table></div>';
}

/* Hole-by-hole card, out/in split, colour-coded against par. Scores come from the
   scoreboard the leaderboard already loaded; par comes from the course card. */
function golfScorecardHTML(c,pars){
  const ls=c.linescores||[];
  if(!ls.length)return '<div class="msg">No rounds posted yet.</div>';
  const nums=[];for(let i=1;i<=18;i++)nums.push(i);
  const head='<tr><th class="lbl">Hole</th>'+nums.slice(0,9).map(n=>'<th>'+n+'</th>').join('')+
    '<th class="tot">OUT</th>'+nums.slice(9).map(n=>'<th>'+n+'</th>').join('')+'<th class="tot">IN</th><th class="tot">TOT</th></tr>';
  const parRow='<tr><td class="lbl">Par</td>'+nums.slice(0,9).map(n=>'<td class="sc">'+(pars[n]?pars[n].par:'')+'</td>').join('')+
    '<td class="tot">'+nums.slice(0,9).reduce((a,n)=>a+((pars[n]&&pars[n].par)||0),0)+'</td>'+
    nums.slice(9).map(n=>'<td class="sc">'+(pars[n]?pars[n].par:'')+'</td>').join('')+
    '<td class="tot">'+nums.slice(9).reduce((a,n)=>a+((pars[n]&&pars[n].par)||0),0)+'</td>'+
    '<td class="tot">'+nums.reduce((a,n)=>a+((pars[n]&&pars[n].par)||0),0)+'</td></tr>';
  const rows=ls.map((rnd,ri)=>{
    const by={};(rnd.linescores||[]).forEach(h=>{by[h.period]=h.value;});
    if(!Object.keys(by).length)return '';   // round not started; ESPN pads these
    const sum=hs=>{let t=0,any=false;hs.forEach(n=>{if(by[n]){t+=by[n];any=true;}});return any?t:'';};
    const cell=n=>{
      const v=by[n];
      if(!v)return '<td class="sc">·</td>';
      return '<td class="'+scoreClass(v,pars[n]&&pars[n].par)+'">'+v+'</td>';
    };
    return '<tr><td class="lbl">R'+(ri+1)+'</td>'+nums.slice(0,9).map(cell).join('')+
      '<td class="tot">'+sum(nums.slice(0,9))+'</td>'+nums.slice(9).map(cell).join('')+
      '<td class="tot">'+sum(nums.slice(9))+'</td><td class="tot">'+sum(nums)+'</td></tr>';
  }).join('');
  return '<div><table class="gsc"><thead>'+head+'</thead><tbody>'+parRow+rows+'</tbody></table></div>';
}

/* Round stats are only on the playersummary endpoint, so they're fetched lazily when
   a row is expanded rather than 50x up front. */
async function loadGolfStats(id){
  const el=document.getElementById('gs-'+id);
  if(!el)return;
  // On rate stats a 0 means "not reported", not a real value. On counting stats it's
  // real, but a row of zeroes is noise, so those are dropped too.
  const RATE={driveDistAvg:1,driveAccuracyPct:1,gir:1,puttsGirAvg:1,sandSaves:1};
  const WANT=[['driveDistAvg','Drive'],['driveAccuracyPct','Fairways %'],['gir','GIR %'],
    ['puttsGirAvg','Putts/GIR'],['sandSaves','Sand save %'],['eagles','Eagles'],
    ['birdies','Birdies'],['pars','Pars'],['bogeys','Bogeys'],['doubleBogeysAndWorse','DBL+'],
    ['penalties','Penalties']];
  try{
    const d=await get(WEBSITE+'/golf/'+S.golfTour+'/leaderboard/'+S.golfData.id+'/playersummary?player='+id);
    const by={};(d.stats||[]).forEach(x=>{if(x&&x.name)by[x.name]=x.displayValue;});
    const out=WANT.filter(w=>{
        const v=by[w[0]];
        if(v===undefined||v==='')return false;
        const n=parseFloat(String(v).replace(/[^0-9.\-]/g,''));
        return isFinite(n)&&n!==0;      // "-" and 0 both mean "not reported" here
      })
      .map(w=>'<span>'+esc(w[1])+'<b>'+esc(by[w[0]])+'</b></span>').join('');
    if(document.getElementById('gs-'+id))
      document.getElementById('gs-'+id).innerHTML=(out||'<span>No round stats posted yet.</span>')+
        '<span style="margin-left:auto"><button class="chip" data-gprof="'+esc(id)+'" style="padding:2px 9px;font-size:10px">Full profile</button></span>';
    document.querySelectorAll('[data-gprof]').forEach(b=>b.onclick=e=>{
      e.stopPropagation();openPlayer(b.dataset.gprof,'golf/'+S.golfTour);
    });
  }catch(e){
    const t=document.getElementById('gs-'+id);
    if(t)t.innerHTML='<span>Round stats unavailable for this player.</span>';
  }
}

function golfCourseHTML(cs,pars){
  if(!Object.keys(pars).length)return '<div class="msg">Course card unavailable for this event.</div>';
  if(!hasHoleData(cs))return golfCardOnlyHTML(pars);
  const rows=holeDifficulty(cs,pars);
  if(!rows.length)return '<div class="msg">No holes posted yet \u2014 difficulty appears once scores are in.</div>';
  const max=Math.max.apply(null,rows.map(r=>Math.abs(r.avg)).concat([0.01]));
  const ranked=rows.slice().sort((a,b)=>b.avg-a.avg);
  const rankOf={};ranked.forEach((r,i)=>{rankOf[r.hole]=i+1;});
  return '<div class="sublabel">Hole difficulty — field average vs par, all rounds (rank 1 = hardest)</div>'+
    '<div class="tscroll"><table class="st"><thead><tr><th>Hole</th><th>Par</th><th>Yards</th>'+
    '<th>Avg vs par</th><th>Harder \u2190 \u2192 Easier</th><th>Rank</th><th>Players</th></tr></thead><tbody>'+
    rows.map(r=>{
      // the bar gets its own column so it can't sit under the number
      const w=(Math.abs(r.avg)/max)*48;
      const bar=Math.abs(r.avg)<0.005?'':'<span class="gbar '+(r.avg>0?'hard':'easy')+'" style="'+
        (r.avg>0?'right:50%':'left:50%')+';width:'+w.toFixed(1)+'%"></span>';
      return '<tr><td>'+r.hole+'</td><td>'+r.par+'</td><td>'+(r.yards||'')+'</td>'+
        '<td class="gdiff" style="color:var(--'+(r.avg>0?'loss':(r.avg<0?'win':'dim-2'))+')">'+
        (r.avg>0?'+':'')+r.avg.toFixed(3)+'</td>'+
        '<td class="ghole">'+bar+'</td>'+
        '<td>'+rankOf[r.hole]+'</td><td style="color:var(--dim-2)">'+r.n+'</td></tr>';
    }).join('')+'</tbody></table></div>'+
    '<div class="sublabel">Hardest: '+ranked[0].hole+' ('+(ranked[0].avg>0?'+':'')+ranked[0].avg.toFixed(2)+
    ')  ·  Easiest: '+ranked[ranked.length-1].hole+' ('+ranked[ranked.length-1].avg.toFixed(2)+')</div>';
}

/* No field hole-scoring on this tour, but the course card is real and still useful:
   par and yardage per hole, out/in totals. */
function golfCardOnlyHTML(pars){
  const nums=[];for(let i=1;i<=18;i++)if(pars[i])nums.push(i);
  if(!nums.length)return '<div class="msg">Course card unavailable for this event.</div>';
  const sum=(f,l)=>nums.filter(n=>n>=f&&n<=l).reduce((a,n)=>a+(pars[n].par||0),0);
  const yds=(f,l)=>nums.filter(n=>n>=f&&n<=l).reduce((a,n)=>a+(pars[n].yards||0),0);
  return '<div class="msg">ESPN doesn\'t publish hole-by-hole scoring for this tour \u2014 only round totals.</div>'+
    '<div class="sublabel">Course card</div><div class="tscroll"><table class="st"><thead><tr>'+
    '<th>Hole</th><th>Par</th><th>Yards</th></tr></thead><tbody>'+
    nums.map(n=>'<tr><td>'+n+'</td><td>'+pars[n].par+'</td><td>'+(pars[n].yards||'')+'</td></tr>').join('')+
    '<tr><td><b>OUT</b></td><td><b>'+sum(1,9)+'</b></td><td><b>'+yds(1,9)+'</b></td></tr>'+
    '<tr><td><b>IN</b></td><td><b>'+sum(10,18)+'</b></td><td><b>'+yds(10,18)+'</b></td></tr>'+
    '<tr><td><b>TOTAL</b></td><td><b>'+sum(1,18)+'</b></td><td><b>'+yds(1,18)+'</b></td></tr>'+
    '</tbody></table></div>';
}

function golfTodayHTML(cs){
  const mv=golfMovers(cs);
  if(!mv.length)return '<div class="msg">Movers appear once a second round is underway.</div>';
  const up=mv.filter(m=>m.delta>0).sort((a,b)=>b.delta-a.delta).slice(0,10);
  const dn=mv.filter(m=>m.delta<0).sort((a,b)=>a.delta-b.delta).slice(0,10);
  const rounds=activeRounds(cs);
  const best=cs.map(c=>({c:c,r:(c.linescores||[])[rounds-1]}))
    .filter(x=>x.r&&x.r.value&&playedIn(x.r)>=18)
    .sort((a,b)=>a.r.value-b.r.value).slice(0,10);
  const name=c=>esc((c.athlete&&(c.athlete.displayName||c.athlete.fullName))||'');
  // Show how far through the round they are: a big move from a player 3 holes in
  // is not the same story as one from a player who has signed their card.
  const mvCell=(x,dir)=>'<span class="gmove'+(dir==='dn'?' dn':'')+'">'+(dir==='dn'?'▼ ':'▲ ')+Math.abs(x.delta)+'</span>'+
    '  <span style="color:var(--dim-2)">'+x.before+' → '+x.now+'</span>'+
    '  <span style="color:var(--dim-2)">('+(x.played>=18?'F':'thru '+x.played)+
    (x.todayScore?', '+esc(x.todayScore):'')+')</span>';
  const anyDone=best.length>0;
  const tbl=(label,list,fmt)=>!list.length?'':'<div class="sublabel">'+label+'</div>'+
    '<div class="tscroll"><table class="st"><tbody>'+list.map(x=>
      '<tr><td style="text-align:left">'+name(x.c)+'</td><td style="text-align:right">'+fmt(x)+'</td></tr>').join('')+
    '</tbody></table></div>';
  return (anyDone?tbl('Best round today',best,x=>'<b style="color:var(--accent)">'+esc(x.r.displayValue||x.r.value)+'</b>')
                 :'<div class="sublabel">Best round today</div><div class="msg">Nobody has finished the round yet.</div>')+
    tbl('Moving up',up,x=>mvCell(x,'up'))+
    tbl('Sliding back',dn,x=>mvCell(x,'dn'));
}

export { refreshGolf, renderGolf };
