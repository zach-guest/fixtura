import { api } from './api.js';
import { API, NFL_STANDINGS } from './config.js';
import { get } from './util.js';

const STATS_TTL = 5 * 60 * 1000;
const TEAMS_TTL = 24 * 60 * 60 * 1000;
const NEWS_TTL = 5 * 60 * 1000;
const seasonCache = { value: null, expires: 0, promise: null };
const teamsCache = { value: null, expires: 0, promise: null };
const statsCache = new Map();
const standingsCache = new Map();
const newsCache = new Map();

const leader = (id, group, label, category, stat, format = 'count') => Object.freeze({ id, group, label, category, stat, format });
export const NFL_LEADER_CATEGORIES = Object.freeze([
  leader('passing-yards', 'Offense', 'Passing yards', 'passing', 'passingYards', 'yards'),
  leader('passing-touchdowns', 'Offense', 'Passing TDs', 'passing', 'passingTouchdowns'),
  leader('completions', 'Offense', 'Completions', 'passing', 'completions'),
  leader('rushing-yards', 'Offense', 'Rushing yards', 'rushing', 'rushingYards', 'yards'),
  leader('rushing-touchdowns', 'Offense', 'Rushing TDs', 'rushing', 'rushingTouchdowns'),
  leader('receptions', 'Offense', 'Receptions', 'receiving', 'receptions'),
  leader('receiving-yards', 'Offense', 'Receiving yards', 'receiving', 'receivingYards', 'yards'),
  leader('receiving-touchdowns', 'Offense', 'Receiving TDs', 'receiving', 'receivingTouchdowns'),
  leader('receiving-targets', 'Offense', 'Receiving targets', 'receiving', 'receivingTargets'),
  leader('total-tackles', 'Defense', 'Total tackles', 'defensive', 'totalTackles'),
  leader('solo-tackles', 'Defense', 'Solo tackles', 'defensive', 'soloTackles'),
  leader('sacks', 'Defense', 'Sacks', 'defensive', 'sacks', 'sacks'),
  leader('tackles-for-loss', 'Defense', 'Tackles for loss', 'defensive', 'tacklesForLoss'),
  leader('quarterback-hits', 'Defense', 'QB hits', 'defensive', 'QBHits'),
  leader('passes-defended', 'Defense', 'Passes defended', 'defensive', 'passesDefended'),
  leader('defensive-interceptions', 'Defense', 'Defensive interceptions', 'interceptions', 'interceptions'),
  leader('defensive-touchdowns', 'Defense', 'Defensive touchdowns', 'defensive', 'defensiveTouchdowns'),
]);

const definitionById = new Map(NFL_LEADER_CATEGORIES.map(definition => [definition.id, definition]));
const validSeason = season => Number.isInteger(season) && season >= 2000 && season <= 2100;
const validId = value => typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value);
const teamLogo = id => `https://a.espncdn.com/i/teamlogos/nfl/500/${encodeURIComponent(id)}.png`;
const headshot = id => `https://a.espncdn.com/i/headshots/nfl/players/full/${encodeURIComponent(id)}.png`;

function cacheSuccess(cache, key, load, ttl = STATS_TTL) {
  const current = cache.get ? cache.get(key) : cache;
  if (current && current.value && current.expires > Date.now()) return Promise.resolve(current.value);
  if (current && current.promise) return current.promise;
  const next = { value: null, expires: 0, promise: null };
  next.promise = Promise.resolve().then(load).then(value => {
    next.value = value; next.expires = Date.now() + ttl; next.promise = null;
    if (cache.get) cache.set(key, next); else Object.assign(cache, next);
    return value;
  }, error => {
    if (cache.get) cache.delete(key); else Object.assign(cache, { value: null, expires: 0, promise: null });
    throw error;
  });
  if (cache.get) cache.set(key, next); else Object.assign(cache, next);
  return next.promise;
}

export async function resolveNFLSeason() {
  return cacheSuccess(seasonCache, 'season', async () => {
    const response = await fetch(`${API}/football/nfl/scoreboard`);
    if (!response.ok) throw new Error(`NFL scoreboard request failed (${response.status})`);
    const data = await response.json();
    const season = data?.season?.year;
    if (!validSeason(season)) throw new Error('NFL scoreboard did not include a valid season year');
    return season;
  });
}

