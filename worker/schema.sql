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
  --   'su'         straight up, one point a winner        (built now)
  --   'confidence' rank your picks, score the rank        (nullable int on picks)
  --   'survivor'   one team a week, no reuse, one strike  (unique index on picks)
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
