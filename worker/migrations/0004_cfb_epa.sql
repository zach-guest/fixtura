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
  warnings_json TEXT NOT NULL
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
