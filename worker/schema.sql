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
