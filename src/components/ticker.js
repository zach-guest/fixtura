import { S } from '../state.js';
import { API, LEAGUES } from '../config.js';
import { $, esc, gameTimeOnly, get, num, ymd } from '../util.js';

/* ========================= TICKER ========================= */
const TICKER_SPEED=60;

function paintTicker(items){
  const el=$('#tick');
  if(items===S.tickerSig)return;S.tickerSig=items;
  if(!items){el.classList.add('paused');el.style.animationDuration='0s';
    el.innerHTML='<div class="tk-seq"><span class="tk-item">No games right now</span></div>';return;}
  el.classList.remove('paused');
  el.innerHTML='<div class="tk-seq">'+items+'</div>';
  requestAnimationFrame(()=>{
    const one=el.firstElementChild,w=one?one.offsetWidth:0;
    if(!w){el.innerHTML='<div class="tk-seq">'+items+'</div><div class="tk-seq">'+items+'</div>';return;}
    const reps=Math.max(1,Math.ceil((window.innerWidth+200)/w));
    let inner='';for(let i=0;i<reps;i++)inner+=items;
    el.innerHTML='<div class="tk-seq">'+inner+'</div><div class="tk-seq">'+inner+'</div>';
    el.style.animationDuration=Math.max(18,(w*reps)/TICKER_SPEED)+'s';
  });
}

async function loadTicker(){
  const el=$('#tick');
  if(!S.TICKER_LEAGUES.length){paintTicker('');return;}
  try{
    const today=ymd(new Date());
    const res=await Promise.all(S.TICKER_LEAGUES.map(k=>{
      const L=LEAGUES[k];if(!L)return Promise.resolve(null);
      return get(API+'/'+L.path+'/scoreboard?dates='+today+(L.extra||'')).then(d=>({L:L,evs:d.events||[]})).catch(()=>null);
    }));
    const items=[];
    res.filter(Boolean).forEach(r=>(r.evs||[]).slice(0,10).forEach(ev=>{
      const c=ev.competitions&&ev.competitions[0];if(!c)return;
      const cs=c.competitors||[],h=cs.find(x=>x.homeAway==='home'),a=cs.find(x=>x.homeAway==='away');if(!h||!a)return;
      const st=c.status&&c.status.type&&c.status.type.state;
      const v=st==='pre'?gameTimeOnly(ev.date):'<span class="sc">'+esc(num(a.score))+'-'+esc(num(h.score))+'</span> '+esc(c.status.type.shortDetail);
      items.push('<span class="tk-item"><b>'+esc((a.team&&a.team.abbreviation)||'')+'</b>@<b>'+
        esc((h.team&&h.team.abbreviation)||'')+'</b> '+v+'</span>');
    }));
    paintTicker(items.join(''));
  }catch(e){S.tickerSig='';el.classList.add('paused');
    el.innerHTML='<div class="tk-seq"><span class="tk-item">Ticker unavailable</span></div>';}
}

window.addEventListener('resize',()=>{clearTimeout(S.tkResize);
  S.tkResize=setTimeout(()=>{const s=S.tickerSig;S.tickerSig='';paintTicker(s);},250);});

export { loadTicker };
