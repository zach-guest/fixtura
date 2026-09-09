/** Final-game ingestion only. Deliberately not wired to a public route or cron yet. */
import { normalizeNFLGame } from './game-stats-normalize.js';

const VERSION = 1;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Prepared values, never string interpolation of feed data. One atomic DB.batch. */
export async function prepareNFLGameWrite(summary, options) {
  const normalized = normalizeNFLGame(summary, options);
  const { event, players, stats, warnings } = normalized;
  const capturedAt = options.capturedAt;
  const sourceUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + event.event_id;
  const contentHash = await digest({ version: VERSION, event, players: [...players].sort((a,b) => a.athlete_id.localeCompare(b.athlete_id)), stats: [...stats].sort((a,b) => `${a.team_id}/${a.athlete_id}/${a.category}/${a.key}`.localeCompare(`${b.team_id}/${b.athlete_id}/${b.category}/${b.key}`)), warnings });
  const statements = [{ sql: `INSERT INTO nfl_stat_games
    (event_id, season, season_type, week, kickoff, source, source_url, source_updated_at,
     captured_at, first_captured_at, content_hash, parser_version, coverage, warnings_json)
    VALUES (?, ?, ?, ?, ?, 'espn', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET season=excluded.season, season_type=excluded.season_type,
      week=excluded.week, kickoff=excluded.kickoff, source_url=excluded.source_url,
      source_updated_at=excluded.source_updated_at, captured_at=excluded.captured_at,
      content_hash=excluded.content_hash, parser_version=excluded.parser_version,
      coverage=excluded.coverage, warnings_json=excluded.warnings_json
    WHERE excluded.captured_at >= nfl_stat_games.captured_at
      AND NOT (nfl_stat_games.coverage = 'complete' AND excluded.coverage <> 'complete')
      AND (nfl_stat_games.source_updated_at IS NULL OR excluded.source_updated_at IS NULL
        OR julianday(excluded.source_updated_at) >= julianday(nfl_stat_games.source_updated_at))`,
    params: [event.event_id, event.season, event.season_type, event.week, event.kickoff,
      sourceUrl, event.source_updated_at, capturedAt, capturedAt, contentHash, VERSION,
      event.coverage, JSON.stringify(warnings)] },
  { sql: `DELETE FROM nfl_player_game_stats WHERE event_id = ? AND EXISTS
    (SELECT 1 FROM nfl_stat_games WHERE event_id = ? AND captured_at = ? AND content_hash = ?)`,
    params: [event.event_id, event.event_id, capturedAt, contentHash] },
  { sql: `DELETE FROM nfl_player_games WHERE event_id = ? AND EXISTS
    (SELECT 1 FROM nfl_stat_games WHERE event_id = ? AND captured_at = ? AND content_hash = ?)`,
    params: [event.event_id, event.event_id, capturedAt, contentHash] }];
  // JSON table expansion keeps a game to five statements rather than hundreds
  // of per-cell INSERTs, retaining bound values and one atomic D1 batch.
  statements.push({ sql: `INSERT INTO nfl_player_games
    (event_id, athlete_id, team_id, name, position)
    SELECT ?, json_extract(value,'$.athlete_id'), json_extract(value,'$.team_id'),
      json_extract(value,'$.name'), json_extract(value,'$.position') FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM nfl_stat_games WHERE event_id = ? AND captured_at = ? AND content_hash = ?)`,
    params: [event.event_id, JSON.stringify(players), event.event_id, capturedAt, contentHash] });
  statements.push({ sql: `INSERT INTO nfl_player_game_stats
    (event_id, athlete_id, team_id, category, stat_key, value, raw_value, aggregation)
    SELECT ?, json_extract(value,'$.athlete_id'), json_extract(value,'$.team_id'),
      json_extract(value,'$.category'), json_extract(value,'$.key'),
      json_extract(value,'$.value'), CAST(json_extract(value,'$.raw') AS TEXT),
      json_extract(value,'$.aggregation') FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM nfl_stat_games WHERE event_id = ? AND captured_at = ? AND content_hash = ?)`,
    params: [event.event_id, JSON.stringify(stats), event.event_id, capturedAt, contentHash] });
  return { normalized, contentHash, statements };
}

/** Safe reruns/corrections, without erasing good data on a partial refetch.
 * SQL repeats freshness/coverage guards inside the batch. All child writes are
 * conditional on the winning capture hash, so an older concurrent batch cannot
 * erase a newer capture after its initial read.
 */
export async function ingestNFLGame(db, summary, options) {
  const prepared = await prepareNFLGameWrite(summary, options);
  const { event, players, stats } = prepared.normalized;
  const existing = await db.prepare('SELECT captured_at, source_updated_at, content_hash, coverage FROM nfl_stat_games WHERE event_id = ?').bind(event.event_id).first();
  if (existing) {
    if (options.capturedAt < existing.captured_at) return { status: 'stale', eventId: event.event_id };
    if (existing.source_updated_at && event.source_updated_at && Date.parse(event.source_updated_at) < Date.parse(existing.source_updated_at)) return { status: 'stale', eventId: event.event_id };
    if (existing.coverage === 'complete' && event.coverage !== 'complete') return { status: 'partial-rejected', eventId: event.event_id, warnings: prepared.normalized.warnings };
    if (existing.content_hash === prepared.contentHash) return { status: 'unchanged', eventId: event.event_id };
  }
  const result = await db.batch(prepared.statements.map(s => db.prepare(s.sql).bind(...s.params)));
  if (result[0]?.meta?.changes === 0) return { status: 'superseded', eventId: event.event_id };
  return { status: existing ? 'updated' : 'inserted', eventId: event.event_id,
    coverage: event.coverage, players: players.length, stats: stats.length,
    warnings: prepared.normalized.warnings };
}
