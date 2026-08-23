import { S } from '../state.js';
import { signIn } from '../account.js';
import { api } from '../api.js';
import { openGame } from '../components/modal.js';
import { $, esc, gameTime, num, store } from '../util.js';

/* ========================= PICK'EM =========================
   The only view that needs an account, and the only one that writes to our own
   Worker. Everything about what is pickable, when it locks, and who won comes
   from the server — this file never decides any of it. Two rules in particular
   are the Worker's and must not be re-implemented here:
     - a game locks at its own kickoff, per game, not per week
     - another person's pick is simply absent from the payload until their game
       starts, so there is nothing to hide at render time
   Note the second one: if a pick isn't in `picks`, it is not "hidden", it was
   never sent. Rendering a blank is the whole job. */

const PK_MAX_WEEK=18;

function pkSet(k,v){try{store('sb-pk-'+k,v);}catch(e){}}

function pkGet(k){try{return store('sb-pk-'+k);}catch(e){return null;}}

async function renderPickem(){
  if(!S.me){$('#main').innerHTML=pkSignedOutHTML();pkWire();return;}
  if(!S.pkPools){
    $('#main').innerHTML='<div class="msg">Loading your pools…</div>';
    try{S.pkPools=(await api('/pools')).pools||[];}
    catch(e){$('#main').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';return;}
    const saved=pkGet('pool');
    S.pkPool=S.pkPools.find(p=>String(p.id)===String(saved))||S.pkPools[0]||null;
  }
  if(!S.pkPool){$('#main').innerHTML=pkNoPoolsHTML();pkWire();return;}
  $('#main').innerHTML=pkShellHTML()+'<div id="pkbody"><div class="msg">Loading…</div></div>';
  pkWire();
  pkLoadTab();
}

function pkSignedOutHTML(){
  return '<div class="panel pkintro"><div class="grouplabel" style="margin:0 0 6px">Pick’em</div>'+
    '<p class="pktext">Pick every game, week by week, against your friends. One point a winner.</p>'+
    '<p class="pktext dim">It needs an account so your picks follow you between devices and everyone '+
    'sees the same leaderboard. Nothing else in Fixtura does.</p>'+
    '<button class="chip" id="pkSignin">Sign in with Google</button></div>';
}

function pkNoPoolsHTML(){
  // If they already belong to a pool, this screen is a detour and needs a way
  // back — otherwise the only escape is reloading the page, which is what
  // happened the first time it was used.
  const back=(S.pkPools&&S.pkPools.length)?
    '<div class="subchips"><button class="chip sm" id="pkBack">‹ Back to '+esc(S.pkPools[0].name)+'</button></div>':'';
  return back+
    '<div class="panel"><div class="grouplabel" style="margin:0 0 6px">Start a pool</div>'+
    '<p class="pktext dim">You pick, your friends pick, the winner is whoever calls the most games.</p>'+
    '<div class="pkform"><input id="pkName" type="text" maxlength="60" placeholder="Pool name" '+
      'value="'+esc((S.me&&S.me.name?S.me.name.split(' ')[0]+'’s':'Sunday')+' Pool')+'">'+
      '<button class="chip" id="pkCreate">Create</button></div></div>'+
    '<div class="panel"><div class="grouplabel" style="margin:0 0 6px">Or join one</div>'+
    '<p class="pktext dim">Whoever made the pool has a six-character code.</p>'+
    '<div class="pkform"><input id="pkCode" type="text" maxlength="6" placeholder="ABC123" '+
      'style="text-transform:uppercase;font-family:\'Roboto Mono\',monospace;letter-spacing:2px">'+
      '<button class="chip" id="pkJoin">Join</button></div></div>'+
    (S.pkErr?'<div class="msg err">'+esc(S.pkErr)+'</div>':'');
}

function pkShellHTML(){
  const tabs=[['picks','My picks'],['pool','All picks'],['standings','Standings']];
  const owner=S.me&&S.pkPool.owner_id===S.me.id;
  return '<div class="subchips pkbar">'+
      S.pkPools.map(p=>'<button class="chip sm '+(S.pkPool&&p.id===S.pkPool.id?'on':'')+'" data-pkp="'+p.id+'">'+
        esc(p.name)+'</button>').join('')+
      '<button class="chip sm" data-pkp="new">+ New / join</button></div>'+
    '<div class="pkhead"><div class="pkheadmain">'+
      '<div class="pkname" id="pkNameLbl">'+esc(S.pkPool.name)+
        (owner?'<button class="pkrename" id="pkRename" title="Rename this pool">rename</button>':'')+'</div>'+
      '<div class="pkmeta">'+esc(String(S.pkPool.season))+' · '+esc((S.pkPool.league||'').toUpperCase())+
      ' · straight up · '+esc(String(S.pkPool.members||1))+' '+((S.pkPool.members||1)===1?'player':'players')+'</div></div>'+
      '<button class="chip sm pkcode" id="pkCopy" title="Copy the join code">'+esc(S.pkPool.join_code||'')+'</button></div>'+
    '<div class="pkweek"><button class="chip sm" id="pkPrev"'+(S.pkWeek<=1?' disabled':'')+'>‹</button>'+
      '<span class="pkwlabel">Week '+S.pkWeek+'</span>'+
      '<button class="chip sm" id="pkNext"'+(S.pkWeek>=PK_MAX_WEEK?' disabled':'')+'>›</button>'+
      '<button class="chip sm'+(S.pkOdds?' on':'')+'" id="pkOddsBtn" title="Show the betting line next to each game">'+
        'Odds '+(S.pkOdds?'on':'off')+'</button></div>'+
    '<div class="gtabs">'+tabs.map(t=>'<button class="'+(S.pkTab===t[0]?'on':'')+'" data-pkt="'+t[0]+'">'+
      t[1]+'</button>').join('')+'</div>';
}

async function pkLoadTab(){
  const box=$('#pkbody');if(!box)return;
  try{
    if(S.pkTab==='standings'){
      const s=await api('/pools/'+S.pkPool.id+'/standings');
      box.innerHTML=pkStandingsHTML(s);
    }else{
      S.pkData=await api('/pools/'+S.pkPool.id+'/week/'+S.pkWeek);
      box.innerHTML=S.pkTab==='picks'?pkPicksHTML(S.pkData):pkGridHTML(S.pkData);
      pkWireBody();
    }
  }catch(e){box.innerHTML='<div class="msg err">'+esc(e.message)+'</div>';}
}

/* A game row. The pick is a pair of buttons rather than a select: on a phone it
   is one tap, and the choice stays visible without opening anything. */
function pkPicksHTML(d){
  if(!d.games.length)return '<div class="msg">No games scheduled for week '+d.week+'.</div>';
  const mine=d.myPicks||{};
  const rows=d.games.map(g=>{
    const pick=mine[g.id]||'';
    const side=(t,which)=>{
      const on=pick===t.id;
      // Only colour a pick once the game is over: a correct-looking pick at
      // half time is not information, it is a tease.
      const verdict=g.final&&on?(g.winner_id===t.id?' win':g.winner_id?' loss':' push'):'';
      const where=g.neutral?'neutral site':which;
      return '<button class="pkteam'+(on?' on':'')+verdict+(g.locked?' lock':'')+'" '+
        'data-pkg="'+esc(g.id)+'" data-pkteam="'+esc(t.id)+'"'+(g.locked?' disabled':'')+
        ' title="'+esc(t.name+' — '+where)+'">'+
        (t.logo?'<img src="'+esc(t.logo)+'" alt="" onerror="this.style.display=\'none\'">':'')+
        '<span class="pkabbr">'+esc(t.abbrev||t.name)+'</span>'+
        (g.final||g.state==='in'?'<span class="pkscore">'+esc(num(t.score))+'</span>':'')+
        '</button>';
    };
    const when=g.final?'Final':g.state==='in'?'Live':gameTime(g.date);
    // "away @ home" is the convention; a neutral-site game has no home team and
    // ESPN says so explicitly, so it reads "vs" instead of claiming one.
    const sep='<span class="pkat" aria-hidden="true">'+(g.neutral?'vs':'@')+'</span>';
    const odds=(S.pkOdds&&g.odds&&(g.odds.details||g.odds.overUnder!==null))?
      '<span class="pkodds">'+esc(g.odds.details||'')+
      (g.odds.overUnder!==null&&g.odds.overUnder!==undefined?
        (g.odds.details?' · ':'')+'O/U '+esc(g.odds.overUnder):'')+'</span>':'';
    return '<div class="pkgame'+(g.locked?' locked':'')+'">'+
      '<div class="pkwhen"><span>'+esc(when)+(g.locked&&!g.final?' · locked':'')+'</span>'+
      odds+'<button class="pkinfo" data-pkinfo="'+esc(g.id)+'" title="Box score, rosters, injuries">details</button></div>'+
      '<div class="pkteams">'+side(g.away,'away')+sep+side(g.home,'home')+'</div></div>';
  }).join('');
  return '<div id="pknotes">'+pkNotesHTML(d)+'</div><div class="pkgames">'+rows+'</div>'+
    '<div class="pkhint">Picks save as you tap them, and stay changeable until each game kicks off.</div>';
}

/* Kept separate so a tap can refresh the count in place. Re-rendering the whole
   list would jump you back to the top mid-way down a 16-game week. */
function pkNotesHTML(d){
  const mine=d.myPicks||{};
  let done=0,right=0;
  d.games.forEach(g=>{if(g.final&&mine[g.id]){done++;if(g.winner_id===mine[g.id])right++;}});
  const unpicked=d.games.filter(g=>!g.locked&&!mine[g.id]).length;
  return (done?'<div class="pknote">'+right+' of '+done+' right so far this week.</div>':'')+
    (unpicked?'<div class="pknote warn">'+unpicked+' game'+(unpicked===1?'':'s')+' still to pick.</div>'
             :'<div class="pknote">Every game picked.</div>');
}

/* Everyone's picks. Blanks are not censorship — the server does not send another
   person's pick until their game starts, so there is nothing here to leak. */
function pkGridHTML(d){
  if(!d.games.length)return '<div class="msg">No games scheduled for week '+d.week+'.</div>';
  const others=d.picks||{},mine=d.myPicks||{};
  const meRow=Object.assign({},mine);
  const rows=d.members.map(mem=>{
    const isMe=S.me&&mem.id===S.me.id;
    const picks=isMe?meRow:(others[mem.id]||{});
    const cells=d.games.map(g=>{
      const sel=picks[g.id];
      if(!sel)return '<td class="pkcell empty">'+(g.locked?'—':'·')+'</td>';
      const t=sel===g.home.id?g.home:g.away;
      const cls=g.final?(g.winner_id===sel?' win':g.winner_id?' loss':' push'):'';
      return '<td class="pkcell'+cls+'">'+esc(t.abbrev||'?')+'</td>';
    }).join('');
    return '<tr'+(isMe?' class="pkme"':'')+'><td class="pkwho">'+esc(mem.name||'—')+'</td>'+cells+'</tr>';
  }).join('');
  const head=d.games.map(g=>'<th class="pkcol'+(g.locked?'':' pending')+'">'+
    esc((g.away.abbrev||'')+' '+(g.home.abbrev||''))+'</th>').join('');
  const hidden=d.games.filter(g=>!g.locked).length;
  return '<div class="gwrap pkgridwrap"><table class="pkgrid"><thead><tr><th></th>'+head+'</tr></thead>'+
    '<tbody>'+rows+'</tbody></table></div>'+
    (hidden?'<div class="pkhint">'+hidden+' game'+(hidden===1?'':'s')+' still to kick off. '+
      'Nobody can see anyone else’s pick on those — the server doesn’t send them.</div>':'');
}

function pkStandingsHTML(s){
  const rows=(s.standings||[]);
  if(!rows.length)return '<div class="msg">Nothing scored yet.</div>';
  const any=rows.some(r=>r.wins||r.losses);
  if(!any)return '<div class="msg">No games have finished yet. Standings appear once results are in.</div>';
  return '<div class="gwrap"><table class="pkgrid pkstand"><thead><tr><th></th><th>Player</th>'+
    '<th>W</th><th>L</th><th>Push</th><th>Pct</th></tr></thead><tbody>'+
    rows.map((r,i)=>'<tr'+(S.me&&r.user_id===S.me.id?' class="pkme"':'')+'>'+
      '<td class="pkrank">'+(i+1)+'</td><td class="pkwho">'+esc(r.name||'—')+'</td>'+
      '<td>'+num(r.wins)+'</td><td>'+num(r.losses)+'</td><td>'+num(r.pushes)+'</td>'+
      '<td>'+(r.pct===null||r.pct===undefined?'—':esc(r.pct)+'%')+'</td></tr>').join('')+
    '</tbody></table></div>'+
    '<div class="pkhint">Weeks scored: '+(s.weeks&&s.weeks.length?esc(s.weeks.join(', ')):'none yet')+'.</div>';
}

/* Tap to pick. Optimistic: the button lights up immediately and is put back if
   the server refuses, because waiting on a round trip to confirm a tap feels
   broken on a phone. The server is still the only thing that decides. */
async function pkPick(eventId,teamId,btn){
  if(S.pkBusy)return;
  S.pkBusy=true;
  const row=btn.parentElement;
  const prev=[...row.querySelectorAll('.pkteam')].map(b=>b.classList.contains('on'));
  row.querySelectorAll('.pkteam').forEach(b=>b.classList.toggle('on',b===btn));
  try{
    const r=await api('/pools/'+S.pkPool.id+'/picks',
      {method:'PUT',body:{week:S.pkData.week,picks:[{event_id:eventId,selection_id:teamId}]}});
    if(r.rejected&&r.rejected.length){
      row.querySelectorAll('.pkteam').forEach((b,i)=>b.classList.toggle('on',prev[i]));
      pkToast(r.rejected[0].why||'that pick was refused');
      pkLoadTab();                                   // the week has moved on; get the truth
    }else{
      S.pkData.myPicks[eventId]=teamId;
      const n=$('#pknotes');if(n)n.innerHTML=pkNotesHTML(S.pkData);
    }
  }catch(e){
    row.querySelectorAll('.pkteam').forEach((b,i)=>b.classList.toggle('on',prev[i]));
    pkToast(e.message);
  }
  S.pkBusy=false;
}

function pkToast(msg){
  const el=$('#pkToast');if(!el)return;
  el.textContent=msg;el.classList.add('show');
  clearTimeout(pkToast._t);
  pkToast._t=setTimeout(()=>el.classList.remove('show'),3500);
}

function pkWire(){
  if($('#pkSignin'))$('#pkSignin').onclick=signIn;
  if($('#pkCreate'))$('#pkCreate').onclick=async()=>{
    const name=($('#pkName').value||'').trim();
    S.pkErr='';
    try{
      const r=await api('/pools',{method:'POST',body:{name:name,season:new Date().getFullYear(),league:'nfl'}});
      S.pkPools=null;S.pkPool=null;pkSet('pool',r.pool.id);renderPickem();
    }catch(e){S.pkErr=e.message;renderPickem();}
  };
  if($('#pkJoin'))$('#pkJoin').onclick=async()=>{
    const code=($('#pkCode').value||'').trim().toUpperCase();
    S.pkErr='';
    try{
      const r=await api('/pools/join',{method:'POST',body:{code:code}});
      S.pkPools=null;S.pkPool=null;pkSet('pool',r.pool.id);renderPickem();
    }catch(e){S.pkErr=e.message;renderPickem();}
  };
  if($('#pkBack'))$('#pkBack').onclick=()=>{
    S.pkPool=S.pkPools.find(p=>String(p.id)===String(pkGet('pool')))||S.pkPools[0];
    S.pkErr='';renderPickem();
  };
  document.querySelectorAll('[data-pkp]').forEach(b=>b.onclick=()=>{
    // Keep pkPool set while the create/join screen is open, so "back" has
    // somewhere to go. renderPickem() is not called here for the same reason.
    if(b.dataset.pkp==='new'){S.pkErr='';$('#main').innerHTML=pkNoPoolsHTML();pkWire();return;}
    S.pkPool=S.pkPools.find(p=>String(p.id)===b.dataset.pkp)||S.pkPool;
    pkSet('pool',S.pkPool.id);renderPickem();
  });
  if($('#pkOddsBtn'))$('#pkOddsBtn').onclick=()=>{
    S.pkOdds=!S.pkOdds;pkSet('odds',S.pkOdds?'1':'');renderPickem();};
  if($('#pkRename'))$('#pkRename').onclick=()=>{
    const lbl=$('#pkNameLbl');if(!lbl)return;
    lbl.innerHTML='<input id="pkNameIn" type="text" maxlength="60" value="'+esc(S.pkPool.name)+'">'+
      '<button class="chip sm" id="pkNameOk">Save</button><button class="chip sm" id="pkNameNo">Cancel</button>';
    const inp=$('#pkNameIn');inp.focus();inp.select();
    const cancel=()=>{renderPickem();};
    const save=async()=>{
      const v=(inp.value||'').trim();
      if(!v||v===S.pkPool.name){cancel();return;}
      try{
        await api('/pools/'+S.pkPool.id,{method:'PATCH',body:{name:v}});
        S.pkPool.name=v;
        const i=S.pkPools.findIndex(p=>p.id===S.pkPool.id);if(i>=0)S.pkPools[i].name=v;
        pkToast('Renamed');renderPickem();
      }catch(e){pkToast(e.message);cancel();}
    };
    $('#pkNameOk').onclick=save;$('#pkNameNo').onclick=cancel;
    inp.onkeydown=e=>{if(e.key==='Enter')save();if(e.key==='Escape')cancel();};
  };
  document.querySelectorAll('[data-pkt]').forEach(b=>b.onclick=()=>{
    S.pkTab=b.dataset.pkt;renderPickem();});
  if($('#pkPrev'))$('#pkPrev').onclick=()=>{if(S.pkWeek>1){S.pkWeek--;renderPickem();}};
  if($('#pkNext'))$('#pkNext').onclick=()=>{if(S.pkWeek<PK_MAX_WEEK){S.pkWeek++;renderPickem();}};
  if($('#pkCopy'))$('#pkCopy').onclick=()=>{
    const c=S.pkPool&&S.pkPool.join_code||'';
    // The clipboard API needs a secure context and can be refused; say so rather
    // than silently doing nothing.
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(c).then(()=>pkToast('Join code '+c+' copied'),()=>pkToast('Join code: '+c));
    }else pkToast('Join code: '+c);
  };
}

function pkWireBody(){
  document.querySelectorAll('.pkteam[data-pkg]').forEach(b=>b.onclick=()=>
    pkPick(b.dataset.pkg,b.dataset.pkteam,b));
  // The same modal the scores view opens — box score, rosters, injuries, drives.
  // A pool's league key is a LEAGUES key already, so nothing needs translating.
  document.querySelectorAll('[data-pkinfo]').forEach(b=>b.onclick=()=>
    openGame(b.dataset.pkinfo,S.pkPool.league));
}

export { renderPickem };
