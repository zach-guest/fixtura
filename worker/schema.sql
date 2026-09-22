-- Fixtura — D1 schema
-- Apply with:  wrangler d1 execute fixtura --file=worker/schema.sql
--        and:  wrangler d1 execute fixtura --local --file=worker/schema.sql   (dev copy)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users

-- One row per person. `sub` is Google's stable subject id, which is the only
-- Google field guaranteed never to change — email can be reassigned within a
-- Workspace, so it is stored for display but never used as the key.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL DEFAULT 'google',
  sub         TEXT    NOT NULL,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  role        TEXT    NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  created_at  INTEGER NOT NULL,                  -- unix seconds
  last_seen   INTEGER,
  UNIQUE (provider, sub)
);

-- ---------------------------------------------------------------- sessions

-- Bearer tokens. Only the SHA-256 of the token is stored, so a dump of this
-- table cannot be replayed as a login. Expiry is enforced in SQL on every
-- lookup rather than by a cleanup job.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------- settings

-- Cross-device sync. Deliberately key/value rather than typed columns: the keys
-- are exactly the existing `sb-*` localStorage keys, so `store()` can push
-- without the frontend learning a second shape. `updated_at` is what lets a
-- device decide whether the server or its own copy is newer.
CREATE TABLE IF NOT EXISTS settings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,                  -- 'sb-favs', 'sb-views', ...
  value       TEXT    NOT NULL,                  -- the JSON string, stored verbatim
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------- pick'em

-- A pool is a group of people picking together. One row per pool; a solo user
-- still gets a pool, so there is no separate "no pool" code path.
CREATE TABLE IF NOT EXISTS pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  league      TEXT    NOT NULL DEFAULT 'nfl',    -- LEAGUES key, so this is not NFL-only later
  season      INTEGER NOT NULL,                  -- 2026
  -- How this pool scores. Set at creation and never changed, because changing it
  -- would silently reinterpret every pick already made. New modes are new pools.
  --   'su'         straight up, one point a winner        (built)
  --   'confidence' rank your picks, score the rank        (picks.confidence; built)
  --   'survivor'   one team a week, no reuse, one strike  (enforced in pools.js; built)
  --   'ats'        against the spread                     (needs the line snapshotted)
  --   'golf6'      six golfers, lowest combined to-par
  --   'f1podium'   top three, per race
  mode        TEXT    NOT NULL DEFAULT 'su',
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  join_code   TEXT    NOT NULL UNIQUE,           -- short shareable string
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_members (
  pool_id     INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (pool_id, user_id)
);

