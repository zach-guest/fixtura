import { S } from '../state.js';
import { ERG } from '../config.js';
import { $, esc, get, stamp } from '../util.js';

/* ========================= F1 ========================= */
async function loadF1(){
  const m=$('#main');m.innerHTML='<div class="msg">Loading F1 season\u2026</div>';
  try{
    const r=await Promise.all([get(ERG+'/current.json?limit=100').catch(()=>null),
      get(ERG+'/current/driverStandings.json').catch(()=>null),
      get(ERG+'/current/constructorStandings.json').catch(()=>null),
      get(ERG+'/current/last/results.json').catch(()=>null)]);
    const races=(r[0]&&r[0].MRData&&r[0].MRData.RaceTable&&r[0].MRData.RaceTable.Races)||[];
    S.f1Season=races;
    const now=Date.now();
    const nextIdx=races.findIndex(x=>new Date(x.date+'T'+(x.time||'00:00:00Z'))>=now);
    let html='';
    const next=nextIdx>=0?races[nextIdx]:null;
    if(next){
      const dt=new Date(next.date+'T'+(next.time||'00:00:00Z'));
      html+='<div class="grouplabel">Next race \u2014 Round '+esc(next.round)+'</div><div class="teamhero"><div><h2 class="cond">'+
        esc(next.raceName)+'</h2><div class="sub">'+esc(next.Circuit.circuitName)+' \u00b7 '+esc(next.Circuit.Location.locality)+', '+
        esc(next.Circuit.Location.country)+'<br>'+esc(dt.toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}))+'</div></div></div>';
      const ss=[['Practice 1',next.FirstPractice],['Practice 2',next.SecondPractice],['Practice 3',next.ThirdPractice],
        ['Sprint',next.Sprint],['Qualifying',next.Qualifying],['Race',{date:next.date,time:next.time}]].filter(s=>s[1]&&s[1].date);
      html+='<div class="tscroll"><table class="st plain"><thead><tr><th style="text-align:left">Session</th><th>Your local time</th></tr></thead><tbody>'+
        ss.map(s=>{const d=new Date(s[1].date+'T'+(s[1].time||'00:00:00Z'));
          return '<tr><td style="text-align:left">'+esc(s[0])+'</td><td>'+esc(d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+'</td></tr>';}).join('')+'</tbody></table></div>';
    }
    if(races.length){
      html+='<div class="grouplabel">Full '+esc((r[0].MRData.RaceTable.season)||'')+' calendar &mdash; tap a completed race for results</div>'+
        '<div class="tscroll"><table class="st plain"><thead><tr><th style="text-align:left">Rd</th><th style="text-align:left">Grand Prix</th>'+
        '<th style="text-align:left">Circuit</th><th>Date</th></tr></thead><tbody>'+
        races.map(x=>{
          const d=new Date(x.date+'T'+(x.time||'00:00:00Z'));
          const done=d<now;
          return '<tr class="'+(done?'click':'')+'" '+(done?'data-round="'+esc(x.round)+'"':'')+'>'+
            '<td style="text-align:left">'+esc(x.round)+'</td><td style="text-align:left">'+esc(x.raceName)+
            (done?' <span style="color:var(--dim-2)">\u2713</span>':(next&&x.round===next.round?' <span style="color:var(--accent)">NEXT</span>':''))+'</td>'+
            '<td style="text-align:left">'+esc(x.Circuit.Location.locality)+', '+esc(x.Circuit.Location.country)+'</td>'+
            '<td>'+esc(d.toLocaleDateString('en-US',{month:'short',day:'numeric'}))+'</td></tr>'+
            '<tr id="f1r'+esc(x.round)+'" style="display:none"><td colspan="4" style="padding:0"></td></tr>';
        }).join('')+'</tbody></table></div>';
    }
    const lr=r[3]&&r[3].MRData&&r[3].MRData.RaceTable.Races[0];
    if(lr)html+='<div class="grouplabel">Most recent \u2014 '+esc(lr.raceName)+'</div>'+resultsTable(lr.Results,15);
    const ds=r[1]&&r[1].MRData&&r[1].MRData.StandingsTable.StandingsLists[0];
    if(ds)html+='<div class="grouplabel">Driver standings</div><div class="tscroll"><table class="st plain"><thead><tr>'+
      '<th style="text-align:left">Pos</th><th style="text-align:left">Driver</th><th style="text-align:left">Team</th><th>Wins</th><th>Pts</th></tr></thead><tbody>'+
      ds.DriverStandings.map(d=>'<tr><td style="text-align:left">'+esc(d.position)+'</td><td style="text-align:left">'+
        esc(d.Driver.givenName+' '+d.Driver.familyName)+'</td><td style="text-align:left">'+esc((d.Constructors[0]||{}).name||'')+
        '</td><td>'+esc(d.wins)+'</td><td><b>'+esc(d.points)+'</b></td></tr>').join('')+'</tbody></table></div>';
    const c2=r[2]&&r[2].MRData&&r[2].MRData.StandingsTable.StandingsLists[0];
    if(c2)html+='<div class="grouplabel">Constructor standings</div><div class="tscroll"><table class="st plain"><thead><tr>'+
      '<th style="text-align:left">Pos</th><th style="text-align:left">Team</th><th>Wins</th><th>Pts</th></tr></thead><tbody>'+
      c2.ConstructorStandings.map(c=>'<tr><td style="text-align:left">'+esc(c.position)+'</td><td style="text-align:left">'+
        esc(c.Constructor.name)+'</td><td>'+esc(c.wins)+'</td><td><b>'+esc(c.points)+'</b></td></tr>').join('')+'</tbody></table></div>';
    m.innerHTML=html||'<div class="msg">No F1 data available.</div>';
    document.querySelectorAll('[data-round]').forEach(tr=>tr.onclick=()=>toggleRace(tr.dataset.round));
    stamp();
  }catch(e){m.innerHTML='<div class="msg err">Couldn\'t load F1 data.</div>';}
}

