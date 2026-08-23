import { S } from '../state.js';
import { wireCards } from '../components/gamecard.js';
import { $, dayKey, esc, logoOf, teamName } from '../util.js';
import { fetchTeamEvents } from './teams.js';

/* ========================= CALENDAR ========================= */
async function renderCalendar(){
  const m=$('#main');
  if(!S.MY_TEAMS.length){m.innerHTML='<div class="msg">Add some favorite teams first (Teams tab) and their games will show up here.</div>';return;}
  m.innerHTML='<div class="controls"><div class="chips">'+
    '<button class="chip" id="cPrev">&lsaquo;</button>'+
    '<button class="chip on" id="cLabel">'+esc(S.calMonth.toLocaleDateString('en-US',{month:'long',year:'numeric'}))+'</button>'+
    '<button class="chip" id="cNext">&rsaquo;</button>'+
    '<button class="chip" id="cToday">This month</button></div></div><div id="calBody"><div class="msg">Loading your teams\' schedules...</div></div>';
  $('#cPrev').onclick=()=>{S.calMonth.setMonth(S.calMonth.getMonth()-1);renderCalendar();};
  $('#cNext').onclick=()=>{S.calMonth.setMonth(S.calMonth.getMonth()+1);renderCalendar();};
  $('#cToday').onclick=()=>{S.calMonth=new Date();renderCalendar();};

  if(!S.calCache){
    const all=await Promise.all(S.MY_TEAMS.map(async t=>{
      const key=t.league+':'+t.id;
      if(S.schedCache[key])return S.schedCache[key];
      try{
        const r=await fetchTeamEvents(t);
        const out=r.events.map(ev=>({ev:ev,t:t}));
        S.schedCache[key]=out;return out;
      }catch(e){return [];}
    }));
    S.calCache={};
    all.forEach(list=>list.forEach(x=>{const k=dayKey(x.ev.date);(S.calCache[k]=S.calCache[k]||[]).push(x);}));
  }

  const y=S.calMonth.getFullYear(),mo=S.calMonth.getMonth();
  const first=new Date(y,mo,1),start=new Date(first);start.setDate(1-first.getDay());
  const todayKey=dayKey(new Date());
  let cells='';
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);
    const k=dayKey(d),out=d.getMonth()!==mo;
    const games=(S.calCache[k]||[]).sort((a,b)=>new Date(a.ev.date)-new Date(b.ev.date));
    cells+='<div class="calcell '+(out?'out':'')+' '+(k===todayKey?'today':'')+'"><div class="calnum">'+d.getDate()+'</div>'+
      games.map(g=>{
        const comp=g.ev.competitions&&g.ev.competitions[0],cs=(comp&&comp.competitors)||[];
        const me=cs.find(c=>c.team&&String(c.team.id)===String(g.t.id)),opp=cs.find(c=>c!==me);
        const lo=logoOf(me&&me.team,g.t.league)||g.t.logo||'';
        const home=me&&me.homeAway==='home';
        return '<div class="calgame" data-ev="'+esc(g.ev.id)+'" data-lg="'+esc(g.t.league)+'" title="'+
          esc((g.t.short||g.t.name)+' '+(home?'vs':'@')+' '+teamName(opp&&opp.team))+'">'+
          (lo?'<img src="'+esc(lo)+'" alt="">':'')+'<span>'+esc(home?'vs':'@')+esc((opp&&opp.team&&opp.team.abbreviation)||'')+'</span></div>';
      }).join('')+'</div>';
  }
  $('#calBody').innerHTML='<div class="calgrid">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>'<div class="caldow">'+d+'</div>').join('')+cells+'</div>'+
    '<div class="grouplabel">Showing '+S.MY_TEAMS.length+' favorite teams</div>';
  wireCards();
}

export { renderCalendar };
