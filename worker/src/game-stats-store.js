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

const statKey = (r) => `${r.athlete_id}|${r.team_id}|${r.category}|${r.stat_key ?? r.key}`;
const playerKey = (r) => `${r.athlete_id}|${r.team_id}`;

/**
 * Only what differs from what is stored. ESPN keeps revising finished games
 * for days, usually a handful of cells at a time, and the original
 * delete-everything-then-reinsert write turned each revision into ~2,500 D1
 * row writes (every stat row, twice, plus its index). Measured 2026-09-22:
 * stat capture was ~99.9% of all rows written and pushed game days past the
 * free tier's 100k/day. A cell counts as changed unless value, raw text and
 * aggregation all match exactly; a false "changed" only costs a write.
 */
export function diffNFLGameRows(normalized, stored) {
  const oldStats = new Map((stored?.stats || []).map((r) => [statKey(r), r]));
  const oldPlayers = new Map((stored?.players || []).map((r) => [playerKey(r), r]));
  const freshStats = new Set(normalized.stats.map(statKey));
  const freshPlayers = new Set(normalized.players.map(playerKey));
  const upsertStats = normalized.stats.filter((r) => {
    const old = oldStats.get(statKey(r));
    return !old || Number(old.value) !== Number(r.value) || String(old.raw_value) !== String(r.raw)
      || old.aggregation !== r.aggregation;
  });
  const upsertPlayers = normalized.players.filter((r) => {
    const old = oldPlayers.get(playerKey(r));
    return !old || old.name !== r.name || (old.position ?? null) !== (r.position ?? null);
  });
  const deleteStats = [...oldStats.values()].filter((r) => !freshStats.has(statKey(r)))
    .map((r) => [r.athlete_id, r.team_id, r.category, r.stat_key]);
  const deletePlayers = [...oldPlayers.values()].filter((r) => !freshPlayers.has(playerKey(r)))
    .map((r) => [r.athlete_id, r.team_id]);
  return { upsertStats, upsertPlayers, deleteStats, deletePlayers };
}

/**
 * Prepared values, never string interpolation of feed data. One atomic DB.batch.
 * `stored` is the game's current rows ({contentHash, players, stats}) or null
 * when nothing is stored; the batch only applies if the stored hash is still
 * the one the diff was computed against, so a concurrent capture can never
 * leave a diff applied on top of rows it did not see.
 */
export async function prepareNFLGameWrite(summary, options, stored = null) {
  const normalized = normalizeNFLGame(summary, options);
  const { event, players, stats, warnings } = normalized;
  const capturedAt = options.capturedAt;
  const sourceUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + event.event_id;
  const contentHash = await digest({ version: VERSION, event, players: [...players].sort((a,b) => a.athlete_id.localeCompare(b.athlete_id)), stats: [...stats].sort((a,b) => `${a.team_id}/${a.athlete_id}/${a.category}/${a.key}`.localeCompare(`${b.team_id}/${b.athlete_id}/${b.category}/${b.key}`)), warnings });
  const diff = diffNFLGameRows(normalized, stored);
  // '' never matches a real hash, so "we saw no row" loses to a row that
  // appeared in the meantime instead of silently merging with it.
  const expectedHash = stored?.contentHash ?? '';
  const won = `EXISTS (SELECT 1 FROM nfl_stat_games WHERE event_id = ? AND captured_at = ? AND content_hash = ?)`;
  const wonParams = [event.event_id, capturedAt, contentHash];
  const statements = [{ sql: `INSERT INTO nfl_stat_games
    (event_id, season, season_type, week, kickoff, source, source_url, source_updated_at,
     captured_at, first_captured_at, content_hash, parser_version, coverage, warnings_json)
    VALUES (?, ?, ?, ?, ?, 'espn', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET season=excluded.season, season_type=excluded.season_type,
      week=excluded.week, kickoff=excluded.kickoff, source_url=excluded.source_url,
      source_updated_at=excluded.source_updated_at, captured_at=excluded.captured_at,
      content_hash=excluded.content_hash, parser_version=excluded.parser_version,
      coverage=excluded.coverage, warnings_json=excluded.warnings_json
    WHERE nfl_stat_games.content_hash = ?
      AND excluded.captured_at >= nfl_stat_games.captured_at
      AND NOT (nfl_stat_games.coverage = 'complete' AND excluded.coverage <> 'complete')
      AND (nfl_stat_games.source_updated_at IS NULL OR excluded.source_updated_at IS NULL
        OR julianday(excluded.source_updated_at) >= julianday(nfl_stat_games.source_updated_at))`,
    params: [event.event_id, event.season, event.season_type, event.week, event.kickoff,
      sourceUrl, event.source_updated_at, capturedAt, capturedAt, contentHash, VERSION,
      event.coverage, JSON.stringify(warnings), expectedHash] }];
  if (diff.deleteStats.length) statements.push({ sql: `DELETE FROM nfl_player_game_stats WHERE event_id = ?
    AND (athlete_id, team_id, category, stat_key) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'),
      json_extract(value,'$[2]'), json_extract(value,'$[3]') FROM json_each(?))
    AND ${won}`,
    params: [event.event_id, JSON.stringify(diff.deleteStats), ...wonParams] });
  // Removing a player cascades to any stats of theirs still left.
  if (diff.deletePlayers.length) statements.push({ sql: `DELETE FROM nfl_player_games WHERE event_id = ?
    AND (athlete_id, team_id) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?))
    AND ${won}`,
    params: [event.event_id, JSON.stringify(diff.deletePlayers), ...wonParams] });
  // JSON table expansion keeps a game to a few statements rather than hundreds
  // of per-cell INSERTs, retaining bound values and one atomic D1 batch. The
  // WHERE on each SELECT is also what lets SQLite parse the ON CONFLICT.
  if (diff.upsertPlayers.length) statements.push({ sql: `INSERT INTO nfl_player_games
    (event_id, athlete_id, team_id, name, position)
    SELECT ?, json_extract(value,'$.athlete_id'), json_extract(value,'$.team_id'),
      json_extract(value,'$.name'), json_extract(value,'$.position') FROM json_each(?)
    WHERE ${won}
    ON CONFLICT(event_id, athlete_id, team_id) DO UPDATE SET name=excluded.name, position=excluded.position`,
    params: [event.event_id, JSON.stringify(diff.upsertPlayers), ...wonParams] });
  if (diff.upsertStats.length) statements.push({ sql: `INSERT INTO nfl_player_game_stats
    (event_id, athlete_id, team_id, category, stat_key, value, raw_value, aggregation)
    SELECT ?, json_extract(value,'$.athlete_id'), json_extract(value,'$.team_id'),
      json_extract(value,'$.category'), json_extract(value,'$.key'),
      json_extract(value,'$.value'), CAST(json_extract(value,'$.raw') AS TEXT),
      json_extract(value,'$.aggregation') FROM json_each(?)
    WHERE ${won}
    ON CONFLICT(event_id, athlete_id, team_id, category, stat_key) DO UPDATE SET
      value=excluded.value, raw_value=excluded.raw_value, aggregation=excluded.aggregation`,
    params: [event.event_id, JSON.stringify(diff.upsertStats), ...wonParams] });
  return { normalized, contentHash, statements, diff };
}

