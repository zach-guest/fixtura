import { openGame } from './modal.js';
import { esc, gameTimeOnly, isFav, logoOf, num, oddsLine, teamName } from '../util.js';

/* ========================= GAME CARD ========================= */
function gameCard(ev,lk){
  const comp=ev.competitions&&ev.competitions[0];if(!comp)return '';
  const cs=comp.competitors||[];
  const home=cs.find(c=>c.homeAway==='home')||cs[0],away=cs.find(c=>c.homeAway==='away')||cs[1];
  if(!home||!away)return '';
  const st=comp.status&&comp.status.type&&comp.status.type.state,live=st==='in',done=st==='post';
  const status=(comp.status&&comp.status.type&&comp.status.type.shortDetail)||'';
  const fav=isFav(teamName(home.team))||isFav(teamName(away.team));
  const bc=(comp.broadcasts&&comp.broadcasts[0]&&comp.broadcasts[0].names&&comp.broadcasts[0].names.join('/'))||'';
  const venue=(comp.venue&&comp.venue.fullName)||'';
  const ln=oddsLine(comp);
  const row=(t,w)=>'<div class="trow">'+((logoOf(t.team,lk))?'<img class="logo" src="'+esc(logoOf(t.team,lk))+'" alt="" onerror="this.style.visibility=\'hidden\'">':'<div class="logo"></div>')+
    '<span class="tname '+(w?'w':'')+'">'+esc(teamName(t.team))+'</span>'+
    (t.records&&t.records[0]&&t.records[0].summary?'<span class="rec">'+esc(t.records[0].summary)+'</span>':'')+
    '<span class="sc '+(w?'w':'')+'">'+(st==='pre'?'':esc(num(t.score)))+'</span></div>';
  return '<div class="game '+(fav?'fav':'')+'" data-ev="'+esc(ev.id)+'" data-lg="'+esc(lk)+'">'+
    '<div class="rows">'+row(away,done&&away.winner)+row(home,done&&home.winner)+
    (ln?'<div class="trow"><span class="odds">'+esc(ln)+'</span></div>':'')+'</div>'+
    '<div class="gmeta"><div class="gstatus '+(live?'live':'')+'">'+esc(st==='pre'?gameTimeOnly(ev.date):status)+'</div>'+
    '<div class="gsub">'+esc(st==='pre'?[venue,bc].filter(Boolean).join(' \u00b7 '):venue)+'</div></div></div>';
}

function wireCards(){document.querySelectorAll('.game,[data-ev]').forEach(el=>{
  if(el.dataset.ev)el.onclick=()=>openGame(el.dataset.ev,el.dataset.lg);});}

function sortEvents(e){return e.sort((a,b)=>{
  const f=x=>((x.competitions&&x.competitions[0]&&x.competitions[0].competitors)||[]).some(c=>isFav(teamName(c.team)))?0:1;
  const s=x=>(x.competitions&&x.competitions[0]&&x.competitions[0].status&&x.competitions[0].status.type.state)==='in'?0:1;
  return f(a)-f(b)||s(a)-s(b)||new Date(a.date)-new Date(b.date);});}

export { gameCard, sortEvents, wireCards };
