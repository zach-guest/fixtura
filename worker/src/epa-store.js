/**
 * Correction-aware atomic D1 storage for EPA games.
 *
 * The shape follows game-stats-store.js deliberately, because the hazards are
 * the same and one pattern in the repository is worth more than two:
 *
 *  - Every write is a single `db.batch`, so a game is never half-replaced.
 *  - Only child rows that differ from what is stored are written: changed or
 *    new rows are upserted, vanished rows deleted. The original version
 *    deleted and reinserted every child row on any change, the same pattern
 *    that pushed ESPN stat capture past D1's free-tier 100k rows/day
 *    (2026-09-21); a CFB game is ~250 rows, so a season backfill or a
 *    'healing' republish would have done the same here.
 *  - Child writes are guarded on the parent row's winning hash, and the parent
 *    only updates if its stored hash is still the one the diff was computed
 *    against — otherwise the batch applies nothing and the importer re-reads,
 *    so an overlapping import can never stack a diff on rows it did not see.
 *  - Freshness is re-asserted inside the SQL, not only in the JavaScript that
 *    read the row a moment earlier.
 *
 * The content hash is computed HERE, over the rows this Worker will actually
 * store, rather than trusting the `content_hash` the offline tool sends.
 * Reproducing Python's canonical JSON byte-for-byte in JavaScript would be a
 * standing source of false "changed" verdicts; deriving our own from our own
 * normalized rows cannot drift.
 */

const CANONICAL_SKIP = new Set(['display_name', 'team', 'opponent', 'possession_team', 'defense_team']);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => !CANONICAL_SKIP.has(k))
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash the game's DATA only.
 *
 * Display names and team labels are excluded (CANONICAL_SKIP): they are
 * cosmetic, they change upstream for reasons that have nothing to do with the
 * analysis, and a re-import that only renames a team should read as unchanged.
 * Fetch-time metadata is excluded for the same reason it is excluded from the
 * offline tool's hash — an upstream republish with identical plays must not
 * look like a correction.
 */
async function contentHash(normalized) {
  return digest({
    league: normalized.league,
    parser_version: normalized.game.parser_version,
    predicate_version: normalized.game.predicate_version,
    plays: normalized.plays,
    drives: normalized.drives || [],
    team_games: normalized.team_games,
    player_games: normalized.player_games,
    coverage: {
      eligible_plays: normalized.game.eligible_plays ?? null,
      modeled_plays: normalized.game.modeled_plays ?? null,
      eligible_drives: normalized.game.eligible_drives ?? null,
      complete_drives: normalized.game.complete_drives ?? null,
    },
  });
}

/* ------------------------------------------------------------ children -- */

/* Each child table: its key within a game (besides event_id), its data
   columns, and where its rows live on the normalized payload. Column lists
   are the table's own, so the SQL below is generated rather than hand-written
   eight times. */
