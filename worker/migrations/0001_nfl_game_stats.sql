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
