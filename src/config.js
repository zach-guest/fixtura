/* ========================= LEAGUES ========================= */
const SOCCER_GROUPS={
  club:[
    {country:'England',comps:[{k:'eng.1',label:'Premier League'},{k:'eng.fa',label:'FA Cup'},{k:'eng.league_cup',label:'EFL Cup'}]},
    {country:'Spain',comps:[{k:'esp.1',label:'La Liga'},{k:'esp.copa_del_rey',label:'Copa del Rey'},{k:'esp.super_cup',label:'Supercopa'}]},
    {country:'Germany',comps:[{k:'ger.1',label:'Bundesliga'},{k:'ger.dfb_pokal',label:'DFB-Pokal'}]},
    {country:'Italy',comps:[{k:'ita.1',label:'Serie A'},{k:'ita.coppa_italia',label:'Coppa Italia'},{k:'ita.super_cup',label:'Supercoppa'}]},
    {country:'France',comps:[{k:'fra.1',label:'Ligue 1'},{k:'fra.coupe_de_france',label:'Coupe de France'}]},
    {country:'USA',comps:[{k:'usa.1',label:'MLS'},{k:'usa.open',label:'US Open Cup'}]},
    {country:'Continental',comps:[{k:'uefa.champions',label:'Champions League'},{k:'uefa.europa',label:'Europa League'},
      {k:'uefa.europa.conf',label:'Conference League'},{k:'uefa.super_cup',label:'UEFA Super Cup'},{k:'fifa.cwc',label:'Club World Cup'}]}
  ],
  international:[
    {country:'Major tournaments',comps:[{k:'fifa.world',label:'World Cup'},{k:'uefa.euro',label:'Euros'},
      {k:'conmebol.america',label:'Copa America'},{k:'concacaf.gold',label:'Gold Cup'},{k:'fifa.wwc',label:"Women's World Cup"}]},
    {country:'Other',comps:[{k:'uefa.nations',label:'Nations League'},{k:'fifa.worldq.uefa',label:'WC Qualifying (UEFA)'},
      {k:'fifa.worldq.conmebol',label:'WC Qualifying (CONMEBOL)'},{k:'fifa.friendly',label:'Friendlies'}]}
  ]
};

const LEAGUES={
  nfl:{label:'NFL',path:'football/nfl',kind:'football'},
  ncaaf:{label:'CFB',path:'football/college-football',kind:'football',extra:'&groups=80&limit=200'},
  nba:{label:'NBA',path:'basketball/nba',kind:'basketball'},
  wnba:{label:'WNBA',path:'basketball/wnba',kind:'basketball'},
  ncaam:{label:'CBB (M)',path:'basketball/mens-college-basketball',kind:'basketball',extra:'&groups=50&limit=200'},
  ncaaw:{label:'CBB (W)',path:'basketball/womens-college-basketball',kind:'basketball',extra:'&groups=50&limit=200'},
  mlb:{label:'MLB',path:'baseball/mlb',kind:'baseball'},
  nhl:{label:'NHL',path:'hockey/nhl',kind:'hockey'}
};

['club','international'].forEach(m=>SOCCER_GROUPS[m].forEach(g=>g.comps.forEach(c=>{
  LEAGUES['soc:'+c.k]={label:c.label,path:'soccer/'+c.k,kind:'soccer'};
})));

const PRIMARY=[['nfl','NFL'],['ncaaf','CFB'],['nba','NBA'],['wnba','WNBA'],['ncaam','CBB'],['mlb','MLB'],['nhl','NHL'],['soccer','SOCCER']];

const DEFAULT_TICKER=['nfl','nba','mlb','nhl','ncaaf','soc:eng.1','soc:fra.1'];

const DEFAULT_TEAMS=[
  {name:'San Antonio Spurs',short:'Spurs',league:'nba',id:'24'},
  {name:'Houston Texans',short:'Texans',league:'nfl',id:'34'},
  {name:'Texas Longhorns',short:'Texas',league:'ncaaf',id:'251'},
  {name:'Oklahoma State',short:'Ok State',league:'ncaaf',id:'197'},
  {name:'Paris Saint-Germain',short:'PSG',league:'soc:fra.1',id:'160'}
];

// Tab row. VIEW_ORDER (persisted) holds the visible keys in display order; anything in
// VIEW_LABELS but not in VIEW_ORDER is simply hidden.
const VIEW_LABELS={scores:'SCORES',teams:'TEAMS',nfl:'NFL',f1:'F1',golf:'GOLF',calendar:'CALENDAR',pickem:"PICK'EM"};

const DEFAULT_VIEWS=['scores','teams','nfl','f1','golf','calendar','pickem'];

const GOLF_TOURS=[['pga','PGA'],['lpga','LPGA'],['liv','LIV'],['eur','DP World'],
  ['champions-tour','Champions'],['ntw','Korn Ferry']];

const LIVE_SCAN=['nfl','ncaaf','nba','wnba','ncaam','mlb','nhl',
  ...['club','international'].flatMap(m=>SOCCER_GROUPS[m].flatMap(g=>g.comps.map(c=>'soc:'+c.k)))];

const API='https://site.api.espn.com/apis/site/v2/sports';
const NFL_STANDINGS='https://site.api.espn.com/apis/v2/sports/football/nfl/standings';

const WEB='https://site.web.api.espn.com/apis/common/v3/sports';

const WEBSITE='https://site.web.api.espn.com/apis/site/v2/sports';

const CORE='https://sports.core.api.espn.com/v2';

const WIKI='https://en.wikipedia.org/w/api.php';

const GEO='https://geocoding-api.open-meteo.com/v1/search';

const WXAPI='https://api.open-meteo.com/v1/forecast';

const ERG='https://api.jolpi.ca/ergast/f1';

// Our own Worker: accounts, settings sync, pick'em. Public sports data keeps going
// to ESPN directly — the Worker's proxy lane exists for keyed providers and would
// only add a hop for data that is already keyless and CORS-open. See DECISIONS.md.
const APIBASE='https://fixtura-api.fixturaapp.workers.dev';

const WX_CODES={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Rime fog',51:'Light drizzle',53:'Drizzle',
 55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',
 80:'Rain showers',81:'Rain showers',82:'Violent showers',85:'Snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm, hail',99:'Severe thunderstorm'};

const BAD_IMG=/logo|icon|map\b|flag|crest|badge|commons|wiki|symbol|coat|arms|portal|question|ambox|edit|stub|disambig|padlock|seal|emblem|template|pictogram|dice|soccer_?ball|sports?.?(and|balls)|location|osm|compass|star_|arrow/i;

export { API, APIBASE, BAD_IMG, CORE, DEFAULT_TEAMS, DEFAULT_TICKER, DEFAULT_VIEWS, ERG, GEO, GOLF_TOURS, LEAGUES, LIVE_SCAN, NFL_STANDINGS, PRIMARY, SOCCER_GROUPS, VIEW_LABELS, WEB, WEBSITE, WIKI, WXAPI, WX_CODES };