function resultsTable(res,limit){
  return '<div class="tscroll"><table class="st plain"><thead><tr><th style="text-align:left">Pos</th><th style="text-align:left">Driver</th>'+
    '<th style="text-align:left">Team</th><th>Grid</th><th>Laps</th><th>Time / Status</th><th>Pts</th></tr></thead><tbody>'+
    res.slice(0,limit||30).map(x=>'<tr><td style="text-align:left">'+esc(x.positionText||x.position)+'</td>'+
      '<td style="text-align:left">'+esc(x.Driver.givenName+' '+x.Driver.familyName)+'</td>'+
      '<td style="text-align:left">'+esc(x.Constructor.name)+'</td><td>'+esc(x.grid)+'</td><td>'+esc(x.laps)+'</td>'+
      '<td>'+esc((x.Time&&x.Time.time)||x.status)+'</td><td>'+esc(x.points)+'</td></tr>').join('')+'</tbody></table></div>';
}

async function toggleRace(round){
  const row=$('#f1r'+round);if(!row)return;
  const cell=row.firstElementChild;
  if(row.style.display!=='none'){row.style.display='none';return;}
  row.style.display='';
  if(S.f1Open[round]){cell.innerHTML=S.f1Open[round];return;}
  cell.innerHTML='<div class="msg">Loading results\u2026</div>';
  try{
    const r=await Promise.all([get(ERG+'/current/'+round+'/results.json').catch(()=>null),
      get(ERG+'/current/'+round+'/qualifying.json').catch(()=>null)]);
    const race=r[0]&&r[0].MRData&&r[0].MRData.RaceTable.Races[0];
    let h='<div style="padding:10px 12px">';
    if(race&&race.Results&&race.Results.length)h+='<div class="sublabel">Race result</div>'+resultsTable(race.Results,30);
    const q=r[1]&&r[1].MRData&&r[1].MRData.RaceTable.Races[0];
    if(q&&q.QualifyingResults&&q.QualifyingResults.length)
      h+='<div class="sublabel">Qualifying</div><div class="tscroll"><table class="st plain"><thead><tr><th style="text-align:left">Pos</th>'+
        '<th style="text-align:left">Driver</th><th>Q1</th><th>Q2</th><th>Q3</th></tr></thead><tbody>'+
        q.QualifyingResults.map(x=>'<tr><td style="text-align:left">'+esc(x.position)+'</td><td style="text-align:left">'+
          esc(x.Driver.givenName+' '+x.Driver.familyName)+'</td><td>'+esc(x.Q1||'')+'</td><td>'+esc(x.Q2||'')+'</td><td>'+esc(x.Q3||'')+'</td></tr>').join('')+
        '</tbody></table></div>';
    if(!race&&!q)h+='<div class="msg">No results published.</div>';
    h+='</div>';
    S.f1Open[round]=h;cell.innerHTML=h;
  }catch(e){cell.innerHTML='<div class="msg err">Couldn\'t load that race.</div>';}
}

export { loadF1 };