async function storedGame(db, eventId) {
  const game = await db.prepare('SELECT captured_at, source_updated_at, content_hash, coverage FROM nfl_stat_games WHERE event_id = ?').bind(eventId).first();
  return game || null;
}

async function storedRows(db, eventId, contentHash) {
  const [players, stats] = await Promise.all([
    db.prepare('SELECT athlete_id, team_id, name, position FROM nfl_player_games WHERE event_id = ?').bind(eventId).all(),
    db.prepare('SELECT athlete_id, team_id, category, stat_key, value, raw_value, aggregation FROM nfl_player_game_stats WHERE event_id = ?').bind(eventId).all(),
  ]);
  return { contentHash, players: players.results || [], stats: stats.results || [] };
}

const MAX_WRITE_ATTEMPTS = 3;

/** Safe reruns/corrections, without erasing good data on a partial refetch.
 * SQL repeats freshness/coverage guards inside the batch. All child writes are
 * conditional on the winning capture hash, so an older concurrent batch cannot
 * erase a newer capture after its initial read. If another capture changed the
 * stored rows between our read and our write, the batch applies nothing and we
 * re-read and diff again.
 */
export async function ingestNFLGame(db, summary, options) {
  const eventId = String(options.expectedEventId ?? summary?.header?.id ?? '');
  for (let attempt = 1; ; attempt += 1) {
    const existing = await storedGame(db, eventId);
    const stored = existing ? await storedRows(db, eventId, existing.content_hash) : null;
    const prepared = await prepareNFLGameWrite(summary, options, stored);
    const { event, players, stats } = prepared.normalized;
    if (existing) {
      if (options.capturedAt < existing.captured_at) return { status: 'stale', eventId: event.event_id };
      if (existing.source_updated_at && event.source_updated_at && Date.parse(event.source_updated_at) < Date.parse(existing.source_updated_at)) return { status: 'stale', eventId: event.event_id };
      if (existing.coverage === 'complete' && event.coverage !== 'complete') return { status: 'partial-rejected', eventId: event.event_id, warnings: prepared.normalized.warnings };
      if (existing.content_hash === prepared.contentHash) return { status: 'unchanged', eventId: event.event_id };
    }
    const result = await db.batch(prepared.statements.map(s => db.prepare(s.sql).bind(...s.params)));
    if (result[0]?.meta?.changes === 0) {
      if (attempt < MAX_WRITE_ATTEMPTS) continue;
      return { status: 'superseded', eventId: event.event_id };
    }
    const { diff } = prepared;
    return { status: existing ? 'updated' : 'inserted', eventId: event.event_id,
      coverage: event.coverage, players: players.length, stats: stats.length,
      changed: { statsUpserted: diff.upsertStats.length, statsDeleted: diff.deleteStats.length,
        playersUpserted: diff.upsertPlayers.length, playersDeleted: diff.deletePlayers.length },
      warnings: prepared.normalized.warnings };
  }
}
