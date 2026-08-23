import { S } from '../state.js';
import { drawModalBody } from './modal.js';
import { API } from '../config.js';
import { $, esc, get, logoOf } from '../util.js';

/* ===== DRIVE VIEW =====
   Live drive chart + win probability, built entirely from the summary?event= payload
   the modal already fetches. ESPN ships `winprobability` (one entry per play) and
   `drives` (current + previous, plays inline) in that same response.
   Note: ESPN gives win probability but NOT EPA — there is no expected-points field
   anywhere in this feed, so don't go looking for one. */

function hasDrives(data){
  if(S.modalData.kind!=='football')return false;
  const d=data.drives;
  return !!((data.winprobability&&data.winprobability.length)||(d&&(d.current||(d.previous&&d.previous.length))));
}

/* Every drive, oldest first, with the in-progress one last.
   ESPN already includes the in-progress drive as the last entry of `previous`, so
   appending `current` blindly renders it twice. Dedupe by id and let `current` win,
   since it's the copy that keeps updating. */
function allDrives(data){
  const d=data.drives||{};
  const out=[],seen={};
  (d.previous||[]).forEach(x=>{if(x){seen[String(x.id)]=out.length;out.push(x);}});
  if(d.current){
    const k=String(d.current.id),i=seen[k];
    if(i!==undefined)out[i]=d.current; else out.push(d.current);
  }
  return out;
}

/* Ball position as a 0..100 fraction of the field, offense always attacking right.
   yardsToEndzone is the only field-position value that doesn't depend on knowing
   whose side of the field you're on, so prefer it and treat yardLine as a fallback. */
function ballPct(sp){
  if(!sp)return null;
  const y=sp.yardsToEndzone;
  if(y===undefined||y===null||isNaN(+y))return null;
  return Math.max(0,Math.min(100,100-(+y)));
}

function driveSpan(dr){
  const ps=(dr&&dr.plays)||[];
  if(!ps.length)return null;
  const a=ballPct(ps[0].start);
  let b=null;
  for(let i=ps.length-1;i>=0&&b===null;i--)b=ballPct(ps[i].end);
  if(a===null&&b===null)return null;
  const lo=a===null?b:a,hi=b===null?a:b;
  return {from:lo,to:hi};
}

function downDistance(sp){
  if(!sp)return '';
  if(sp.shortDownDistanceText)return sp.shortDownDistanceText;
  const ord=['','1st','2nd','3rd','4th'][sp.down];
  if(!ord||sp.distance===undefined||sp.distance===null)return '';
  return ord+' & '+(+sp.distance===0?'Goal':sp.distance);
}

/* team id -> {abbr,color} from the header competitors. ESPN gives colors as bare
   hex with no '#', and omits them for some teams, so guard both. */
/* End zone labels sit on a team's own brand colour, which is arbitrary external
   data — a theme token can't be guaranteed to contrast with it (white on the
   Chargers' powder blue is fine; white on a gold or white primary is not). This is
   the one place a literal colour is correct: it's computed from the fill, not chosen
   as a design value. sRGB relative luminance, per WCAG. */
function onColor(hex){
  const m=/^#?([0-9a-f]{6})$/i.exec(hex||'');
  if(!m)return '#fff';
  const n=parseInt(m[1],16);
  const ch=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{
    const c=v/255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);
  });
  const L=0.2126*ch[0]+0.7152*ch[1]+0.0722*ch[2];
  return L>0.45?'#000':'#fff';
}

