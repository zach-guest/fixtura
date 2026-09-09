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
