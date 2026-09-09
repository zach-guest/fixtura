import { api } from './api.js';
import { API } from './config.js';

const STATS_TTL = 5 * 60 * 1000;
const TEAMS_TTL = 24 * 60 * 60 * 1000;
const seasonCache = { value: null, expires: 0, promise: null };
const teamsCache = { value: null, expires: 0, promise: null };
const statsCache = new Map();

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