function teamColors(data){
  const m={},comp=data.header&&data.header.competitions&&data.header.competitions[0];
  ((comp&&comp.competitors)||[]).forEach(c=>{
    const t=c.team||{};
    let col=t.color||'';
    if(col&&!/^#/.test(col))col='#'+col;
    m[String(t.id)]={abbr:t.abbreviation||'',color:/^#[0-9a-fA-F]{3,8}$/.test(col)?col:'',homeAway:c.homeAway};
  });
  return m;
}

/* scoringPlays[].id matches a play id inside a drive, so a drive's score can be
   named without re-deriving it. The text reads "Jordan Watkins 17 Yd pass from
   Adrian Martinez (Eddy Pineiro Kick)" — the scorer is everything before the
   yardage. On a defensive or return score the scorer is NOT on the drive's team,
   which is correct and worth showing. */
function scorerOf(dr,byPlayId){
  for(const pl of (dr&&dr.plays)||[]){
    const sp=byPlayId[String(pl.id)];
    if(!sp)continue;
    const txt=sp.text||'';
    const m=txt.match(/^([^0-9]+?)\s+\d/);
    const who=m?m[1].trim():'';
    if(who)return who;
  }
  return '';
}

function scoringByPlayId(data){
  const m={};
  (data.scoringPlays||[]).forEach(p=>{if(p&&p.id!==undefined)m[String(p.id)]=p;});
  return m;
}

function wpPct(v){
  if(typeof v!=='number')return '';
  const p=v*100;
  if(p>0&&p<1)return '<1%';
  if(p<100&&p>99)return '>99%';
  return Math.round(p)+'%';
}

function wpByPlay(data){
  const m={};
  (data.winprobability||[]).forEach(w=>{if(w&&w.playId!==undefined)m[String(w.playId)]=w.homeWinPercentage;});
  return m;
}

function wpChartHTML(data){
  const wp=(data.winprobability||[]).filter(w=>w&&typeof w.homeWinPercentage==='number');
  if(wp.length<2)return '';
  const comp=data.header&&data.header.competitions&&data.header.competitions[0];
  const cs=(comp&&comp.competitors)||[];
  const home=cs.find(c=>c.homeAway==='home'),away=cs.find(c=>c.homeAway==='away');
  const W=600,H=96,n=wp.length;
  const x=i=>n<2?0:(i/(n-1))*W;
  const y=p=>H-(Math.max(0,Math.min(1,p))*H);
  let line='',area='M0,'+H;
  wp.forEach((w,i)=>{
    const px=x(i).toFixed(1),py=y(w.homeWinPercentage).toFixed(1);
    line+=(i?'L':'M')+px+','+py;
    area+='L'+px+','+py;
  });
  area+='L'+W+','+H+'Z';
  // Mark scoring plays so the swings have context.
  const idx={};wp.forEach((w,i)=>{idx[String(w.playId)]=i;});
  let marks='';
  (data.scoringPlays||[]).forEach(p=>{
    const i=idx[String(p.id)];
    if(i===undefined)return;
    marks+='<line class="sc" x1="'+x(i).toFixed(1)+'" y1="0" x2="'+x(i).toFixed(1)+'" y2="'+H+'"/>';
  });
  const last=wp[wp.length-1],hp=last.homeWinPercentage;
  // context for the hover readout: clock/period/text per play, keyed by play id
  const meta={};
  allDrives(data).forEach(dr=>((dr.plays)||[]).forEach(pl=>{
    meta[String(pl.id)]={clock:(pl.clock&&pl.clock.displayValue)||'',
      per:(pl.period&&pl.period.number)||'',text:(pl.text||'').trim()};
  }));
  S.wpSeries=wp.map(w=>{
    const m=meta[String(w.playId)]||{};
    return {p:w.homeWinPercentage,clock:m.clock||'',per:m.per||'',text:m.text||''};
  });
  S.wpTeams={home:(home&&home.team&&home.team.abbreviation)||'HOME',away:(away&&away.team&&away.team.abbreviation)||'AWAY'};
  const lg=t=>{const u=t&&logoOf(t.team,S.modalData.lk);return u?'<img src="'+esc(u)+'" alt="" onerror="this.style.display=\'none\'">':'';};
  const pct=wpPct;
  return '<div class="sublabel">Win probability</div><div class="wpwrap">'+
    '<div class="wphead">'+
      '<div class="wpteam">'+lg(away)+esc((away&&away.team&&away.team.abbreviation)||'AWAY')+' <b>'+pct(1-hp)+'</b></div>'+
      '<div class="wpteam"><b>'+pct(hp)+'</b> '+esc((home&&home.team&&home.team.abbreviation)||'HOME')+lg(home)+'</div>'+
    '</div>'+
    '<div class="wpbox">'+
    '<svg class="wpchart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Home win probability over the course of the game">'+
      '<line class="grid" x1="0" y1="0" x2="'+W+'" y2="0"/>'+
      '<line class="mid" x1="0" y1="'+(H/2)+'" x2="'+W+'" y2="'+(H/2)+'"/>'+
      '<line class="grid" x1="0" y1="'+H+'" x2="'+W+'" y2="'+H+'"/>'+
      marks+
      '<path class="fill" d="'+area+'"/><path class="line" d="'+line+'"/>'+
      '<circle class="dot" cx="'+x(n-1).toFixed(1)+'" cy="'+y(hp).toFixed(1)+'" r="3.5"/>'+
    '</svg>'+
    '<div class="wpcur"></div><div class="wpmark"></div><div class="wptip"></div><div class="wphit"></div>'+
    '</div>'+
    '<div class="wpaxis"><span>KICKOFF</span><span>'+esc((home&&home.team&&home.team.abbreviation)||'HOME')+' 50%</span><span>NOW</span></div>'+
  '</div>';
}

/* 100-yard field with end zones, showing the most recent play: where the ball
   started, where it ended, and the line to gain. */
/* The field always shows the offense attacking right, so the end zone on the right
   is the one being attacked. Colour it with the defending team and the left one with
   the offense, and label both — colour alone is ambiguous once possession flips. */
function fieldHTML(play,offenseId,cols){
  if(!play)return '';
  const a=ballPct(play.start),b=ballPct(play.end);
  if(a===null&&b===null)return '';
  const EZ=8,FW=100-EZ*2;
  const px=p=>EZ+(p/100)*FW;
  const to=b===null?a:b,from=a===null?to:a;
  const dist=play.start&&play.start.distance;
  const fd=(play.start&&play.start.down&&dist!==undefined&&dist!==null&&a!==null)?Math.min(100,a+(+dist)):null;

  const ids=Object.keys(cols||{});
  const off=cols&&cols[String(offenseId)];
  const defId=ids.find(k=>k!==String(offenseId));
  const def=defId?cols[defId]:null;
  const ezFill=t=>t&&t.color?' style="fill:'+esc(t.color)+'"':'';

  let g='';
  for(let i=5;i<100;i+=5)g+='<line class="'+(i%10===0?'yd5':'yd')+'" x1="'+px(i).toFixed(2)+'" y1="0" x2="'+px(i).toFixed(2)+'" y2="100"/>';
  if(fd!==null)g+='<line class="fd" x1="'+px(fd).toFixed(2)+'" y1="0" x2="'+px(fd).toFixed(2)+'" y2="100"/>';
  if(a!==null)g+='<line class="los" x1="'+px(a).toFixed(2)+'" y1="0" x2="'+px(a).toFixed(2)+'" y2="100"/>';

  let lab='';
  for(let i=10;i<=90;i+=10)lab+='<span class="fnum" style="left:'+px(i).toFixed(2)+'%">'+(i<=50?i:100-i)+'</span>';
  const ezLab=(t,leftPct)=>t&&t.abbr?'<span class="fez" style="left:'+leftPct+'%;color:'+onColor(t.color)+'">'+esc(t.abbr)+'</span>':'';

  // Data attributes drive the animation: the ball mounts at `from` and the wiring
  // moves it to `to` on the next frame, so the play draws itself.
  const moved=a!==null&&b!==null&&Math.abs(b-a)>0.4;
  const lo=Math.min(from,to),hi=Math.max(from,to);
  return '<div class="fieldwrap"><div class="field" data-from="'+from.toFixed(2)+'" data-to="'+to.toFixed(2)+'" data-play="'+esc(play.id||'')+'">'+
    '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'+
      '<rect class="ez" x="0" y="0" width="'+EZ+'" height="100"'+ezFill(off)+'/>'+
      '<rect class="ez" x="'+(100-EZ)+'" y="0" width="'+EZ+'" height="100"'+ezFill(def)+'/>'+g+
    '</svg>'+lab+ezLab(off,(EZ/2).toFixed(1))+ezLab(def,(100-EZ/2).toFixed(1))+
    (moved?'<div class="fgain'+(to<from?' neg':'')+'" data-lo="'+lo.toFixed(2)+'" data-hi="'+hi.toFixed(2)+'" style="left:'+px(from).toFixed(2)+'%;width:0%"></div>':'')+
    '<div class="fball" style="left:'+px(from).toFixed(2)+'%"></div>'+
  '</div></div>';
}

/* Mount the ball at the play's start, then move it to the end on the next frame.
   Guarded by play id so re-rendering for an unrelated reason (expanding a drive,
   a refresh with no new play) doesn't replay the animation. */

/* Hover anywhere on the chart to read the win probability at that point in the game,
   with the play that produced it. Pointer events cover mouse and touch alike. */
function wireWpHover(){
  const box=document.querySelector('.wpbox');
  if(!box||!S.wpSeries.length)return;
  const hit=box.querySelector('.wphit'),cur=box.querySelector('.wpcur'),
        mark=box.querySelector('.wpmark'),tip=box.querySelector('.wptip');
  const svg=box.querySelector('.wpchart');
  const show=e=>{
    const r=box.getBoundingClientRect();
    if(!r.width)return;
    const fx=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    const i=Math.round(fx*(S.wpSeries.length-1));
    const d=S.wpSeries[i];
    if(!d)return;
    const lx=(S.wpSeries.length<2?0:i/(S.wpSeries.length-1))*r.width;
    const sh=svg.getBoundingClientRect().height;
    const ly=(1-Math.max(0,Math.min(1,d.p)))*sh;
    cur.style.display='block';cur.style.left=lx.toFixed(1)+'px';
    mark.style.display='block';mark.style.left=lx.toFixed(1)+'px';mark.style.top=ly.toFixed(1)+'px';
    const when=[d.per?'Q'+d.per:'',d.clock].filter(Boolean).join(' ');
    tip.innerHTML='<div class="t">'+esc(when||'\u2014')+'</div>'+
      '<div class="v"><b>'+esc(wpPct(d.p))+'</b> '+esc(S.wpTeams.home)+
      '  \u00b7  '+esc(wpPct(1-d.p))+' '+esc(S.wpTeams.away)+'</div>'+
      (d.text?'<div class="p">'+esc(d.text)+'</div>':'');
    tip.style.display='block';
    // Keep the tooltip inside the chart box. A high win probability puts the point
    // near the top, where the default "above the point" placement would cover the
    // header, so flip it below when there isn't room.
    const tw=tip.offsetWidth,th=tip.offsetHeight,half=tw/2;
    const below=ly-th-10<0;
    tip.style.transform='translate(-50%,'+(below?'0':'-100%')+')';
    tip.style.marginTop=(below?12:-10)+'px';
    tip.style.left=Math.max(half+2,Math.min(r.width-half-2,lx)).toFixed(1)+'px';
    tip.style.top=ly.toFixed(1)+'px';
  };
  const hide=()=>{cur.style.display='none';mark.style.display='none';tip.style.display='none';};
  hit.onpointermove=show;
  hit.onpointerdown=show;
  hit.onpointerleave=hide;
  hit.onpointercancel=hide;
}

/* The global auto-refresh deliberately never fires while a modal is open (it used to
   yank you out of a player profile). The Drive tab is the one place that genuinely
   needs to keep moving, so it runs its own timer — scoped to this tab, this game,
   and only while the game is actually in progress. It re-renders the tab body in
   place, preserving scroll position and which drive is expanded.
   20s: plays land ~30-45s after they happen, so polling faster only burns requests. */
const DRIVE_REFRESH_MS=20000;

function gameLive(){
  const c=S.modalData&&S.modalData.data&&S.modalData.data.header&&S.modalData.data.header.competitions;
  const st=c&&c[0]&&c[0].status&&c[0].status.type;
  return !!(st&&st.state==='in');
}

function stopDriveRefresh(){if(S.driveTimer){clearInterval(S.driveTimer);S.driveTimer=null;}}

function startDriveRefresh(){
  stopDriveRefresh();
  if(S.modalTab!=='drive'||!S.modalData||!S.modalData.id||!gameLive())return;
  S.driveTimer=setInterval(refreshDrive,DRIVE_REFRESH_MS);
}

async function refreshDrive(){
  if(S.modalTab!=='drive'||!S.modalData||!S.modalData.id||!$('#backdrop').classList.contains('open')){stopDriveRefresh();return;}
  let d;
  try{d=await get(API+'/'+S.modalData.path+'/summary?event='+S.modalData.id);}
  catch(e){return;}                       // a dropped poll is not worth disturbing the view over
  if(S.modalTab!=='drive'||!S.modalData)return;
  S.modalData.data=d;
  const body=$('#mbody');
  const top=body?body.scrollTop:0;
  drawModalBody();
  const nb=$('#mbody');
  if(nb)nb.scrollTop=top;
  if(!gameLive())stopDriveRefresh();      // game just ended - stop polling
}

function animateField(){
  const f=document.querySelector('.field');
  if(!f)return;
  const EZ=8,FW=100-EZ*2,px=p=>EZ+(p/100)*FW;
  const to=parseFloat(f.dataset.to),id=f.dataset.play;
  const ball=f.querySelector('.fball'),bar=f.querySelector('.fgain');
  const replay=id&&id!==S.lastAnimPlay;
  if(!replay){
    if(ball)ball.style.transition='none',ball.style.left=px(to).toFixed(2)+'%';
    if(bar){bar.style.transition='none';bar.style.left=px(+bar.dataset.lo).toFixed(2)+'%';
            bar.style.width=(px(+bar.dataset.hi)-px(+bar.dataset.lo)).toFixed(2)+'%';}
    return;
  }
  S.lastAnimPlay=id;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(ball)ball.style.left=px(to).toFixed(2)+'%';
    if(bar){bar.style.left=px(+bar.dataset.lo).toFixed(2)+'%';
            bar.style.width=(px(+bar.dataset.hi)-px(+bar.dataset.lo)).toFixed(2)+'%';}
  }));
}

