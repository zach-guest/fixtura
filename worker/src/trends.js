/**
 * Statistical leaderboard history.
 *
 * A third response shape, and worth being explicit about why it exists next to
 * the two lanes rather than inside one of them:
 *
 *   PUBLIC, like the proxy lane — the same answer for everyone, so it is
 *   cacheable — but the bytes come from D1, not an upstream. It is not a proxy
 *   route because there is nothing upstream to proxy. That is the whole point.
 *
 * ESPN publishes a leaderboard as it stands *now* and offers no way to ask what
 * it looked like last week. Both plausible routes in were measured 2026-09-07:
 *
 *   - `.../seasons/{y}/types/2/weeks/{n}/leaders`  → 404. No such endpoint.
 *   - `standings?season=2025&week=N`               → the `week` parameter is
 *     silently ignored: weeks 3, 8 and 15 all return identical final records.
 *
 * So leaderboard movement cannot be recovered after the fact — it can only be
 * recorded as it happens, which is what the cron below does.
 *
 * Standings movement is deliberately NOT stored here. A past week's results are
 * still fetchable (`scoreboard?seasontype=2&week=N` returns that week's real
 * games), so records and seeding can be reconstructed on demand. Storing them
 * would only create a second copy of something ESPN still answers for, free to
 * drift from it.
 *
 * One consequence worth knowing: **a snapshot cannot be backfilled.** Whatever
 * week this first runs in is the first week of history that will ever exist.
 */

import { pub, bad } from './http.js';
import { getJSON } from './proxy.js';

/** How deep to record each category. The UI shows a top five; ten leaves room. */
const SNAPSHOT_DEPTH = 10;

/** Snapshots change once a week, so this can be generous without going stale. */
const READ_TTL = 900;

/** Most recent weeks returned when the caller doesn't say. Movement needs two. */
const DEFAULT_WEEKS = 2;
const MAX_WEEKS = 20;

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const leadersUrl = (season) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/leaders`;

/**
 * Pull an ESPN id out of a `$ref`. The core API hands back
 * `.../seasons/2025/athletes/12483?lang=en&region=us` where a friendlier API
 * would inline the object; the trailing numeric segment is the id.
 *
 * Only ever called on `athlete.$ref` and `team.$ref`, both of which end in the
 * id. Do not point it at a deeper ref like `.../athletes/123/statistics/0` —
 * it would happily return "0".
 */
function refId(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/\/(\d+)(?:\?|$)/);
  return m ? m[1] : null;
}

/**
 * The capture, run from the cron in index.js.
 *
 * Fires every 30 minutes with the rest of the scheduled work but writes at most
 * once per (league, season, week): the guard below is what turns 48 runs a day
 * into one row-set a week.
 *
 * What a row actually means is "the first capture taken during ESPN's week N",
 * and no more than that. For weeks 2 onward that lands just after the week
 * number rolls over, so it reads as the finished state of week N-1. Week 1 is
 * the exception: the leaderboard doesn't exist until the first games are played,
 * so that capture happens mid-week, whenever data first appears. This is why
 * `captured_at` is stored and why the UI labels movement by date rather than by
 * week number — the timestamp is true in every case, the week number alone is
 * not.
 *
 * Returns a short string describing what it did, for the cron's log line.
 */
export async function captureLeaderSnapshot(env, ctx, league = 'nfl') {
  const board = await getJSON(SCOREBOARD, 30, ctx);
  const season = board && board.season && board.season.year;
  const week = board && board.week && board.week.number;
  const type = board && board.season && board.season.type;

  // Off-season, or the gap between season types, or a shape change. Nothing to
  // record and nothing wrong — this must not throw, or the cron alerts nightly
  // for eight months of the year.
  if (!season || !week) return 'no season/week reported; skipped';
  // Type 2 is the regular season. Preseason leaders are not a board anyone
  // tracks movement on, and recording them would put junk weeks in the history.
  if (type !== 2) return `season type ${type} is not the regular season; skipped`;

  const already = await env.DB
    .prepare('SELECT 1 AS hit FROM stat_snapshots WHERE league = ? AND season = ? AND week = ? LIMIT 1')
    .bind(league, season, week)
    .first();
  if (already) return `week ${week} already captured`;

  // The leaders endpoint for a season does not exist until that season has been
  // played — measured 2026-09-07, two days before kickoff: the scoreboard already
  // reported season 2026, type 2, week 1, while
  // `.../seasons/2026/types/2/leaders` was still a 404. Without this branch the
  // cron would throw every 30 minutes for the whole gap, which is the same
  // alert-fatigue failure the season-type guard above exists to prevent.
  // Anything that is not a "no board yet" 4xx still throws: a 502 in November is
  // worth hearing about, and the next run 30 minutes later clears a blip.
  let leaders;
  try {
    leaders = await getJSON(leadersUrl(season), 3600, ctx);
  } catch (err) {
    const status = err && err.detail && err.detail.status;
    if (status >= 400 && status < 500) return `no leaderboard published for ${season} yet (${status})`;
    throw err;
  }
  const categories = (leaders && leaders.categories) || [];
  const capturedAt = Math.floor(Date.now() / 1000);

  const sql = `INSERT OR REPLACE INTO stat_snapshots
    (league, season, week, category, rank, athlete_id, team_id, value, display_value, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const stmt = env.DB.prepare(sql);
  const writes = [];

  for (const cat of categories) {
    const name = cat && cat.name;
    if (!name) continue;
    const list = (cat.leaders || []).slice(0, SNAPSHOT_DEPTH);
    list.forEach((entry, i) => {
      const athleteId = refId(entry && entry.athlete && entry.athlete.$ref);
      // No id means nothing can be matched against it later, so it is not worth
      // a row. Missing fields are the norm with ESPN — guard, don't assume.
      if (!athleteId) return;
      writes.push(stmt.bind(
        league,
        season,
        week,
        name,
        i + 1,
        athleteId,
        refId(entry.team && entry.team.$ref),
        Number(entry.value) || 0,
        entry.displayValue == null ? null : String(entry.displayValue),
        capturedAt,
      ));
    });
  }

  // An empty board is the normal state before week 1 has been played. Writing
  // nothing means the real first week still gets captured rather than being
  // skipped by the guard above for the rest of the season.
  if (!writes.length) return `week ${week}: leaderboard is empty; nothing written`;

  await env.DB.batch(writes);
  return `week ${week}: wrote ${writes.length} rows across ${categories.length} categories`;
}

