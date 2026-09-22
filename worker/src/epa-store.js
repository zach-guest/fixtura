/**
 * Correction-aware atomic D1 storage for EPA games.
 *
 * The shape follows game-stats-store.js deliberately, because the hazards are
 * the same and one pattern in the repository is worth more than two:
 *
 *  - Every write is a single `db.batch`, so a game is never half-replaced.
 *  - Children are deleted and reinserted, guarded on the parent row's winning
 *    hash, so an older concurrent import cannot erase a newer one after its
 *    initial read.
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

/* ------------------------------------------------------------------ NFL -- */

function nflStatements(n, hash, at) {
  const g = n.game;
  const guard = `EXISTS (SELECT 1 FROM nfl_epa_games WHERE event_id = ? AND imported_at = ? AND source_hash = ?)`;
  const guardArgs = [g.event_id, at, hash];

  return [
    {
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
        WHERE excluded.imported_at >= nfl_epa_games.imported_at
          AND NOT (nfl_epa_games.coverage = 'complete' AND excluded.coverage <> 'complete')`,
      params: [g.event_id, g.nflverse_game_id, g.season, g.season_type, g.week, g.home_team,
        g.away_team, g.gameday, g.overtime, g.source_url, g.source_updated_at, hash,
        g.parser_version, g.predicate_version, at, at, g.coverage, JSON.stringify(n.warnings),
        g.eligible_plays ?? null, g.modeled_plays ?? null, g.eligible_drives ?? null,
        g.complete_drives ?? null, g.model ?? null, g.model_version ?? null],
    },
    { sql: `DELETE FROM nfl_epa_plays WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM nfl_epa_team_games WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM nfl_epa_player_games WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM nfl_epa_drives WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    {
      sql: `INSERT INTO nfl_epa_drives
        (event_id, drive_id, sequence, possession_team, start_period, start_clock, end_period,
         end_clock, result, plays, yards, epa, modeled_plays, coverage)
        SELECT ?, json_extract(value,'$.drive_id'), json_extract(value,'$.sequence'),
          json_extract(value,'$.possession_team'), json_extract(value,'$.start_period'),
          json_extract(value,'$.start_clock'), json_extract(value,'$.end_period'),
          json_extract(value,'$.end_clock'), json_extract(value,'$.result'),
          json_extract(value,'$.plays'), json_extract(value,'$.yards'),
          json_extract(value,'$.epa'), json_extract(value,'$.modeled_plays'),
          json_extract(value,'$.coverage')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.drives || []), ...guardArgs],
    },
    // json_each keeps a game to a handful of statements instead of hundreds of
    // per-row INSERTs, while still binding every value.
    {
      sql: `INSERT INTO nfl_epa_plays
        (event_id, play_id, drive, quarter, clock, down, yards_to_go, yardline_100,
         possession_team, defense_team, play_type, description, ep_before, epa, qb_epa, success,
         is_pass, is_rush, is_dropback, is_sack, is_penalty, passer_gsis_id, rusher_gsis_id,
         receiver_gsis_id)
        SELECT ?, json_extract(value,'$.play_id'), json_extract(value,'$.drive'),
          json_extract(value,'$.quarter'), json_extract(value,'$.clock'),
          json_extract(value,'$.down'), json_extract(value,'$.yards_to_go'),
          json_extract(value,'$.yardline_100'), json_extract(value,'$.possession_team'),
          json_extract(value,'$.defense_team'), json_extract(value,'$.play_type'),
          json_extract(value,'$.description'), json_extract(value,'$.ep_before'),
          json_extract(value,'$.epa'), json_extract(value,'$.qb_epa'),
          json_extract(value,'$.success'), json_extract(value,'$.is_pass'),
          json_extract(value,'$.is_rush'), json_extract(value,'$.is_dropback'),
          json_extract(value,'$.is_sack'), json_extract(value,'$.is_penalty'),
          json_extract(value,'$.passer_gsis_id'), json_extract(value,'$.rusher_gsis_id'),
          json_extract(value,'$.receiver_gsis_id')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.plays), ...guardArgs],
    },
    {
      sql: `INSERT INTO nfl_epa_team_games
        (event_id, team, opponent, home_away, off_epa, off_plays, off_success, off_pass_epa,
         off_dropbacks, off_pass_success, off_rush_epa, off_designed_rushes, off_rush_success,
         def_epa, def_plays, def_pass_epa, def_dropbacks_faced, def_rush_epa,
         def_designed_rushes_faced, def_success_allowed, def_pass_success_allowed,
         def_rush_success_allowed, defense_sign_convention)
        SELECT ?, json_extract(value,'$.team'), json_extract(value,'$.opponent'),
          json_extract(value,'$.home_away'), json_extract(value,'$.off_epa'),
          json_extract(value,'$.off_plays'), json_extract(value,'$.off_success'),
          json_extract(value,'$.off_pass_epa'), json_extract(value,'$.off_dropbacks'),
          json_extract(value,'$.off_pass_success'), json_extract(value,'$.off_rush_epa'),
          json_extract(value,'$.off_designed_rushes'), json_extract(value,'$.off_rush_success'),
          json_extract(value,'$.def_epa'), json_extract(value,'$.def_plays'),
          json_extract(value,'$.def_pass_epa'), json_extract(value,'$.def_dropbacks_faced'),
          json_extract(value,'$.def_rush_epa'), json_extract(value,'$.def_designed_rushes_faced'),
          json_extract(value,'$.def_success_allowed'),
          json_extract(value,'$.def_pass_success_allowed'),
          json_extract(value,'$.def_rush_success_allowed'),
          json_extract(value,'$.defense_sign_convention')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.team_games), ...guardArgs],
    },
    {
      sql: `INSERT INTO nfl_epa_player_games
        (event_id, gsis_id, espn_athlete_id, display_name, team, role, epa, opportunities, successes)
        SELECT ?, json_extract(value,'$.gsis_id'), json_extract(value,'$.espn_athlete_id'),
          json_extract(value,'$.display_name'), json_extract(value,'$.team'),
          json_extract(value,'$.role'), json_extract(value,'$.epa'),
          json_extract(value,'$.opportunities'), json_extract(value,'$.successes')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.player_games), ...guardArgs],
    },
  ];
}