function flattenTeams(data) {
  const direct = data?.sports?.flatMap(sport => sport?.leagues?.flatMap(league => league?.teams || []) || []) || data?.teams || [];
  const teams = new Map();
  for (const entry of direct) {
    const team = entry?.team || entry;
    if (!team?.id) continue;
    teams.set(String(team.id), {
      id: String(team.id), abbreviation: team.abbreviation || String(team.id),
      displayName: team.displayName || team.shortDisplayName || team.name || String(team.id),
      logo: team.logos?.[0]?.href || team.logo || teamLogo(String(team.id)),
    });
  }
  return teams;
}

async function nflTeams() {
  return cacheSuccess(teamsCache, 'teams', async () => {
    const response = await fetch(`${API}/football/nfl/teams?limit=100`);
    if (!response.ok) throw new Error(`NFL teams request failed (${response.status})`);
    return flattenTeams(await response.json());
  }, TEAMS_TTL);
}

function enrichRows(response) {
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  return nflTeams().catch(() => new Map()).then(teams => ({ ...response, rows: rows.map(row => {
    const id = row.team_id || row.latest_team_id || null;
    const team = id ? teams.get(String(id)) || { id: String(id), abbreviation: String(id), displayName: String(id), logo: teamLogo(String(id)) } : null;
    return { ...row, team, headshot: row.athlete_id ? headshot(String(row.athlete_id)) : '' };
  }) }));
}

function validateRequest({ season, definition, scope, teamId, limit, onePerTeam }) {
  if (!validSeason(season)) throw new Error('A numeric NFL season from 2000 to 2100 is required');
  const canonical = definition && definitionById.get(definition.id);
  if (!canonical || canonical.category !== definition.category || canonical.stat !== definition.stat) throw new Error('A supported NFL leader definition is required');
  if (!['league', 'team'].includes(scope)) throw new Error('scope must be league or team');
  if (scope === 'team' && !validId(teamId)) throw new Error('team scope requires a numeric ESPN team ID');
  if (scope === 'league' && teamId != null) throw new Error('teamId is only valid for team scope');
  if (scope !== 'league' && onePerTeam) throw new Error('onePerTeam is only valid for league scope');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  return canonical;
}

export async function fetchNFLLeaders({ season, definition, scope = 'league', teamId, limit = 3, onePerTeam = false }) {
  definition = validateRequest({ season, definition, scope, teamId, limit, onePerTeam });
  const params = new URLSearchParams({ season: String(season), category: definition.category, stat: definition.stat, scope, limit: String(limit) });
  if (scope === 'team') params.set('teamId', teamId);
  if (onePerTeam) params.set('onePerTeam', 'true');
  const path = `/stats/nfl/leaders?${params.toString()}`;
  return cacheSuccess(statsCache, path, async () => enrichRows(await api(path)));
}

export async function fetchNFLLeaderGroup({ season, scope = 'league', teamId, group = 'All' }) {
  if (!['Offense', 'Defense', 'All'].includes(group)) throw new Error('group must be Offense, Defense, or All');
  const definitions = NFL_LEADER_CATEGORIES.filter(definition => group === 'All' || definition.group === group);
  return Promise.all(definitions.map(async definition => {
    try { return { definition, data: await fetchNFLLeaders({ season, definition, scope, teamId, limit: 3 }) }; }
    catch (error) { return { definition, data: null, error }; }
  }));
}

export function fetchNFLLeaderDetail({ season, definition, scope = 'league', teamId, onePerTeam = false }) {
  return fetchNFLLeaders({ season, definition, scope, teamId, limit: 32, onePerTeam });
}

