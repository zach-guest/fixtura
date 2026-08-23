import { S } from './state.js';
import { LEAGUES, WIKI } from './config.js';

/* ========================= STATE ========================= */











/* ========================= UTIL ========================= */
const $=s=>document.querySelector(s);

const esc=s=>String(s===null||s===undefined?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function get(u){const r=await fetch(u);if(!r.ok)throw new Error(r.status);return r.json();}

function ymd(d){return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');}

function inputDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

function dayKey(d){return inputDate(new Date(d));}

function dayLabel(d){
  const t=new Date();t.setHours(0,0,0,0);const x=new Date(d);x.setHours(0,0,0,0);
  const diff=Math.round((x-t)/86400000);
  const b=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  return diff===0?'TODAY \u2014 '+b:diff===1?'TOMORROW \u2014 '+b:diff===-1?'YESTERDAY \u2014 '+b:b.toUpperCase();
}

function weekBounds(d){const s=new Date(d);s.setDate(s.getDate()-s.getDay());const e=new Date(s);e.setDate(s.getDate()+6);return [s,e];}

function gameTime(i){return new Date(i).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}

function gameTimeOnly(i){return new Date(i).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}

function isFav(n){return S.FAV_NAMES.some(f=>n&&n.toLowerCase().indexOf(f.toLowerCase())!==-1);}

function titleCase(s){return String(s||'').replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()).trim();}

function num(v){return v===null||v===undefined?'':v;}

function teamName(t){if(!t)return '';return t.displayName||t.shortDisplayName||t.name||t.nickname||[t.location,t.name].filter(Boolean).join(' ')||t.abbreviation||'';}

function sportSlug(lgKey){
  const L=LEAGUES[lgKey]||{},p=(L.path||'').split('/');
  if(p[0]==='soccer')return 'soccer';
  if(['nfl','nba','wnba','mlb','nhl'].indexOf(p[1])>=0)return p[1];
  return 'ncaa';
}

function logoOf(team,lgKey){
  if(!team)return '';
  if(team.logo)return team.logo;
  if(team.logos&&team.logos[0]&&team.logos[0].href)return team.logos[0].href;
  if(team.id&&lgKey)return 'https://a.espncdn.com/i/teamlogos/'+sportSlug(lgKey)+'/500/'+team.id+'.png';
  return '';
}

function oddsLine(comp){
  const o=comp&&comp.odds&&comp.odds[0];if(!o)return '';
  const bits=[];
  if(o.details)bits.push(o.details);
  if(o.overUnder!==undefined&&o.overUnder!==null)bits.push('O/U '+o.overUnder);
  return bits.join('  \u00b7  ');
}

function unslug(s){return String(s||'').split('-').map(w=>w?w[0].toUpperCase()+w.slice(1):'').join(' ');}

function initials(n){return String(n||'').split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();}

function clock(){$('#clock').textContent=new Date().toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}

function stamp(){$('#updated').textContent='Updated '+new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}

function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}

function modalOpen(){return $('#backdrop').classList.contains('open')||$('#pbackdrop').classList.contains('open');}

/* ========================= PLAYER PROFILE ========================= */
// Wikipedia's own search, with go=Go: jumps straight to the article when the name is an
// exact title match, otherwise shows results. Never points at the wrong person.
function wikiSearchUrl(name){
  return 'https://en.wikipedia.org/w/index.php?title=Special:Search&go=Go&search='+encodeURIComponent(name);
}

function wikiArticleUrl(title){
  return 'https://en.wikipedia.org/wiki/'+encodeURIComponent(String(title).replace(/ /g,'_'));
}

const wikiPhotoCache={};

// Returns {url,title} — url may be null when the page has no thumbnail, but the title is
// still worth having for the profile link. Null only when the lookup itself failed.
async function wikiPhoto(name,hint){
  const key=name+'|'+hint;
  if(wikiPhotoCache[key]!==undefined)return wikiPhotoCache[key];
  try{
    const s=await get(WIKI+'?action=query&generator=search&gsrsearch='+encodeURIComponent(name+' '+hint)+
      '&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*');
    const pg=s.query&&s.query.pages,k=pg&&Object.keys(pg)[0];
    const hit=k?{url:(pg[k].thumbnail&&pg[k].thumbnail.source)||null,title:pg[k].title||null}:null;
    wikiPhotoCache[key]=hit;return hit;
  }catch(e){wikiPhotoCache[key]=null;return null;}
}

export { $, clock, dayKey, dayLabel, esc, gameTime, gameTimeOnly, get, initials, inputDate, isFav, logoOf, modalOpen, num, oddsLine, stamp, store, teamName, titleCase, unslug, weekBounds, wikiArticleUrl, wikiPhoto, wikiSearchUrl, ymd };
