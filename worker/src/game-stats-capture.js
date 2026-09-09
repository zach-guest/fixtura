/** Bounded, correction-aware capture of completed NFL game summaries. */
import { getJSON } from './proxy.js';
import { ingestNFLGame } from './game-stats-store.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const MAX_IMPORTS = 8;
const RETRY_SECONDS = 30 * 60;
const RECENT_RECHECK_SECONDS = 6 * 60 * 60;
const OLD_RECHECK_SECONDS = 24 * 60 * 60;
const RECENT_KICKOFF_SECONDS = 72 * 60 * 60;

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function validSeasonType(value) {
  return value === 2 || value === 3;
}

function epoch(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function currentBoard(board) {
  const season = positiveInteger(board?.season?.year);
  const seasonType = board?.season?.type;
  const week = positiveInteger(board?.week?.number);
  return season && validSeasonType(seasonType) && week ? { season, seasonType, week } : null;
}

/**
 * Returns only self-describing completed NFL events. ESPN occasionally emits
 * placeholder or malformed entries, so no metadata is inferred from a sibling.
 */
export function discoverNFLFinalGames(scoreboard) {
  if (!scoreboard || typeof scoreboard !== 'object' || !Array.isArray(scoreboard.events)) return [];
  const found = new Map();
  for (const event of scoreboard.events) {
    const eventId = typeof event?.id === 'string' && /^\d+$/.test(event.id) ? event.id : null;
    const season = positiveInteger(event?.season?.year);
    const seasonType = event?.season?.type;
    const week = positiveInteger(event?.week?.number);
    const kickoff = typeof event?.date === 'string' && epoch(event.date) !== null ? event.date : null;
    const completed = [event?.status?.type, event?.competitions?.[0]?.status?.type]
      .some((status) => status?.completed === true && status?.state === 'post');
    if (!eventId || !season || !validSeasonType(seasonType) || !week || !kickoff || !completed) continue;
    found.set(eventId, { eventId, season, seasonType, week, kickoff });
  }
  return [...found.values()];
}

function scoreboardUrl(season, seasonType, week) {
  const query = new URLSearchParams({ dates: String(season), seasontype: String(seasonType), week: String(week), limit: '1000' });
  return `${SCOREBOARD}?${query}`;
}

function summaryUrl(eventId) {
  return `${SUMMARY}?event=${encodeURIComponent(eventId)}`;
}

function dueCandidate(candidate, game, state, now) {
  const attempted = state?.last_attempt_at;
  const sinceAttempt = Number.isInteger(attempted) ? now - attempted : Infinity;
  if (state?.status === 'failed') {
    return sinceAttempt >= RETRY_SECONDS ? { ...candidate, priority: 1, freshness: attempted || 0 } : null;
  }
  if (!game) return { ...candidate, priority: 0, freshness: state?.discovered_at || 0 };
  if (game.coverage === 'partial' || state?.status === 'partial') {
    return sinceAttempt >= RETRY_SECONDS ? { ...candidate, priority: 1, freshness: attempted || 0 } : null;
  }
  if (state?.status === 'discovered' || !state) return { ...candidate, priority: 0, freshness: state?.discovered_at || 0 };
  const lastSuccess = state.last_success_at;
  const kickoff = epoch(candidate.kickoff);
  const interval = kickoff !== null && now - kickoff <= RECENT_KICKOFF_SECONDS ? RECENT_RECHECK_SECONDS : OLD_RECHECK_SECONDS;
  return !Number.isInteger(lastSuccess) || now - lastSuccess >= interval
    ? { ...candidate, priority: 2, freshness: lastSuccess || 0 }
    : null;
}

function cleanError(error) {
  return String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

async function rowsByEvent(db, sql, eventIds) {
  if (!eventIds.length) return [];
  const marks = eventIds.map(() => '?').join(',');
  const result = await db.prepare(sql.replace('(?)', `(${marks})`)).bind(...eventIds).all();
  return result.results || [];
}

async function coverageFor(db, eventId) {
  return db.prepare('SELECT coverage FROM nfl_stat_games WHERE event_id = ?').bind(eventId).first();
}

/**
 * Run once from the scheduled handler. Fetches are injectable so its policy is
 * fully deterministic in local tests; production calls retain proxy caching.
 */
export async function captureNFLGameStats(env, ctx, options = {}) {
  const fetchJSON = options.fetchJSON || ((url, ttl) => getJSON(url, ttl, ctx));
  // Tests may provide either Date.now()-style milliseconds or an epoch-second
  // clock; storage and all comparisons below are always integer epoch seconds.
  const clockValue = (options.clock || (() => Date.now()))();
  const now = Math.floor(clockValue > 10_000_000_000 ? clockValue / 1000 : clockValue);
  const base = await fetchJSON(SCOREBOARD, 30);
  const current = currentBoard(base);
  if (!current) return { status: 'skipped', reason: 'no eligible current NFL season/week', discovered: 0, due: 0, attempted: 0, insertedOrUpdated: 0, unchanged: 0, skipped: 0 };

  const boards = await Promise.all([
    fetchJSON(scoreboardUrl(current.season, current.seasonType, current.week), 30),
    ...(current.week > 1 ? [fetchJSON(scoreboardUrl(current.season, current.seasonType, current.week - 1), 30)] : []),
  ]);
  const candidates = new Map();
  const eligibleWeeks = new Set([current.week, ...(current.week > 1 ? [current.week - 1] : [])]);
  for (const board of boards) {
    for (const candidate of discoverNFLFinalGames(board)) {
      if (candidate.season !== current.season || candidate.seasonType !== current.seasonType || !eligibleWeeks.has(candidate.week)) continue;
      candidates.set(candidate.eventId, candidate);
    }
  }
  const events = [...candidates.values()];
  if (!events.length) return { status: 'ok', discovered: 0, due: 0, attempted: 0, insertedOrUpdated: 0, unchanged: 0, skipped: 0 };

  const discoveredAt = now;
  await env.DB.batch(events.map((event) => env.DB.prepare(`INSERT INTO nfl_game_capture_state
    (event_id, season, season_type, week, kickoff, discovered_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered')
    ON CONFLICT(event_id) DO UPDATE SET season=excluded.season, season_type=excluded.season_type,
      week=excluded.week, kickoff=excluded.kickoff, last_seen_at=excluded.last_seen_at`)
    .bind(event.eventId, event.season, event.seasonType, event.week, event.kickoff, discoveredAt, discoveredAt)));

  const ids = events.map((event) => event.eventId);
  const [games, states] = await Promise.all([
    rowsByEvent(env.DB, 'SELECT event_id, coverage FROM nfl_stat_games WHERE event_id IN (?)', ids),
    rowsByEvent(env.DB, 'SELECT event_id, discovered_at, last_attempt_at, last_success_at, attempt_count, status FROM nfl_game_capture_state WHERE event_id IN (?)', ids),
  ]);
  const gameById = new Map(games.map((row) => [row.event_id, row]));
  const stateById = new Map(states.map((row) => [row.event_id, row]));
  const due = events.map((event) => dueCandidate(event, gameById.get(event.eventId), stateById.get(event.eventId), now)).filter(Boolean)
    .sort((a, b) => a.priority - b.priority || a.freshness - b.freshness || a.eventId.localeCompare(b.eventId)).slice(0, MAX_IMPORTS);

  let insertedOrUpdated = 0;
  let unchanged = 0;
  let skipped = 0;
  const failures = [];
  for (const candidate of due) {
    await env.DB.prepare(`UPDATE nfl_game_capture_state
      SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = NULL
      WHERE event_id = ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`)
      .bind(now, candidate.eventId, now).run();
    try {
      const summary = await fetchJSON(summaryUrl(candidate.eventId), 300);
      const result = await ingestNFLGame(env.DB, summary, {
        expectedEventId: candidate.eventId,
        expectedSeason: candidate.season,
        expectedSeasonType: candidate.seasonType,
        expectedWeek: candidate.week,
        expectedKickoff: candidate.kickoff,
        capturedAt: now,
      });
      let coverage = result.coverage || gameById.get(candidate.eventId)?.coverage;
      if (!coverage) coverage = (await coverageFor(env.DB, candidate.eventId))?.coverage;
      const status = coverage === 'partial' ? 'partial' : 'captured';
      await env.DB.prepare(`UPDATE nfl_game_capture_state
        SET status = ?, last_success_at = ?, last_error = NULL
        WHERE event_id = ? AND last_attempt_at <= ?
          AND (last_success_at IS NULL OR last_success_at <= ?)`)
        .bind(status, now, candidate.eventId, now, now).run();
      if (result.status === 'inserted' || result.status === 'updated') insertedOrUpdated += 1;
      else if (result.status === 'unchanged') unchanged += 1;
      else skipped += 1;
    } catch (error) {
      failures.push(`${candidate.eventId}: ${cleanError(error)}`);
      await env.DB.prepare(`UPDATE nfl_game_capture_state SET status = 'failed', last_error = ?
        WHERE event_id = ? AND last_attempt_at = ?
          AND (last_success_at IS NULL OR last_success_at <= ?)`)
        .bind(cleanError(error), candidate.eventId, now, now).run();
    }
  }
  const outcome = { status: 'ok', discovered: events.length, due: due.length, attempted: due.length, insertedOrUpdated, unchanged, skipped };
  if (failures.length) {
    const error = new Error(`NFL game capture failed for ${failures.length} event(s): ${failures.join('; ')}`);
    error.outcome = outcome;
    throw error;
  }
  return outcome;
}