export function formatNFLLeaderValue(value, definition = {}) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (definition.format === 'percent' || definition.unit === 'percent') return `${number.toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
  if (definition.format === 'rate' || String(definition.unit || '').includes('_per_')) return number.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (definition.format === 'sacks') return number.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return number.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function nflLeaderDefinition(id) { return definitionById.get(id) || null; }

function standingStat(entry, name) {
  const stat = (entry?.stats || []).find(item => item?.name === name || item?.abbreviation === name);
  return stat ? { value: Number(stat.value), display: stat.displayValue ?? '' } : { value: NaN, display: '' };
}

function normalizeStandingEntry(entry, division) {
  const team = entry?.team || {};
  const seed = standingStat(entry, 'playoffSeed');
  const conference = (entry?.stats || []).find(item => item?.name === 'vs. Conf.' || item?.shortDisplayName === 'CONF');
  return {
    team: {
      id: String(team.id || ''),
      abbreviation: team.abbreviation || '',
      displayName: team.displayName || team.shortDisplayName || team.name || 'Unknown team',
      shortDisplayName: team.shortDisplayName || team.name || team.displayName || 'Unknown team',
      logo: team.logos?.[0]?.href || (team.id ? teamLogo(String(team.id)) : ''),
    },
    division,
    wins: standingStat(entry, 'wins').display,
    losses: standingStat(entry, 'losses').display,
    ties: standingStat(entry, 'ties').display,
    pct: standingStat(entry, 'winPercent').display,
    pctValue: standingStat(entry, 'winPercent').value,
    conferenceRecord: conference?.displayValue || '',
    differential: standingStat(entry, 'pointDifferential').display || standingStat(entry, 'differential').display,
    differentialValue: standingStat(entry, 'pointDifferential').value,
    playoffSeed: Number.isInteger(seed.value) && seed.value > 0 ? seed.value : null,
    clincher: standingStat(entry, 'clincher').display,
  };
}

function recordOrder(a, b) {
  return (Number(b.wins) || 0) - (Number(a.wins) || 0) ||
    (b.pctValue || 0) - (a.pctValue || 0) ||
    (b.differentialValue || 0) - (a.differentialValue || 0) ||
    a.team.displayName.localeCompare(b.team.displayName);
}

export function normalizeNFLStandings(data) {
  const conferences = (data?.children || []).map(conference => {
    const divisions = (conference?.children || []).map(division => ({
      id: String(division?.id || ''), name: division?.name || '', abbreviation: division?.abbreviation || '',
      entries: (division?.standings?.entries || []).map(entry => normalizeStandingEntry(entry, division?.name || '')),
    }));
    const entries = divisions.flatMap(division => division.entries);
    const seeds = new Set(entries.map(entry => entry.playoffSeed).filter(Boolean));
    const officialSeeds = entries.length === 16 && seeds.size === 16 && entries.every(entry => entry.playoffSeed >= 1 && entry.playoffSeed <= 16);
    entries.sort(officialSeeds ? (a, b) => a.playoffSeed - b.playoffSeed : recordOrder);
    divisions.forEach(division => division.entries.sort(recordOrder));
    return { id: String(conference?.id || ''), name: conference?.name || '', abbreviation: conference?.abbreviation || '', officialSeeds, divisions, entries };
  }).filter(conference => conference.abbreviation);
  const season = data?.season?.year;
  if (!validSeason(season) || !conferences.length) throw new Error('NFL standings response was incomplete');
  return { season, conferences };
}

export function fetchNFLStandings({ season }) {
  if (!validSeason(season)) return Promise.reject(new Error('A numeric NFL season from 2000 to 2100 is required'));
  const path = `${NFL_STANDINGS}?${new URLSearchParams({ level: '3', season: String(season) })}`;
  return cacheSuccess(standingsCache, path, async () => normalizeNFLStandings(await get(path)));
}

function newsArticleTeams(article) {
  const seen = new Set();
  const teams = [];
  for (const category of article?.categories || []) {
    if (category?.type !== 'team' || category.teamId == null) continue;
    const id = String(category.teamId);
    if (seen.has(id)) continue;
    seen.add(id);
    teams.push({ id, abbreviation: category.team?.abbreviation || '', name: category.description || category.team?.description || '', logo: teamLogo(id) });
  }
  return teams;
}

function normalizeNewsArticle(article) {
  const image = (article?.images || []).find(img => img?.url) || null;
  return {
    id: String(article?.id ?? ''),
    headline: article?.headline || '',
    description: article?.description && article.description !== article.headline ? article.description : '',
    published: article?.published || article?.lastModified || '',
    image: image?.url || '',
    link: article?.links?.web?.href || article?.links?.mobile?.href || '',
    teams: newsArticleTeams(article),
  };
}

export function fetchNFLNews({ limit = 20, teamId = null } = {}) {
  if (teamId != null && !validId(String(teamId))) return Promise.reject(new Error('teamId must be a numeric ESPN team ID'));
  const params = new URLSearchParams({ limit: String(limit) });
  if (teamId != null) params.set('team', String(teamId));
  const path = `/football/nfl/news?${params}`;
  return cacheSuccess(newsCache, path, async () => {
    const response = await get(`${API}${path}`);
    const articles = Array.isArray(response?.articles) ? response.articles : [];
    return articles.map(normalizeNewsArticle).filter(item => item.id && item.headline && item.link);
  }, NEWS_TTL);
}
