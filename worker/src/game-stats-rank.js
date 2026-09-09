/** Public total and qualified-rate rankings over retained, discovered NFL finals. */
import { pub, bad } from './http.js';
import { STAT_DEFINITIONS } from './game-stats-normalize.js';
import { aggregateNFLRateRows, getRateDefinition } from './game-stats-rate.js';

const READ_TTL = 300;
const COVERAGE_SCOPE = 'Counts only discovered final games; it does not establish full schedule or season completeness.';

function paramsFor(request) {
  const params = new URL(request.url).searchParams;
  const allowed = new Set(['season', 'seasonType', 'category', 'stat', 'scope', 'teamId', 'throughWeek', 'limit', 'onePerTeam']);
  for (const key of params.keys()) if (!allowed.has(key)) throw bad(`unknown query parameter: ${key}`);
  return params;
}
function year(params) {
  const raw = params.get('season');
  if (!raw || !/^[0-9]{4}$/.test(raw) || Number(raw) < 2000 || Number(raw) > 2100) throw bad('season must be a year', { got: raw });
  return Number(raw);
}
function seasonType(params) {
  const raw = params.get('seasonType');
  if (raw == null) return 2;
  if (raw !== '2' && raw !== '3') throw bad('seasonType must be 2 or 3', { got: raw });
  return Number(raw);
}
function positive(raw, name, max, fallback) {
  if (raw == null) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw bad(`${name} must be a positive integer`, { got: raw });
  return Math.min(Number(raw), max);
}
function throughWeekParam(raw) {
  if (raw == null) return null;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 30) throw bad('throughWeek must be an integer from 1 through 30', { got: raw });
  return Number(raw);
}
function booleanParam(raw) {
  if (raw == null) return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw bad('onePerTeam must be 0, 1, false, or true', { got: raw });
}

function parseRequest(request) {
  const params = paramsFor(request);
  const season = year(params);
  const type = seasonType(params);
  const category = params.get('category');
  const stat = params.get('stat');
  if (!category || !stat) throw bad('category and stat are required');
  const definition = STAT_DEFINITIONS[`${category}.${stat}`];
  if (!definition) throw bad('unknown category/stat pair', { category, stat });
  const rateDefinition = definition.aggregation === 'recompute' ? getRateDefinition(category, stat) : null;
  if (!['sum', 'max', 'recompute'].includes(definition.aggregation) || (definition.aggregation === 'recompute' && !rateDefinition)) {
    throw bad('provider-only statistics do not have season ranking rules', { category, stat, aggregation: definition.aggregation });
  }
  const scope = params.get('scope') || 'league';
  if (scope !== 'league' && scope !== 'team') throw bad('scope must be league or team', { got: scope });
  const teamId = params.get('teamId');
  if (scope === 'team' && (!teamId || !/^[1-9][0-9]{0,11}$/.test(teamId))) throw bad('teamId must be a numeric ESPN id for team scope', { got: teamId });
  if (scope === 'league' && teamId != null) throw bad('teamId is only allowed for team scope');
  const throughWeek = throughWeekParam(params.get('throughWeek'));
  const limit = positive(params.get('limit'), 'limit', 100, 32);
  const onePerTeam = booleanParam(params.get('onePerTeam'));
  if (scope !== 'league' && params.has('onePerTeam')) throw bad('onePerTeam is only allowed for league scope');
  return { season, seasonType: type, category, stat, scope, teamId, throughWeek, limit, onePerTeam, aggregation: definition.aggregation, rateDefinition };
}

function newestThan(candidate, current) {
  if (!current) return true;
  if (candidate.kickoff !== current.kickoff) return candidate.kickoff > current.kickoff;
  if (candidate.event_id !== current.event_id) return candidate.event_id > current.event_id;
  return candidate.team_id < current.team_id;
}
function primitive(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return value == null || typeof value === 'string' || typeof value === 'boolean' ? value : String(value);
}
function compareRows(a, b) {
  return b.value - a.value || String(a.athlete_id).localeCompare(String(b.athlete_id)) || String(a.team_id || '').localeCompare(String(b.team_id || ''));
}

