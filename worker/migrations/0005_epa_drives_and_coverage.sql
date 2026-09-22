-- Drive summaries, split success numerators, and coverage/provenance counts.
-- Additive. Required by the accepted Game Center contract in
-- NFL-IMPLEMENTATION-PLAN.md ("Game response contract").
--
-- ⚠ NOT REPEAT-SAFE, unlike 0001-0004. SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so the ALTER statements below
-- fail if run twice. Apply exactly once per database. This is the shape every
-- real column addition has to take (hard-won detail 26: `CREATE TABLE IF NOT
-- EXISTS` silently does NOT add a column to a table that already exists), and
-- pretending otherwise is what made that a hard-won detail in the first place.
--
-- New columns are NULLABLE with no default on purpose. A default of 0 would
-- assert that pre-existing rows had zero split successes and zero modeled
-- plays, which is a claim about data nobody measured. NULL means unknown; the
-- import path always writes a real value.

-- ---------------------------------------------------------------- drives --
-- Provider drive summaries, never inferred. Both upstreams publish these
-- fields directly:
--   nflverse: fixed_drive, fixed_drive_result, drive_play_count,
--             drive_quarter_start/end, drive_game_clock_start/end
--   cfbfastR: drive.id, drive.result, drive.offensivePlays, drive.yards,
--             drive.start/end.period.number, drive.start/end.clock.displayValue
--
-- `yards` is NULLABLE and is NULL for every NFL drive, because nflverse
-- publishes no drive net-yards field. It has drive_start_yard_line and
-- drive_end_yard_line as TEXT ("MIN 25"), and subtracting those is a
-- field-position delta -- exactly the inference the contract forbids. An
-- em dash in the UI is correct; a computed number would not be.

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

-- ------------------------------------------- split success-rate numerators --
-- Without these, a pass or rush success rate can only be produced by dividing
-- an all-play success count by a split denominator, which is a different
-- quantity wearing the right label. Defensive splits are the negated mirror:
-- the opponent's offensive split successes.

ALTER TABLE nfl_epa_team_games ADD COLUMN def_pass_success_allowed INTEGER;
ALTER TABLE nfl_epa_team_games ADD COLUMN def_rush_success_allowed INTEGER;
ALTER TABLE cfb_epa_team_games ADD COLUMN def_pass_success_allowed INTEGER;
ALTER TABLE cfb_epa_team_games ADD COLUMN def_rush_success_allowed INTEGER;

-- ------------------------------------------------ coverage and provenance --
-- The contract requires modeled/eligible counts for plays AND drives, so the
-- UI can say "129 of 129 plays, 22 of 22 drives" rather than implying a
-- complete game from a non-empty array.
--
-- eligible_* is what the source contained for this game; modeled_/complete_*
-- is what passed the qualifying predicate and was stored. They differ for
-- ordinary reasons (kickoffs, punts, kneels), so both are kept.

ALTER TABLE nfl_epa_games ADD COLUMN eligible_plays INTEGER;
ALTER TABLE nfl_epa_games ADD COLUMN modeled_plays INTEGER;
ALTER TABLE nfl_epa_games ADD COLUMN eligible_drives INTEGER;
ALTER TABLE nfl_epa_games ADD COLUMN complete_drives INTEGER;
ALTER TABLE nfl_epa_games ADD COLUMN model TEXT;
ALTER TABLE nfl_epa_games ADD COLUMN model_version TEXT;

ALTER TABLE cfb_epa_games ADD COLUMN eligible_plays INTEGER;
ALTER TABLE cfb_epa_games ADD COLUMN modeled_plays INTEGER;
ALTER TABLE cfb_epa_games ADD COLUMN eligible_drives INTEGER;
ALTER TABLE cfb_epa_games ADD COLUMN complete_drives INTEGER;
ALTER TABLE cfb_epa_games ADD COLUMN model_version TEXT;