const CHILDREN = {
  nfl: [
    { table: 'nfl_epa_drives', key: ['drive_id'], rows: (n) => n.drives || [],
      cols: ['sequence', 'possession_team', 'start_period', 'start_clock', 'end_period',
        'end_clock', 'result', 'plays', 'yards', 'epa', 'modeled_plays', 'coverage'] },
    { table: 'nfl_epa_plays', key: ['play_id'], rows: (n) => n.plays,
      cols: ['drive', 'quarter', 'clock', 'down', 'yards_to_go', 'yardline_100',
        'possession_team', 'defense_team', 'play_type', 'description', 'ep_before', 'epa',
        'qb_epa', 'success', 'is_pass', 'is_rush', 'is_dropback', 'is_sack', 'is_penalty',
        'passer_gsis_id', 'rusher_gsis_id', 'receiver_gsis_id'] },
    { table: 'nfl_epa_team_games', key: ['team'], rows: (n) => n.team_games,
      cols: ['opponent', 'home_away', 'off_epa', 'off_plays', 'off_success', 'off_pass_epa',
        'off_dropbacks', 'off_pass_success', 'off_rush_epa', 'off_designed_rushes',
        'off_rush_success', 'def_epa', 'def_plays', 'def_pass_epa', 'def_dropbacks_faced',
        'def_rush_epa', 'def_designed_rushes_faced', 'def_success_allowed',
        'def_pass_success_allowed', 'def_rush_success_allowed', 'defense_sign_convention'] },
    { table: 'nfl_epa_player_games', key: ['gsis_id', 'role'], rows: (n) => n.player_games,
      cols: ['espn_athlete_id', 'display_name', 'team', 'epa', 'opportunities', 'successes'] },
  ],
  cfb: [
    { table: 'cfb_epa_drives', key: ['drive_id'], rows: (n) => n.drives || [],
      cols: ['sequence', 'possession_team_id', 'possession_team', 'start_period', 'start_clock',
        'end_period', 'end_clock', 'result', 'plays', 'yards', 'epa', 'modeled_plays', 'coverage'] },
    { table: 'cfb_epa_plays', key: ['play_id'], rows: (n) => n.plays,
      cols: ['play_number', 'drive_id', 'period', 'clock', 'down', 'yards_to_go',
        'yards_to_endzone', 'possession_team_id', 'possession_team', 'defense_team_id',
        'defense_team', 'play_type', 'description', 'ep_before', 'epa', 'success', 'is_pass',
        'is_rush', 'is_sack', 'is_penalty_no_play', 'passer_athlete_id', 'rusher_athlete_id',
        'receiver_athlete_id'] },
    { table: 'cfb_epa_team_games', key: ['team_id'], rows: (n) => n.team_games,
      cols: ['team', 'opponent_id', 'opponent', 'home_away', 'conference', 'off_epa', 'off_plays',
        'off_success', 'off_pass_epa', 'off_pass_plays', 'off_pass_success', 'off_rush_epa',
        'off_rush_plays', 'off_rush_success', 'def_epa', 'def_plays', 'def_pass_epa',
        'def_pass_plays_faced', 'def_rush_epa', 'def_rush_plays_faced', 'def_success_allowed',
        'def_pass_success_allowed', 'def_rush_success_allowed', 'defense_sign_convention'] },
    { table: 'cfb_epa_player_games', key: ['athlete_id', 'role'], rows: (n) => n.player_games,
      cols: ['display_name', 'team_id', 'team', 'epa', 'opportunities', 'successes', 'epa_basis'] },
  ],
};

/* What json_extract stores for a payload value: booleans become 0/1 and a
   missing field is NULL. Compared as text so an INTEGER/REAL/TEXT round trip
   of the same number still matches; a false "changed" only costs a write. */
function stored(v) {
  if (v === true) return '1';
  if (v === false) return '0';
  if (v === undefined || v === null) return null;
  return String(v);
}
const rowKey = (spec, r) => JSON.stringify(spec.key.map((k) => stored(r[k])));

/** Upserts for new/changed rows and keys for vanished rows, per child table. */
export function diffChildren(league, normalized, existing) {
  return CHILDREN[league].map((spec) => {
    const old = new Map((existing?.[spec.table] || []).map((r) => [rowKey(spec, r), r]));
    const freshKeys = new Set();
    const upserts = [];
    for (const r of spec.rows(normalized)) {
      const k = rowKey(spec, r);
      freshKeys.add(k);
      const prev = old.get(k);
      if (!prev || spec.cols.some((c) => stored(prev[c]) !== stored(r[c]))) upserts.push(r);
    }
    const deletes = [...old.entries()].filter(([k]) => !freshKeys.has(k))
      .map(([, r]) => spec.key.map((c) => r[c]));
    return { spec, upserts, deletes };
  });
}

function childStatements(eventId, diffs, guard, guardArgs) {
  const out = [];
  for (const { spec, upserts, deletes } of diffs) {
    if (deletes.length) {
      const picks = spec.key.map((_, i) => `json_extract(value,'$[${i}]')`).join(', ');
      out.push({ sql: `DELETE FROM ${spec.table} WHERE event_id = ?
          AND (${spec.key.join(', ')}) IN (SELECT ${picks} FROM json_each(?)) AND ${guard}`,
        params: [eventId, JSON.stringify(deletes), ...guardArgs] });
    }
    if (upserts.length) {
      const all = [...spec.key, ...spec.cols];
      // json_each keeps a table to one statement instead of hundreds of
      // per-row INSERTs, while still binding every value. The WHERE on the
      // SELECT is also what lets SQLite parse the ON CONFLICT clause.
      out.push({ sql: `INSERT INTO ${spec.table} (event_id, ${all.join(', ')})
          SELECT ?, ${all.map((c) => `json_extract(value,'$.${c}')`).join(', ')}
          FROM json_each(?) WHERE ${guard}
          ON CONFLICT(event_id, ${spec.key.join(', ')}) DO UPDATE SET
            ${spec.cols.map((c) => `${c}=excluded.${c}`).join(', ')}`,
        params: [eventId, JSON.stringify(upserts), ...guardArgs] });
    }
  }
  return out;
}