/** Turn the selected game/player/stat rows into deterministic competition ranks. */
export function aggregateLeaderRows(sourceRows, { aggregation, scope, onePerTeam }) {
  const groups = new Map();
  for (const source of sourceRows || []) {
    const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, primitive(value)]));
    if (!row.athlete_id || !row.event_id || !row.team_id) continue;
    const key = scope === 'team' || onePerTeam ? `${row.athlete_id}:${row.team_id}` : String(row.athlete_id);
    let group = groups.get(key);
    if (!group) {
      group = { athlete_id: String(row.athlete_id), team_id: onePerTeam || scope === 'team' ? String(row.team_id) : null, team_ids: new Set(), games: new Set(), games_with_stat: 0, value: null, latest: null };
      groups.set(key, group);
    }
    group.team_ids.add(String(row.team_id));
    group.games.add(String(row.event_id));
    if (newestThan(row, group.latest)) group.latest = row;
    if (row.value == null || typeof row.value !== 'number' || !Number.isFinite(row.value)) continue;
    group.games_with_stat += 1;
    group.value = group.value == null ? row.value : aggregation === 'max' ? Math.max(group.value, row.value) : group.value + row.value;
  }

  let rows = [...groups.values()].filter(group => group.games_with_stat > 0).map(group => ({
    athlete_id: group.athlete_id,
    ...(group.team_id ? { team_id: group.team_id } : {}),
    team_ids: [...group.team_ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    latest_team_id: String(group.latest.team_id),
    name: group.latest.name,
    position: group.latest.position,
    value: group.value,
    games_with_stat: group.games_with_stat,
    games_played: group.games.size,
  }));

  if (onePerTeam) {
    const leaders = new Map();
    for (const row of rows) {
      const prior = leaders.get(row.team_id);
      if (!prior || row.value > prior.value || (row.value === prior.value && row.athlete_id < prior.athlete_id)) leaders.set(row.team_id, row);
    }
    rows = [...leaders.values()];
  }
  rows.sort(compareRows);
  let previous = null;
  rows.forEach((row, index) => {
    row.rank = previous !== null && row.value === previous ? rows[index - 1].rank : index + 1;
    previous = row.value;
  });
  return rows;
}

async function coverage(db, query) {
  const result = await db.prepare(`SELECT
      COUNT(*) AS discovered_final_games,
      SUM(CASE WHEN game.event_id IS NOT NULL THEN 1 ELSE 0 END) AS captured_games,
      SUM(CASE WHEN game.coverage = 'complete' THEN 1 ELSE 0 END) AS complete_games,
      SUM(CASE WHEN game.coverage = 'partial' THEN 1 ELSE 0 END) AS partial_games,
      SUM(CASE WHEN capture.status = 'failed' THEN 1 ELSE 0 END) AS failed_games
    FROM nfl_game_capture_state AS capture
    LEFT JOIN nfl_stat_games AS game ON game.event_id = capture.event_id
    WHERE capture.season = ? AND capture.season_type = ?
      AND (? IS NULL OR capture.week <= ?)`).bind(query.season, query.seasonType, query.throughWeek, query.throughWeek).first();
  const counts = Object.fromEntries(['discovered_final_games', 'captured_games', 'complete_games', 'partial_games', 'failed_games']
    .map(key => [key, Number(result?.[key]) || 0]));
  return {
    ...counts,
    status: counts.discovered_final_games > 0 && counts.captured_games === counts.discovered_final_games
      && counts.complete_games === counts.discovered_final_games && counts.partial_games === 0 && counts.failed_games === 0
      ? 'complete_for_discovered_finals' : 'partial',
    scope: COVERAGE_SCOPE,
  };
}

async function selectedRows(db, query) {
  const result = await db.prepare(`SELECT player.event_id, player.athlete_id, player.team_id, player.name, player.position,
      game.kickoff, stat.value
    FROM nfl_stat_games AS game
    JOIN nfl_player_games AS player ON player.event_id = game.event_id
    LEFT JOIN nfl_player_game_stats AS stat ON stat.event_id = player.event_id
      AND stat.athlete_id = player.athlete_id AND stat.team_id = player.team_id
      AND stat.category = ? AND stat.stat_key = ?
    WHERE game.season = ? AND game.season_type = ?
      AND (? IS NULL OR game.week <= ?)
      AND (? IS NULL OR player.team_id = ?)
    ORDER BY game.kickoff DESC, game.event_id DESC, player.team_id ASC, player.athlete_id ASC`).bind(
    query.category, query.stat, query.season, query.seasonType, query.throughWeek, query.throughWeek,
    query.scope === 'team' ? query.teamId : null, query.scope === 'team' ? query.teamId : null,
  ).all();
  return result.results || [];
}