/* ------------------------------------------------------------------ CFB -- */

function cfbStatements(n, hash, at) {
  const g = n.game;
  const guard = `EXISTS (SELECT 1 FROM cfb_epa_games WHERE event_id = ? AND imported_at = ? AND source_hash = ?)`;
  const guardArgs = [g.event_id, at, hash];

  return [
    {
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
        WHERE excluded.imported_at >= cfb_epa_games.imported_at
          AND NOT (cfb_epa_games.coverage = 'complete' AND excluded.coverage <> 'complete')
          -- A completed capture is never replaced by an incomplete one. The
          -- validator already refuses incomplete payloads; this is the same
          -- rule expressed where a concurrent writer also has to obey it.
          AND NOT (cfb_epa_games.source_says_completed = 1 AND excluded.source_says_completed = 0)`,
      params: [g.event_id, g.season, g.season_type, g.week, g.home_team_id, g.away_team_id,
        g.source_dataset, g.source_url, g.source_release_timestamp, hash, g.parser_version,
        g.predicate_version, g.model, g.source_says_completed, at, at, g.coverage,
        JSON.stringify(n.warnings), g.eligible_plays ?? null, g.modeled_plays ?? null,
        g.eligible_drives ?? null, g.complete_drives ?? null, g.model_version ?? null],
    },
    { sql: `DELETE FROM cfb_epa_plays WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM cfb_epa_team_games WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM cfb_epa_player_games WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    { sql: `DELETE FROM cfb_epa_drives WHERE event_id = ? AND ${guard}`, params: [g.event_id, ...guardArgs] },
    {
      sql: `INSERT INTO cfb_epa_drives
        (event_id, drive_id, sequence, possession_team_id, possession_team, start_period,
         start_clock, end_period, end_clock, result, plays, yards, epa, modeled_plays, coverage)
        SELECT ?, json_extract(value,'$.drive_id'), json_extract(value,'$.sequence'),
          json_extract(value,'$.possession_team_id'), json_extract(value,'$.possession_team'),
          json_extract(value,'$.start_period'), json_extract(value,'$.start_clock'),
          json_extract(value,'$.end_period'), json_extract(value,'$.end_clock'),
          json_extract(value,'$.result'), json_extract(value,'$.plays'),
          json_extract(value,'$.yards'), json_extract(value,'$.epa'),
          json_extract(value,'$.modeled_plays'), json_extract(value,'$.coverage')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.drives || []), ...guardArgs],
    },
    {
      sql: `INSERT INTO cfb_epa_plays
        (event_id, play_id, play_number, drive_id, period, clock, down, yards_to_go,
         yards_to_endzone, possession_team_id, possession_team, defense_team_id, defense_team,
         play_type, description, ep_before, epa, success, is_pass, is_rush, is_sack,
         is_penalty_no_play, passer_athlete_id, rusher_athlete_id, receiver_athlete_id)
        SELECT ?, json_extract(value,'$.play_id'), json_extract(value,'$.play_number'),
          json_extract(value,'$.drive_id'), json_extract(value,'$.period'),
          json_extract(value,'$.clock'), json_extract(value,'$.down'),
          json_extract(value,'$.yards_to_go'), json_extract(value,'$.yards_to_endzone'),
          json_extract(value,'$.possession_team_id'), json_extract(value,'$.possession_team'),
          json_extract(value,'$.defense_team_id'), json_extract(value,'$.defense_team'),
          json_extract(value,'$.play_type'), json_extract(value,'$.description'),
          json_extract(value,'$.ep_before'), json_extract(value,'$.epa'),
          json_extract(value,'$.success'), json_extract(value,'$.is_pass'),
          json_extract(value,'$.is_rush'), json_extract(value,'$.is_sack'),
          json_extract(value,'$.is_penalty_no_play'), json_extract(value,'$.passer_athlete_id'),
          json_extract(value,'$.rusher_athlete_id'), json_extract(value,'$.receiver_athlete_id')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.plays), ...guardArgs],
    },
    {
      sql: `INSERT INTO cfb_epa_team_games
        (event_id, team_id, team, opponent_id, opponent, home_away, conference, off_epa,
         off_plays, off_success, off_pass_epa, off_pass_plays, off_pass_success, off_rush_epa,
         off_rush_plays, off_rush_success, def_epa, def_plays, def_pass_epa,
         def_pass_plays_faced, def_rush_epa, def_rush_plays_faced, def_success_allowed,
         def_pass_success_allowed, def_rush_success_allowed, defense_sign_convention)
        SELECT ?, json_extract(value,'$.team_id'), json_extract(value,'$.team'),
          json_extract(value,'$.opponent_id'), json_extract(value,'$.opponent'),
          json_extract(value,'$.home_away'), json_extract(value,'$.conference'),
          json_extract(value,'$.off_epa'), json_extract(value,'$.off_plays'),
          json_extract(value,'$.off_success'), json_extract(value,'$.off_pass_epa'),
          json_extract(value,'$.off_pass_plays'), json_extract(value,'$.off_pass_success'),
          json_extract(value,'$.off_rush_epa'), json_extract(value,'$.off_rush_plays'),
          json_extract(value,'$.off_rush_success'), json_extract(value,'$.def_epa'),
          json_extract(value,'$.def_plays'), json_extract(value,'$.def_pass_epa'),
          json_extract(value,'$.def_pass_plays_faced'), json_extract(value,'$.def_rush_epa'),
          json_extract(value,'$.def_rush_plays_faced'), json_extract(value,'$.def_success_allowed'),
          json_extract(value,'$.def_pass_success_allowed'),
          json_extract(value,'$.def_rush_success_allowed'),
          json_extract(value,'$.defense_sign_convention')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.team_games), ...guardArgs],
    },
    {
      sql: `INSERT INTO cfb_epa_player_games
        (event_id, athlete_id, display_name, team_id, team, role, epa, opportunities, successes,
         epa_basis)
        SELECT ?, json_extract(value,'$.athlete_id'), json_extract(value,'$.display_name'),
          json_extract(value,'$.team_id'), json_extract(value,'$.team'),
          json_extract(value,'$.role'), json_extract(value,'$.epa'),
          json_extract(value,'$.opportunities'), json_extract(value,'$.successes'),
          json_extract(value,'$.epa_basis')
        FROM json_each(?) WHERE ${guard}`,
      params: [g.event_id, JSON.stringify(n.player_games), ...guardArgs],
    },
  ];
}

/* ---------------------------------------------------------------- ingest -- */

const TABLES = {
  nfl: { games: 'nfl_epa_games', statements: nflStatements },
  cfb: { games: 'cfb_epa_games', statements: cfbStatements },
};

/**
 * Store one validated game. Returns a status rather than throwing for the
 * ordinary outcomes, so an importer can report them per game.
 *
 *   inserted   — new game
 *   updated    — a correction replaced it atomically
 *   unchanged  — identical data; nothing written
 *   stale      — an older import arrived after a newer one
 *   superseded — a concurrent writer won the race; nothing of ours was stored
 */
export async function ingestEpaGame(db, normalized, { importedAt }) {
  const league = normalized.league;
  const spec = TABLES[league];
  if (!spec) throw new Error(`unknown league ${league}`);

  const hash = await contentHash(normalized);
  const eventId = normalized.game.event_id;

  const existing = await db.prepare(
    `SELECT imported_at, source_hash, coverage FROM ${spec.games} WHERE event_id = ?`
  ).bind(eventId).first();

  if (existing) {
    if (importedAt < existing.imported_at) return { status: 'stale', league, event_id: eventId };
    if (existing.source_hash === hash) return { status: 'unchanged', league, event_id: eventId, content_hash: hash };
  }

  const statements = spec.statements(normalized, hash, importedAt);
  const result = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
  if (result[0]?.meta?.changes === 0) return { status: 'superseded', league, event_id: eventId };

  return {
    status: existing ? 'updated' : 'inserted',
    league,
    event_id: eventId,
    content_hash: hash,
    plays: normalized.plays.length,
    drives: (normalized.drives || []).length,
    team_games: normalized.team_games.length,
    player_games: normalized.player_games.length,
  };
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