async function storedChildren(db, league, eventId) {
  const out = {};
  for (const spec of CHILDREN[league]) {
    const { results } = await db.prepare(
      `SELECT ${[...spec.key, ...spec.cols].join(', ')} FROM ${spec.table} WHERE event_id = ?`
    ).bind(eventId).all();
    out[spec.table] = results || [];
  }
  return out;
}

/* ------------------------------------------------------------------ NFL -- */

function nflGameStatement(n, hash, at, expectedHash) {
  const g = n.game;
  return {
      sql: `INSERT INTO nfl_epa_games
        (event_id, nflverse_game_id, season, season_type, week, home_team, away_team, gameday,
         overtime, source_url, source_version, source_updated_at, source_hash, parser_version,
         predicate_version, first_imported_at, imported_at, coverage, warnings_json,
         eligible_plays, modeled_plays, eligible_drives, complete_drives, model, model_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET
          nflverse_game_id=excluded.nflverse_game_id, season=excluded.season,
          season_type=excluded.season_type, week=excluded.week, home_team=excluded.home_team,
          away_team=excluded.away_team, gameday=excluded.gameday, overtime=excluded.overtime,
          source_url=excluded.source_url, source_updated_at=excluded.source_updated_at,
          source_hash=excluded.source_hash, parser_version=excluded.parser_version,
          predicate_version=excluded.predicate_version, imported_at=excluded.imported_at,
          coverage=excluded.coverage, warnings_json=excluded.warnings_json,
          eligible_plays=excluded.eligible_plays, modeled_plays=excluded.modeled_plays,
          eligible_drives=excluded.eligible_drives, complete_drives=excluded.complete_drives,
          model=excluded.model, model_version=excluded.model_version
        WHERE nfl_epa_games.source_hash = ?
          AND excluded.imported_at >= nfl_epa_games.imported_at
          AND NOT (nfl_epa_games.coverage = 'complete' AND excluded.coverage <> 'complete')`,
      params: [g.event_id, g.nflverse_game_id, g.season, g.season_type, g.week, g.home_team,
        g.away_team, g.gameday, g.overtime, g.source_url, g.source_updated_at, hash,
        g.parser_version, g.predicate_version, at, at, g.coverage, JSON.stringify(n.warnings),
        g.eligible_plays ?? null, g.modeled_plays ?? null, g.eligible_drives ?? null,
        g.complete_drives ?? null, g.model ?? null, g.model_version ?? null, expectedHash],
  };
}

/* ------------------------------------------------------------------ CFB -- */

function cfbGameStatement(n, hash, at, expectedHash) {
  const g = n.game;
  return {
      sql: `INSERT INTO cfb_epa_games
        (event_id, season, season_type, week, home_team_id, away_team_id, source_dataset,
         source_url, source_release_timestamp, source_hash, parser_version, predicate_version,
         model, source_says_completed, first_imported_at, imported_at, coverage, warnings_json,
         eligible_plays, modeled_plays, eligible_drives, complete_drives, model_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET
          season=excluded.season, season_type=excluded.season_type, week=excluded.week,
          home_team_id=excluded.home_team_id, away_team_id=excluded.away_team_id,
          source_dataset=excluded.source_dataset, source_url=excluded.source_url,
          source_release_timestamp=excluded.source_release_timestamp,
          source_hash=excluded.source_hash, parser_version=excluded.parser_version,
          predicate_version=excluded.predicate_version, model=excluded.model,
          source_says_completed=excluded.source_says_completed, imported_at=excluded.imported_at,
          coverage=excluded.coverage, warnings_json=excluded.warnings_json,
          eligible_plays=excluded.eligible_plays, modeled_plays=excluded.modeled_plays,
          eligible_drives=excluded.eligible_drives, complete_drives=excluded.complete_drives,
          model_version=excluded.model_version
        WHERE cfb_epa_games.source_hash = ?
          AND excluded.imported_at >= cfb_epa_games.imported_at
          AND NOT (cfb_epa_games.coverage = 'complete' AND excluded.coverage <> 'complete')
          -- A completed capture is never replaced by an incomplete one. The
          -- validator already refuses incomplete payloads; this is the same
          -- rule expressed where a concurrent writer also has to obey it.
          AND NOT (cfb_epa_games.source_says_completed = 1 AND excluded.source_says_completed = 0)`,
      params: [g.event_id, g.season, g.season_type, g.week, g.home_team_id, g.away_team_id,
        g.source_dataset, g.source_url, g.source_release_timestamp, hash, g.parser_version,
        g.predicate_version, g.model, g.source_says_completed, at, at, g.coverage,
        JSON.stringify(n.warnings), g.eligible_plays ?? null, g.modeled_plays ?? null,
        g.eligible_drives ?? null, g.complete_drives ?? null, g.model_version ?? null, expectedHash],
  };
}