async function selectedRateRows(db, query) {
  const rate = query.rateDefinition;
  const result = await db.prepare(`SELECT player.event_id, player.athlete_id, player.team_id, player.name, player.position,
      game.kickoff, numerator.value AS numerator, denominator.value AS denominator
    FROM nfl_stat_games AS game
    JOIN nfl_player_games AS player ON player.event_id = game.event_id
    LEFT JOIN nfl_player_game_stats AS numerator ON numerator.event_id = player.event_id
      AND numerator.athlete_id = player.athlete_id AND numerator.team_id = player.team_id
      AND numerator.category = ? AND numerator.stat_key = ?
    LEFT JOIN nfl_player_game_stats AS denominator ON denominator.event_id = player.event_id
      AND denominator.athlete_id = player.athlete_id AND denominator.team_id = player.team_id
      AND denominator.category = ? AND denominator.stat_key = ?
    WHERE game.season = ? AND game.season_type = ?
      AND (? IS NULL OR game.week <= ?)
      AND (? IS NULL OR player.team_id = ?)
    ORDER BY game.kickoff DESC, game.event_id DESC, player.team_id ASC, player.athlete_id ASC`).bind(
    rate.numerator.category, rate.numerator.key, rate.denominator.category, rate.denominator.key,
    query.season, query.seasonType, query.throughWeek, query.throughWeek,
    query.scope === 'team' ? query.teamId : null, query.scope === 'team' ? query.teamId : null,
  ).all();
  return result.results || [];
}

async function selectedTeamGames(db, query) {
  const result = await db.prepare(`SELECT player.team_id, COUNT(DISTINCT player.event_id) AS team_games
    FROM nfl_player_games AS player
    JOIN nfl_stat_games AS game ON game.event_id = player.event_id
    WHERE game.season = ? AND game.season_type = ?
      AND (? IS NULL OR game.week <= ?)
      AND (? IS NULL OR player.team_id = ?)
    GROUP BY player.team_id`).bind(
    query.season, query.seasonType, query.throughWeek, query.throughWeek,
    query.scope === 'team' ? query.teamId : null, query.scope === 'team' ? query.teamId : null,
  ).all();
  return new Map((result.results || []).map(row => [String(row.team_id), Number(row.team_games) || 0]));
}

/** JSON-ready result for GET /stats/nfl/leaders. */
export async function readNFLLeaders(request, env) {
  if (request.method !== 'GET') throw bad('stats leaders is GET only');
  const query = parseRequest(request);
  const isRate = query.aggregation === 'recompute';
  const [coverageData, sourceRows, teamGames] = await Promise.all([
    coverage(env.DB, query),
    isRate ? selectedRateRows(env.DB, query) : selectedRows(env.DB, query),
    isRate ? selectedTeamGames(env.DB, query) : Promise.resolve(null),
  ]);
  const rateResult = isRate ? aggregateNFLRateRows(sourceRows, { ...query, teamGames }) : null;
  const rows = (isRate ? rateResult.rows : aggregateLeaderRows(sourceRows, query)).slice(0, query.limit);
  return {
    league: 'nfl',
    query: {
      season: query.season, season_type: query.seasonType, category: query.category, stat: query.stat,
      scope: query.scope, ...(query.teamId ? { team_id: query.teamId } : {}),
      ...(query.throughWeek ? { through_week: query.throughWeek } : {}), limit: query.limit, one_per_team: query.onePerTeam,
    },
    aggregation: query.aggregation,
    ...(isRate ? { rate: rateResult.definition, excluded_candidates: rateResult.excluded.length } : {}),
    coverage: coverageData,
    rows,
  };
}

export async function handleNFLLeaders(request, env, origin) {
  return pub(JSON.stringify(await readNFLLeaders(request, env)), { ttl: READ_TTL, origin });
}
