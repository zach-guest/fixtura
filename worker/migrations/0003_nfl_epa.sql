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
  warnings_json TEXT NOT NULL
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