function renderDrive(data){
  if(!hasDrives(data))return '<div class="msg">No drive data for this game.</div>';
  const hcomp=data.header&&data.header.competitions&&data.header.competitions[0];
  const hc=((hcomp&&hcomp.competitors)||[]).find(c=>c.homeAway==='home');
  const homeAbbr=(hc&&hc.team&&hc.team.abbreviation)||'home';
  const cols=teamColors(data);
  const scoreBy=scoringByPlayId(data);
  let html=wpChartHTML(data);
  const drives=allDrives(data);
  const cur=(data.drives&&data.drives.current)||drives[drives.length-1];
  const plays=(cur&&cur.plays)||[];
  const last=plays[plays.length-1];
  const wpm=wpByPlay(data);

  if(last){
    html+='<div class="sublabel">'+(data.drives&&data.drives.current?'Current drive':'Last drive')+'</div>';
    const offId=(cur&&cur.team&&cur.team.id)||
      ((last.teamParticipants||[]).find(t=>t.type==='offense')||{}).id||
      (last.start&&last.start.team&&last.start.team.id)||'';
    html+=fieldHTML(last,offId,cols);
    const dd=downDistance(last.start);
    const ez=last.end&&last.end.yardsToEndzone;
    const spot=(ez!==undefined&&ez!==null)?ez+' to end zone':'';
    const w=wpm[String(last.id)];
    html+='<div class="dnd"><span>'+esc([dd,spot].filter(Boolean).join('  ·  '))+'</span>'+
      (typeof w==='number'?'<span class="wpnow">'+wpPct(w)+' '+esc(homeAbbr)+'</span>':'')+'</div>';
    html+='<div class="play"><span class="clk">'+esc((last.clock&&last.clock.displayValue)||'')+'</span>'+
      '<span class="txt">'+esc((last.text||'').trim())+'</span></div>';
  }

  if(drives.length){
    html+='<div class="sublabel">Drives</div>';
    html+=drives.slice().reverse().map((dr,ri)=>{
      const i=drives.length-1-ri;
      const t=dr.team,lg=t?logoOf(t,S.modalData.lk):'';
      const sp=driveSpan(dr);
      const lo=sp?Math.min(sp.from,sp.to):0,hi=sp?Math.max(sp.from,sp.to):0;
      const res=dr.displayResult||dr.result||(dr===cur&&!dr.end?'In progress':'');
      const who=dr.isScore?scorerOf(dr,scoreBy):'';
      const open=S.driveOpen===i;
      return '<div class="drv '+(open?'open':'')+'">'+
        '<div class="drvhdr" data-drv="'+i+'">'+
          '<div class="top">'+(lg?'<img src="'+esc(lg)+'" alt="" onerror="this.style.visibility=\'hidden\'">':'')+
            '<span>'+esc((t&&(t.abbreviation||t.shortDisplayName))||'')+'</span>'+
            '<span class="res'+(dr.isScore?' sc':'')+'">'+esc(res)+
              (who?'<span class="who">'+esc(who)+'</span>':'')+'</span></div>'+
          '<div class="desc">'+esc(dr.description||'')+'</div>'+
          '<div class="bar"><span style="left:'+lo.toFixed(1)+'%;width:'+Math.max(1.5,hi-lo).toFixed(1)+'%"></span></div>'+
        '</div>'+
        (open?'<div class="drvplays">'+((dr.plays||[]).map(p=>{
          const w=wpm[String(p.id)];
          return '<div class="play '+(p.scoringPlay?'score':'')+'">'+
            '<span class="clk">'+esc((p.clock&&p.clock.displayValue)||'')+'</span>'+
            '<span class="txt">'+esc((p.text||'').trim())+
            (typeof w==='number'?'<span class="pts">'+wpPct(w)+'</span>':'')+'</span></div>';
        }).join('')||'<div class="msg">No plays listed.</div>')+'</div>':'')+
      '</div>';
    }).join('');
  }
  return html;
}

function wireDrive(){
  animateField();
  wireWpHover();
  document.querySelectorAll('.drvhdr').forEach(el=>el.onclick=()=>{
    const i=+el.dataset.drv;
    S.driveOpen=(S.driveOpen===i)?-1:i;
    drawModalBody();
  });
}

export { hasDrives, renderDrive, startDriveRefresh, stopDriveRefresh, wireDrive };