/**
 * GET /trends/leaders?league=nfl&season=2026&weeks=2
 *
 * The most recent `weeks` snapshots, newest first. An empty `snapshots` array is
 * a normal answer, not an error: for the first week or two of a season there is
 * genuinely no history, and the UI has to render that state rather than treat it
 * as a failure.
 */
export async function handleTrends(request, segments, env, ctx, origin) {
  if (request.method !== 'GET') throw bad('trends is GET only');
  if (segments[1] !== 'leaders') throw bad('unknown trends resource', { got: segments[1] || '' });

  const url = new URL(request.url);
  const league = url.searchParams.get('league') || 'nfl';
  if (!/^[a-z0-9:._-]{1,32}$/.test(league)) throw bad('bad league');

  const seasonParam = url.searchParams.get('season');
  const season = Number(seasonParam);
  if (!seasonParam || !Number.isInteger(season) || season < 2000 || season > 2100) {
    throw bad('season must be a year', { got: seasonParam });
  }

  const weeksParam = url.searchParams.get('weeks');
  let weeks = weeksParam == null ? DEFAULT_WEEKS : Number(weeksParam);
  if (!Number.isInteger(weeks) || weeks < 1) throw bad('weeks must be a positive integer', { got: weeksParam });
  weeks = Math.min(weeks, MAX_WEEKS);

  // Which weeks exist, newest first — then the rows for just those. Two queries
  // rather than one so a season with a long history can't be pulled in full by a
  // caller asking for two weeks.
  const weekRows = await env.DB
    .prepare('SELECT DISTINCT week FROM stat_snapshots WHERE league = ? AND season = ? ORDER BY week DESC LIMIT ?')
    .bind(league, season, weeks)
    .all();
  const wanted = (weekRows.results || []).map((r) => r.week);

  const snapshots = [];
  if (wanted.length) {
    const placeholders = wanted.map(() => '?').join(',');
    const rows = await env.DB
      .prepare(
        `SELECT week, category, rank, athlete_id, team_id, value, display_value, captured_at
           FROM stat_snapshots
          WHERE league = ? AND season = ? AND week IN (${placeholders})
          ORDER BY week DESC, category ASC, rank ASC`,
      )
      .bind(league, season, ...wanted)
      .all();

    const byWeek = new Map();
    for (const r of rows.results || []) {
      let snap = byWeek.get(r.week);
      if (!snap) {
        snap = { week: r.week, captured_at: r.captured_at, categories: {} };
        byWeek.set(r.week, snap);
        snapshots.push(snap);
      }
      (snap.categories[r.category] || (snap.categories[r.category] = [])).push({
        rank: r.rank,
        athlete_id: r.athlete_id,
        team_id: r.team_id,
        value: r.value,
        display_value: r.display_value,
      });
    }
  }

  return pub(JSON.stringify({ league, season, snapshots }), { ttl: READ_TTL, origin });
}
