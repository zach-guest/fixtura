/**
 * Public, retained NFL player-game reads.
 *
 * These routes describe only games that a capture process discovered as final.
 * They deliberately do not infer a schedule, participation, zero-valued cells,
 * or season-wide leaderboard completeness from the retained rows.
 */
import { pub, bad, notFound } from './http.js';
import { handleNFLLeaders } from './game-stats-rank.js';

const READ_TTL = 300;
const DEFAULT_SEASON_TYPE = 2;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const COVERAGE_SCOPE = 'Counts only discovered final games; it does not establish full schedule or season completeness.';

function jsonPrimitive(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return String(value);
}

function rowPrimitives(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonPrimitive(value)]));
}

function queryParams(request, allowed) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw bad(`unknown query parameter: ${key}`);
  }
  return url.searchParams;
}

function readSeason(params) {
  const raw = params.get('season');
  const season = Number(raw);
  if (!raw || !/^[0-9]{4}$/.test(raw) || !Number.isInteger(season) || season < 2000 || season > 2100) {
    throw bad('season must be a year', { got: raw });
  }
  return season;
}

function readSeasonType(params) {
  const raw = params.get('seasonType');
  if (raw == null) return DEFAULT_SEASON_TYPE;
  if (raw !== '2' && raw !== '3') throw bad('seasonType must be 2 or 3', { got: raw });
  return Number(raw);
}

function readLimit(params) {
  const raw = params.get('limit');
  if (raw == null) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw bad('limit must be a positive integer', { got: raw });
  return Math.min(Number(raw), MAX_LIMIT);
}

function safeWarnings(raw) {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(jsonPrimitive) : [];
  } catch {
    return [];
  }
}

async function coverage(env, season, seasonType) {
  const result = await env.DB.prepare(`SELECT
      capture.week AS week,
      COUNT(*) AS discovered_final_games,
      SUM(CASE WHEN game.event_id IS NOT NULL THEN 1 ELSE 0 END) AS captured_games,
      SUM(CASE WHEN game.coverage = 'complete' THEN 1 ELSE 0 END) AS complete_games,
      SUM(CASE WHEN game.coverage = 'partial' THEN 1 ELSE 0 END) AS partial_games,
      SUM(CASE WHEN capture.status = 'failed' THEN 1 ELSE 0 END) AS failed_games,
      MAX(capture.last_seen_at) AS last_seen_at,
      MAX(capture.last_success_at) AS last_success_at
    FROM nfl_game_capture_state AS capture
    LEFT JOIN nfl_stat_games AS game ON game.event_id = capture.event_id
    WHERE capture.season = ? AND capture.season_type = ?
    GROUP BY capture.week
    ORDER BY capture.week ASC`).bind(season, seasonType).all();
  return (result.results || []).map(row => {
    const safe = rowPrimitives(row);
    for (const key of ['discovered_final_games', 'captured_games', 'complete_games', 'partial_games', 'failed_games']) {
      safe[key] = Number(safe[key]) || 0;
    }
    return safe;
  });
}

async function playerGames(env, athleteId, season, seasonType, limit) {
  const result = await env.DB.prepare(`WITH selected_games AS (
      SELECT player.event_id, player.athlete_id, player.team_id, player.name, player.position,
             game.week, game.kickoff, game.coverage, game.captured_at, game.source_updated_at,
             game.warnings_json
        FROM nfl_player_games AS player
        JOIN nfl_stat_games AS game ON game.event_id = player.event_id
       WHERE player.athlete_id = ? AND game.season = ? AND game.season_type = ?
       ORDER BY game.kickoff DESC, game.event_id DESC, player.team_id ASC
       LIMIT ?
    )
    SELECT selected.event_id, selected.athlete_id, selected.team_id, selected.name, selected.position,
           selected.week, selected.kickoff, selected.coverage, selected.captured_at,
           selected.source_updated_at, selected.warnings_json,
           stat.category, stat.stat_key, stat.value, stat.raw_value, stat.aggregation
      FROM selected_games AS selected
      LEFT JOIN nfl_player_game_stats AS stat
        ON stat.event_id = selected.event_id AND stat.athlete_id = selected.athlete_id
       AND stat.team_id = selected.team_id
     ORDER BY selected.kickoff DESC, selected.event_id DESC, selected.team_id ASC,
              stat.category ASC, stat.stat_key ASC`).bind(athleteId, season, seasonType, limit).all();

  let player = null;
  const games = [];
  const byEvent = new Map();
  for (const sourceRow of result.results || []) {
    const row = rowPrimitives(sourceRow);
    if (!player) player = { athlete_id: row.athlete_id, name: row.name, position: row.position };
    let game = byEvent.get(row.event_id);
    if (!game) {
      game = {
        event_id: row.event_id,
        team_id: row.team_id,
        name: row.name,
        position: row.position,
        week: row.week,
        kickoff: row.kickoff,
        coverage: row.coverage,
        captured_at: row.captured_at,
        source_updated_at: row.source_updated_at,
        warnings: safeWarnings(row.warnings_json),
        stats: {},
      };
      byEvent.set(row.event_id, game);
      games.push(game);
    }
    // A left join returns one row with null stat columns when no cells exist.
    if (row.category == null || row.stat_key == null) continue;
    const category = game.stats[row.category] || (game.stats[row.category] = {});
    category[row.stat_key] = {
      value: row.value,
      raw: row.raw_value,
      aggregation: row.aggregation,
    };
  }
  return { player, games };
}

/**
 * GET /stats/nfl/coverage?season=YYYY&seasonType=2|3
 * GET /stats/nfl/players/:athleteId/games?season=YYYY&seasonType=2|3&limit=N
 */
export async function handleGameStats(request, segments, env, ctx, origin) {
  if (request.method !== 'GET') throw bad('stats is GET only');
  if (segments[0] !== 'stats' || segments[1] !== 'nfl') throw notFound('unknown stats route');

  if (segments[2] === 'leaders' && segments.length === 3) {
    return handleNFLLeaders(request, env, origin);
  }

  if (segments[2] === 'coverage' && segments.length === 3) {
    const params = queryParams(request, new Set(['season', 'seasonType']));
    const season = readSeason(params);
    const seasonType = readSeasonType(params);
    const weeks = await coverage(env, season, seasonType);
    return pub(JSON.stringify({ league: 'nfl', season, season_type: seasonType, coverage_scope: COVERAGE_SCOPE, weeks }), { ttl: READ_TTL, origin });
  }

  if (segments[2] === 'players' && segments.length === 5 && segments[4] === 'games') {
    const athleteId = segments[3];
    if (!/^[1-9][0-9]{0,11}$/.test(athleteId)) throw bad('athleteId must be a numeric ESPN id', { got: athleteId });
    const params = queryParams(request, new Set(['season', 'seasonType', 'limit']));
    const season = readSeason(params);
    const seasonType = readSeasonType(params);
    const limit = readLimit(params);
    const data = await playerGames(env, athleteId, season, seasonType, limit);
    return pub(JSON.stringify({ league: 'nfl', season, season_type: seasonType, ...data }), { ttl: READ_TTL, origin });
  }

  throw notFound('unknown stats route');
}