/* ---------------------------------------------------------------- ingest -- */

const TABLES = {
  nfl: { games: 'nfl_epa_games', gameStatement: nflGameStatement },
  cfb: { games: 'cfb_epa_games', gameStatement: cfbGameStatement },
};

const MAX_WRITE_ATTEMPTS = 3;

/**
 * Store one validated game. Returns a status rather than throwing for the
 * ordinary outcomes, so an importer can report them per game.
 *
 *   inserted   — new game
 *   updated    — a correction applied atomically (only the rows that changed)
 *   unchanged  — identical data; nothing written
 *   stale      — an older import arrived after a newer one
 *   superseded — a concurrent writer kept winning; nothing of ours was stored
 */
export async function ingestEpaGame(db, normalized, { importedAt }) {
  const league = normalized.league;
  const spec = TABLES[league];
  if (!spec) throw new Error(`unknown league ${league}`);

  const hash = await contentHash(normalized);
  const eventId = normalized.game.event_id;
  const guard = `EXISTS (SELECT 1 FROM ${spec.games} WHERE event_id = ? AND imported_at = ? AND source_hash = ?)`;
  const guardArgs = [eventId, importedAt, hash];

  for (let attempt = 1; ; attempt += 1) {
    const existing = await db.prepare(
      `SELECT imported_at, source_hash, coverage FROM ${spec.games} WHERE event_id = ?`
    ).bind(eventId).first();

    if (existing) {
      if (importedAt < existing.imported_at) return { status: 'stale', league, event_id: eventId };
      if (existing.source_hash === hash) return { status: 'unchanged', league, event_id: eventId, content_hash: hash };
    }

    const diffs = diffChildren(league, normalized, existing ? await storedChildren(db, league, eventId) : null);
    // '' never matches a stored hash, so "we saw no row" loses to a row that
    // appeared in the meantime rather than merging with it.
    const statements = [spec.gameStatement(normalized, hash, importedAt, existing?.source_hash ?? ''),
      ...childStatements(eventId, diffs, guard, guardArgs)];
    const result = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    if (result[0]?.meta?.changes === 0) {
      if (attempt < MAX_WRITE_ATTEMPTS) continue;
      return { status: 'superseded', league, event_id: eventId };
    }

    return {
      status: existing ? 'updated' : 'inserted',
      league,
      event_id: eventId,
      content_hash: hash,
      plays: normalized.plays.length,
      drives: (normalized.drives || []).length,
      team_games: normalized.team_games.length,
      player_games: normalized.player_games.length,
      changed: Object.fromEntries(diffs.map((d) => [d.spec.table, { upserted: d.upserts.length, deleted: d.deletes.length }])),
    };
  }
}

/** Record the attempt, including failures. Never references the games table:
 *  a row must be able to exist for a game that has never validated. */
export async function recordImportState(db, league, game, { importedAt, status, sourceHash = null, error = null }) {
  const table = league === 'nfl' ? 'nfl_epa_import_state' : 'cfb_epa_import_state';
  await db.prepare(`INSERT INTO ${table}
      (event_id, season, season_type, week, discovered_at, last_attempt_at, last_success_at,
       attempt_count, status, source_hash, last_error)
      VALUES (?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET
        season=excluded.season, season_type=excluded.season_type, week=excluded.week,
        last_attempt_at=excluded.last_attempt_at,
        last_success_at=COALESCE(excluded.last_success_at, ${table}.last_success_at),
        attempt_count=${table}.attempt_count + 1,
        status=excluded.status, source_hash=excluded.source_hash, last_error=excluded.last_error`)
    .bind(game.event_id, game.season, game.season_type, game.week, importedAt, importedAt,
      status === 'failed' ? null : importedAt, status, sourceHash,
      error == null ? null : String(error).slice(0, 500))
    .run();
}

export const __testing = { canonical, contentHash };