-- One row per person per game. `event_id` is ESPN's event id, so a pick joins
-- straight onto the scoreboard the app already fetches — no game table to keep
-- in sync, and no risk of our copy of the schedule drifting from ESPN's.
--
-- `locks_at` is copied from the event's kickoff at write time rather than read
-- live, so a pick can be rejected as late without a network call. It is the
-- server's clock that decides, never the client's.
CREATE TABLE IF NOT EXISTS picks (
  pool_id     INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT    NOT NULL,                  -- ESPN event id
  week        INTEGER NOT NULL,
  -- What was picked, as an ESPN id. A team id for NFL/MLB, an athlete id for a
  -- golf pool (a golf competitor's id IS the athlete id), a driver id for F1.
  -- One column because ESPN's ids are already the common currency here.
  selection_id TEXT   NOT NULL,
  -- Only meaningful for a 'confidence' pool: this pick's rank, 1..(games that
  -- week), unique per user per week. NULL for every other mode. Survivor needs
  -- no column of its own — "one pick a week, no team reused" is enforced in
  -- pools.js against this same table, not a schema constraint, because a
  -- partial index would need pools.mode, which isn't on this table.
  confidence  INTEGER,
  locks_at    INTEGER NOT NULL,                  -- kickoff, unix seconds
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (pool_id, user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_picks_week ON picks(pool_id, week);

-- Scored results, written once a game goes final. Kept separate from `picks`
-- so re-scoring a week is a delete-and-reinsert here and never touches what
-- anyone actually picked.
CREATE TABLE IF NOT EXISTS results (
  pool_id     INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  event_id    TEXT    NOT NULL,
  week        INTEGER NOT NULL,
  winner_id   TEXT,                              -- winning ESPN id; NULL on a tie
  scored_at   INTEGER NOT NULL,
  PRIMARY KEY (pool_id, event_id)
);

-- ---------------------------------------------------------------- stat history

-- Weekly snapshots of a league's statistical leaderboard, written by the cron in
-- index.js. See trends.js for why this has to be recorded rather than asked for:
-- ESPN publishes leaders as they stand *now* and offers no historical view of
-- them, so "who climbed the passing-yards board this week" is unanswerable after
-- the fact unless it was written down as it happened.
--
-- Standings movement deliberately does NOT live here. A past week's results are
-- still fetchable (`scoreboard?seasontype=2&week=N`), so records and seeding can
-- be reconstructed on demand — storing them would only create a second copy free
-- to drift from ESPN's.
--
-- Nothing here is per-user; it is the same for everyone, which is why the route
-- that reads it returns pub() and lives outside PRIVATE_PREFIXES.
CREATE TABLE IF NOT EXISTS stat_snapshots (
  league        TEXT    NOT NULL DEFAULT 'nfl',  -- LEAGUES key, so this is not NFL-only later
  season        INTEGER NOT NULL,
  -- ESPN's week number as reported at capture time. A row says "this is how the
  -- board looked at captured_at", not "these are the totals through week N" —
  -- the UI compares two snapshots and labels the movement by date, so it never
  -- has to claim the stronger thing.
  week          INTEGER NOT NULL,
  category      TEXT    NOT NULL,                -- 'passingYards', 'sacks', ...
  rank          INTEGER NOT NULL,                -- 1 = leader
  -- Parsed out of the $ref URL, never dereferenced: resolving 16 categories x 10
  -- leaders would be 160 extra requests per capture, and the id is all that is
  -- needed to match a stored row against a live one.
  athlete_id    TEXT    NOT NULL,
  team_id       TEXT,
  value         REAL    NOT NULL,
  display_value TEXT,
  captured_at   INTEGER NOT NULL,                -- unix seconds
  PRIMARY KEY (league, season, week, category, rank)
);
-- Additive: preserves accounts, picks, results and weekly stat_snapshots.
-- Apply explicitly to the intended database. No production capture is enabled.
CREATE TABLE IF NOT EXISTS nfl_stat_games (
  event_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  kickoff TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'espn'),
  source_url TEXT NOT NULL,
  source_updated_at TEXT,
  captured_at INTEGER NOT NULL,
  first_captured_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial')),
  warnings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nfl_stat_games_season ON nfl_stat_games(season, season_type, week);
CREATE TABLE IF NOT EXISTS nfl_player_games (
  event_id TEXT NOT NULL REFERENCES nfl_stat_games(event_id) ON DELETE CASCADE,
  athlete_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position TEXT,
  PRIMARY KEY (event_id, athlete_id, team_id),
  UNIQUE (event_id, athlete_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_games_athlete ON nfl_player_games(athlete_id, event_id);
CREATE INDEX IF NOT EXISTS idx_nfl_player_games_team ON nfl_player_games(team_id, event_id);
CREATE TABLE IF NOT EXISTS nfl_player_game_stats (
  event_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  category TEXT NOT NULL,
  stat_key TEXT NOT NULL,
  value REAL NOT NULL,
  raw_value TEXT NOT NULL,
  aggregation TEXT NOT NULL CHECK (aggregation IN ('sum','max','recompute','provider_only')),
  PRIMARY KEY (event_id, athlete_id, team_id, category, stat_key),
  FOREIGN KEY (event_id, athlete_id, team_id)
    REFERENCES nfl_player_games(event_id, athlete_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_nfl_game_stats_category ON nfl_player_game_stats(category, stat_key, event_id);
-- Additive capture bookkeeping. Rows exist before a summary is successfully
-- imported, so this deliberately does not reference nfl_stat_games.
CREATE TABLE IF NOT EXISTS nfl_game_capture_state (
  event_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  kickoff TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('discovered','captured','partial','failed')),
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_nfl_game_capture_state_week
  ON nfl_game_capture_state(season, season_type, week, status);
CREATE INDEX IF NOT EXISTS idx_nfl_game_capture_state_status_attempt
  ON nfl_game_capture_state(status, last_attempt_at);

-- ===========================================================================
-- EPA tables — canonical definitions.
--
-- schema.sql is the CANONICAL FINAL SCHEMA for a database created from
-- nothing, and it is repeat-safe: every statement in this file is
-- `CREATE ... IF NOT EXISTS`, so applying it twice is a no-op.
--
-- `migrations/0005_epa_drives_and_coverage.sql` is the ONE-TIME migration that
-- brings a database already carrying 0003/0004 up to these definitions. It
-- uses `ALTER TABLE ADD COLUMN`, which SQLite cannot express conditionally, so
-- it must be applied exactly once per database. That is a property of the
-- migration, not of this file, and migration tracking is what must prevent a
-- second application.
--
-- The columns 0005 adds appear below after the last column of their table and
-- before any table constraint, which reproduces the column order ALTER TABLE
-- produces. Both routes therefore yield identical table definitions, and there
-- is a test for exactly that.
-- ===========================================================================

-- NFL expected points added (nflverse / nflfastR), postgame only.
-- Additive: touches nothing that already exists. Preserves accounts, pools,
-- picks, results, stat_snapshots, and the nfl_stat_* / nfl_game_capture_state
-- tables from 0001 and 0002.
--
-- Deliberately separate from the CFB tables in 0004. NFL and college EPA come
-- from different models with different taxonomies and identity spaces, and must
-- never share a leaderboard, baseline or qualification threshold. Separate
-- tables make that structural rather than a rule someone has to remember.
--
-- Every id is TEXT. ESPN event ids and nflverse ids are short enough to be
-- integers, but the CFB tables must use TEXT (play ids exceed 2^53) and one
-- rule across both leagues is worth more than two bytes a row.

CREATE TABLE IF NOT EXISTS nfl_epa_games (
  event_id TEXT PRIMARY KEY,                 -- ESPN event id; joins the app
  nflverse_game_id TEXT NOT NULL UNIQUE,     -- provider-supported crosswalk
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  gameday TEXT,
  overtime INTEGER NOT NULL DEFAULT 0 CHECK (overtime IN (0,1)),
  source_url TEXT NOT NULL,
  source_version TEXT,
  source_updated_at TEXT,
  -- Hash of the game's DATA only. Fetch-time metadata (ETag, Last-Modified,
  -- release timestamps) is excluded, or an upstream republish would change the
  -- hash with identical plays and defeat skip-unchanged.
  source_hash TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  predicate_version INTEGER NOT NULL,
  first_imported_at INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial')),
  warnings_json TEXT NOT NULL,
  -- Coverage and provenance. Added to existing databases by migration 0005.
  -- Nullable with no default: a 0 would assert that a row nobody measured
  -- had zero modeled plays. eligible_* is what the source held;
  -- modeled_/complete_* is what passed the qualifying predicate.
  eligible_plays INTEGER,
  modeled_plays INTEGER,
  eligible_drives INTEGER,
  complete_drives INTEGER,
  model TEXT,
  model_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_games_season
  ON nfl_epa_games(season, season_type, week);

CREATE TABLE IF NOT EXISTS nfl_epa_plays (
  event_id TEXT NOT NULL REFERENCES nfl_epa_games(event_id) ON DELETE CASCADE,
  play_id TEXT NOT NULL,
  drive TEXT,
  quarter INTEGER,
  clock TEXT,
  down INTEGER,
  yards_to_go INTEGER,
  yardline_100 INTEGER,                      -- preferred over yardLine: does
                                             -- not depend on whose half it is
  possession_team TEXT NOT NULL,
  defense_team TEXT NOT NULL,
  play_type TEXT,
  description TEXT,                          -- kept deliberately: 41-47% of the
                                             -- measured plays table; impact-play
                                             -- explanations need it
  ep_before REAL,
  epa REAL NOT NULL,
  qb_epa REAL,
  success INTEGER CHECK (success IN (0,1)),  -- NULL allowed: missing is not zero
  is_pass INTEGER NOT NULL CHECK (is_pass IN (0,1)),
  is_rush INTEGER NOT NULL CHECK (is_rush IN (0,1)),
  is_dropback INTEGER NOT NULL CHECK (is_dropback IN (0,1)),
  is_sack INTEGER NOT NULL CHECK (is_sack IN (0,1)),
  is_penalty INTEGER NOT NULL CHECK (is_penalty IN (0,1)),
  passer_gsis_id TEXT,
  rusher_gsis_id TEXT,
  receiver_gsis_id TEXT,
  PRIMARY KEY (event_id, play_id)
);
-- Drive-ordered read for the Game Center analytics tab. Season-scoped reads go
-- through the summary tables, never through this one.
CREATE INDEX IF NOT EXISTS idx_nfl_epa_plays_drive
  ON nfl_epa_plays(event_id, drive, play_id);

CREATE TABLE IF NOT EXISTS nfl_epa_team_games (
  event_id TEXT NOT NULL REFERENCES nfl_epa_games(event_id) ON DELETE CASCADE,
  team TEXT NOT NULL,
  opponent TEXT NOT NULL,
  home_away TEXT NOT NULL CHECK (home_away IN ('home','away')),
  -- Numerators and denominators only. Never a stored rate: a season rate is
  -- recomputed from summed totals, not averaged across games.
  off_epa REAL NOT NULL,
  off_plays INTEGER NOT NULL,
  off_success INTEGER NOT NULL,
  off_pass_epa REAL NOT NULL,
  off_dropbacks INTEGER NOT NULL,
  off_pass_success INTEGER NOT NULL,
  off_rush_epa REAL NOT NULL,
  off_designed_rushes INTEGER NOT NULL,
  off_rush_success INTEGER NOT NULL,
  -- Defense is the negation of the opponent's offense, so higher is better.
  -- The convention is stored per row rather than assumed by every reader.
  def_epa REAL NOT NULL,
  def_plays INTEGER NOT NULL,
  def_pass_epa REAL NOT NULL,
  def_dropbacks_faced INTEGER NOT NULL,
  def_rush_epa REAL NOT NULL,
  def_designed_rushes_faced INTEGER NOT NULL,
  def_success_allowed INTEGER NOT NULL,
  defense_sign_convention TEXT NOT NULL
    CHECK (defense_sign_convention = 'negated_opponent_offense_higher_is_better'),
  -- Split success-rate numerators. Added to existing databases by 0005.
  -- Without these, a pass or rush success rate could only be produced by
  -- dividing an all-play success count by a split denominator, which is a
  -- different quantity wearing the right label. Mirrored from the
  -- opponent's offensive splits.
  def_pass_success_allowed INTEGER,
  def_rush_success_allowed INTEGER,
  PRIMARY KEY (event_id, team)
);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_team_games_team
  ON nfl_epa_team_games(team, event_id);

CREATE TABLE IF NOT EXISTS nfl_epa_player_games (
  event_id TEXT NOT NULL REFERENCES nfl_epa_games(event_id) ON DELETE CASCADE,
  gsis_id TEXT NOT NULL,
  -- Nullable on purpose: a missing ESPN id costs a player-popup link, never a
  -- team's EPA. Identity is the GSIS id; this is the join to the app.
  espn_athlete_id TEXT,
  display_name TEXT,
  team TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('qb','rusher')),
  -- QB rows aggregate nflverse qb_epa; rusher rows aggregate designed-rush epa.
  epa REAL NOT NULL,
  opportunities INTEGER NOT NULL CHECK (opportunities > 0),
  successes INTEGER NOT NULL,
  PRIMARY KEY (event_id, gsis_id, role)
);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_player_games_role
  ON nfl_epa_player_games(role, gsis_id, event_id);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_player_games_espn
  ON nfl_epa_player_games(espn_athlete_id, role);

-- One row per attempted import, including games that never validate. Mirrors
-- nfl_game_capture_state and deliberately does NOT reference nfl_epa_games,
-- because a row must exist before a payload succeeds.
CREATE TABLE IF NOT EXISTS nfl_epa_import_state (
  event_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  discovered_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('discovered','imported','partial','failed','unmapped')),
  source_hash TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_import_state_week
  ON nfl_epa_import_state(season, season_type, week, status);
-- College football expected points added (SportsDataverse / cfbfastR),
-- postgame only. Additive; touches nothing that already exists.
--
-- Separate from 0003 on purpose, not as duplication to be refactored away
-- later. The college model is a different model: NFL QB rows aggregate
-- nflverse `qb_epa`, while college has no such field and passer rows can only
-- aggregate the play's own EPA. The two are not comparable even in principle,
-- so they never share a table, a leaderboard or a qualification threshold.
--
-- Identity needs no crosswalk here: game_id IS the ESPN event id, and the
-- player id columns ARE ESPN athlete ids.
--
-- TEXT ids are load-bearing. The largest observed 2026 play id is
-- 401858212104999901; JavaScript's Number.MAX_SAFE_INTEGER is 9007199254740991.
-- Stored or emitted as a number, a play id would round silently and two plays
-- could collide.

CREATE TABLE IF NOT EXISTS cfb_epa_games (
  event_id TEXT PRIMARY KEY,                 -- ESPN event id, direct from source
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  home_team_id TEXT NOT NULL,                -- ESPN team ids
  away_team_id TEXT NOT NULL,
  -- Which of the sources this game came from. Persisted per game so a later
  -- source change is explicable and auditable rather than invisible.
  source_dataset TEXT NOT NULL
    CHECK (source_dataset IN ('compiled_season_parquet','per_game_final_json','local_cfbfastr')),
  source_url TEXT NOT NULL,
  source_release_timestamp TEXT,             -- the release's own timestamp.json
  source_hash TEXT NOT NULL,                 -- data-only hash, as in 0003
  parser_version INTEGER NOT NULL,
  predicate_version INTEGER NOT NULL,
  model TEXT NOT NULL,                       -- named in every public response
  -- The source's own completed flag at import time. A capture taken mid-game
  -- is the single biggest correctness risk in this dataset: 44 of ESPN's 99
  -- week-1 2026 finals were present but truncated days later, and one held 179
  -- plays against a complete game's 161 -- so play count is NOT a substitute
  -- check. Only 1 may be served as analysis.
  source_says_completed INTEGER NOT NULL CHECK (source_says_completed IN (0,1)),
  first_imported_at INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial')),
  warnings_json TEXT NOT NULL,
  -- Coverage and provenance. Added to existing databases by migration 0005.
  eligible_plays INTEGER,
  modeled_plays INTEGER,
  eligible_drives INTEGER,
  complete_drives INTEGER,
  model_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_games_season
  ON cfb_epa_games(season, season_type, week);

CREATE TABLE IF NOT EXISTS cfb_epa_plays (
  event_id TEXT NOT NULL REFERENCES cfb_epa_games(event_id) ON DELETE CASCADE,
  play_id TEXT NOT NULL,                     -- exceeds 2^53; TEXT is required
  play_number INTEGER,
  drive_id TEXT,
  period INTEGER,
  clock TEXT,
  down INTEGER,
  yards_to_go INTEGER,
  yards_to_endzone INTEGER,
  possession_team_id TEXT NOT NULL,
  possession_team TEXT,
  defense_team_id TEXT NOT NULL,
  defense_team TEXT,
  play_type TEXT,
  description TEXT,                          -- kept deliberately, as in 0003
  ep_before REAL,
  epa REAL NOT NULL,
  success INTEGER CHECK (success IN (0,1)),  -- NULL allowed: missing is not zero
  is_pass INTEGER NOT NULL CHECK (is_pass IN (0,1)),
  is_rush INTEGER NOT NULL CHECK (is_rush IN (0,1)),
  is_sack INTEGER NOT NULL CHECK (is_sack IN (0,1)),
  -- Audit flag, and the reason the penalty-no-play decision is reversible.
  -- 11 of week 1's 621 penalty-no-play snaps qualify (the rest fall outside
  -- scrimmage_play). They are kept because the source assigned them EPA and
  -- the values are consistent with the penalty being enforced; this column is
  -- what makes that call revisitable from stored data instead of a re-import.
  is_penalty_no_play INTEGER NOT NULL CHECK (is_penalty_no_play IN (0,1)),
  passer_athlete_id TEXT,
  rusher_athlete_id TEXT,
  receiver_athlete_id TEXT,
  PRIMARY KEY (event_id, play_id)
);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_plays_drive
  ON cfb_epa_plays(event_id, drive_id, play_number);

CREATE TABLE IF NOT EXISTS cfb_epa_team_games (
  event_id TEXT NOT NULL REFERENCES cfb_epa_games(event_id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  team TEXT,
  opponent_id TEXT NOT NULL,
  opponent TEXT,
  home_away TEXT NOT NULL CHECK (home_away IN ('home','away','neutral')),
  -- Conference AT GAME TIME, never derived from a team's current conference.
  -- NULL until the source supplies it; a wrong historical conference is worse
  -- than an absent one.
  conference TEXT,
  off_epa REAL NOT NULL,
  off_plays INTEGER NOT NULL,
  off_success INTEGER NOT NULL,
  off_pass_epa REAL NOT NULL,
  off_pass_plays INTEGER NOT NULL,
  off_pass_success INTEGER NOT NULL,
  off_rush_epa REAL NOT NULL,
  off_rush_plays INTEGER NOT NULL,
  off_rush_success INTEGER NOT NULL,
  def_epa REAL NOT NULL,
  def_plays INTEGER NOT NULL,
  def_pass_epa REAL NOT NULL,
  def_pass_plays_faced INTEGER NOT NULL,
  def_rush_epa REAL NOT NULL,
  def_rush_plays_faced INTEGER NOT NULL,
  def_success_allowed INTEGER NOT NULL,
  defense_sign_convention TEXT NOT NULL
    CHECK (defense_sign_convention = 'negated_opponent_offense_higher_is_better'),
  -- Split success-rate numerators. Added to existing databases by 0005.
  def_pass_success_allowed INTEGER,
  def_rush_success_allowed INTEGER,
  PRIMARY KEY (event_id, team_id)
);
-- NOTE: off_pass_plays + off_rush_plays is about 1% LESS than off_plays, and
-- that is correct. The college denominator is `scrimmage_play`, which admits
-- fumble recoveries, safeties and defensive two-point conversions that are
-- neither pass nor rush. Do not add a CHECK asserting the partition; the NFL
-- table can assert it and this one cannot.
CREATE INDEX IF NOT EXISTS idx_cfb_epa_team_games_team
  ON cfb_epa_team_games(team_id, event_id);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_team_games_conference
  ON cfb_epa_team_games(conference, team_id);

CREATE TABLE IF NOT EXISTS cfb_epa_player_games (
  event_id TEXT NOT NULL REFERENCES cfb_epa_games(event_id) ON DELETE CASCADE,
  athlete_id TEXT NOT NULL,                  -- ESPN athlete id, direct
  display_name TEXT,                         -- display only; never joined on
  team_id TEXT NOT NULL,
  team TEXT,
  role TEXT NOT NULL CHECK (role IN ('passer','rusher')),
  epa REAL NOT NULL,
  opportunities INTEGER NOT NULL CHECK (opportunities > 0),
  successes INTEGER NOT NULL,
  -- College has no qb_epa equivalent, so a passer's EPA is the EPA of the
  -- plays they threw on -- a team outcome credited to the passer, not an
  -- isolated measure of them. Stored so no reader has to infer it and so it
  -- can never be quietly compared with an NFL qb_epa figure.
  epa_basis TEXT NOT NULL
    CHECK (epa_basis = 'play_epa_on_plays_where_athlete_is_named'),
  PRIMARY KEY (event_id, athlete_id, role)
);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_player_games_role
  ON cfb_epa_player_games(role, athlete_id, event_id);

CREATE TABLE IF NOT EXISTS cfb_epa_import_state (
  event_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  week INTEGER NOT NULL CHECK (week > 0),
  discovered_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- 'truncated' is its own state, distinct from 'failed' and from 'missing'.
  -- A truncated game is present and wrong, which is more dangerous than one
  -- that is plainly absent, and the three must never be collapsed into a
  -- single "not imported" count in storage or in an API response.
  status TEXT NOT NULL
    CHECK (status IN ('discovered','imported','truncated','missing','partial','failed')),
  source_hash TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_import_state_week
  ON cfb_epa_import_state(season, season_type, week, status);
CREATE TABLE IF NOT EXISTS nfl_epa_drives (
  event_id TEXT NOT NULL REFERENCES nfl_epa_games(event_id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),   -- chronological, from the source
  possession_team TEXT NOT NULL,
  start_period INTEGER,
  start_clock TEXT,
  end_period INTEGER,
  end_clock TEXT,
  result TEXT,                                       -- provider string, verbatim
  plays INTEGER,                                     -- provider play count
  yards INTEGER,                                     -- always NULL for NFL; see above
  epa REAL,                                          -- summed over modeled plays only
  modeled_plays INTEGER NOT NULL,                    -- qualifying plays we stored
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial')),
  PRIMARY KEY (event_id, drive_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_epa_drives_seq ON nfl_epa_drives(event_id, sequence);

CREATE TABLE IF NOT EXISTS cfb_epa_drives (
  event_id TEXT NOT NULL REFERENCES cfb_epa_games(event_id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  possession_team_id TEXT NOT NULL,
  possession_team TEXT,
  start_period INTEGER,
  start_clock TEXT,
  end_period INTEGER,
  end_clock TEXT,
  result TEXT,
  plays INTEGER,
  yards INTEGER,                                     -- real: cfbfastR publishes drive.yards
  epa REAL,
  modeled_plays INTEGER NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial')),
  PRIMARY KEY (event_id, drive_id)
);
CREATE INDEX IF NOT EXISTS idx_cfb_epa_drives_seq ON cfb_epa_drives(event_id, sequence);
