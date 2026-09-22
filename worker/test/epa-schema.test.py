"""EPA schema: the canonical file and the one-time migration must agree.

Two things are being kept apart here, and conflating them is the failure mode
this file exists to prevent:

  schema.sql   the CANONICAL FINAL SCHEMA for a database created from nothing.
               Every statement is `CREATE ... IF NOT EXISTS`, so it is
               REPEAT-SAFE: applying it twice is a no-op.

  0005_...sql  the ONE-TIME migration for a database that already has
               0003/0004. It uses `ALTER TABLE ADD COLUMN`, which SQLite
               cannot express conditionally, so it is NOT repeat-safe and
               migration tracking must apply it exactly once.

In-memory SQLite only. Touches no file, no local D1, and nothing remote.
"""
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
schema = (root / 'schema.sql').read_text()
m1 = (root / 'migrations/0001_nfl_game_stats.sql').read_text()
m2 = (root / 'migrations/0002_nfl_game_capture_state.sql').read_text()
m3 = (root / 'migrations/0003_nfl_epa.sql').read_text()
m4 = (root / 'migrations/0004_cfb_epa.sql').read_text()
m5 = (root / 'migrations/0005_epa_drives_and_coverage.sql').read_text()

assert 'ALTER TABLE' not in [ln.strip()[:11] for ln in schema.splitlines()], 'unreachable'
assert not any(ln.startswith('ALTER TABLE') for ln in schema.splitlines()), \
    'schema.sql must contain no executable ALTER TABLE; it is the repeat-safe canonical schema'
assert any(ln.startswith('ALTER TABLE') for ln in m5.splitlines()), \
    '0005 is the one-time migration and is expected to use ALTER TABLE'

# The base (accounts, pools, picks, snapshots) is whatever precedes 0001.
base = schema[:schema.index(m1)]


def fresh():
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys = ON')
    return db


def shape(db):
    """Table definitions as SQLite sees them — columns, indexes, foreign keys.

    Compared at pragma level rather than by SQL text: the two routes are
    written differently on purpose (one is documentation for a fresh database,
    the other a change to an existing one) and only their effect must match.
    """
    out = {}
    for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' "
                           "AND name NOT LIKE 'sqlite_%' ORDER BY 1"):
        out[t] = (
            [(r[1], r[2], r[3], r[4], r[5]) for r in db.execute(f'PRAGMA table_info("{t}")')],
            sorted((r[1], r[2]) for r in db.execute(f'PRAGMA index_list("{t}")')),
            sorted((r[2], r[3], r[4]) for r in db.execute(f'PRAGMA foreign_key_list("{t}")')),
        )
    return out


def fails(db, sql, params=()):
    try:
        db.execute(sql, params)
    except sqlite3.Error:
        return True
    return False


# --- 1. schema.sql applies twice to a fresh database ----------------------
canonical = fresh()
canonical.executescript(schema)
canonical.executescript(schema)          # must be a clean no-op
assert canonical.execute('PRAGMA foreign_key_check').fetchall() == []

# --- 2. 0003/0004 then 0005 once == fresh schema.sql ----------------------
migrated = fresh()
migrated.executescript(base)
migrated.executescript(m1)
migrated.executescript(m2)
migrated.executescript(m3)
migrated.executescript(m4)
migrated.executescript(m5)               # exactly once
a, b = shape(canonical), shape(migrated)
if a != b:
    for t in sorted(set(a) | set(b)):
        if a.get(t) != b.get(t):
            raise AssertionError(f'{t} differs between canonical schema and migration route:\n'
                                 f'  canonical: {a.get(t)}\n  migrated : {b.get(t)}')
assert len(a) >= 20, f'expected the full table set, got {len(a)}'

# --- 3. existing rows survive 0005 ----------------------------------------
# A database that already carries account, pool, pick, snapshot and EPA rows
# must come through the migration with every one of them intact.
live = fresh()
live.executescript(base)
live.executescript(m1)
live.executescript(m2)
live.executescript(m3)
live.executescript(m4)
live.execute("INSERT INTO users (id,provider,sub,name,created_at) VALUES(1,'google','epa','Test',1)")
live.execute("INSERT INTO pools (id,name,league,season,mode,owner_id,join_code,created_at) "
             "VALUES(1,'T','nfl',2026,'su',1,'EPA123',1)")
live.execute("INSERT INTO pool_members (pool_id,user_id,joined_at) VALUES(1,1,1)")
live.execute("INSERT INTO picks (pool_id,user_id,event_id,week,selection_id,locks_at,created_at,updated_at) "
             "VALUES(1,1,'401',1,'34',1,1,1)")
live.execute("INSERT INTO stat_snapshots (league,season,week,category,rank,athlete_id,value,captured_at) "
             "VALUES('nfl',2026,1,'passingYards',1,'a',10,1)")
live.execute("""INSERT INTO nfl_epa_games(event_id,nflverse_game_id,season,season_type,week,
    home_team,away_team,source_url,source_hash,parser_version,predicate_version,
    first_imported_at,imported_at,coverage,warnings_json)
    VALUES('401772810','2025_01_MIN_CHI',2025,2,1,'CHI','MIN','u','h',1,1,1,1,'complete','[]')""")
live.execute("""INSERT INTO nfl_epa_plays(event_id,play_id,possession_team,defense_team,epa,
    is_pass,is_rush,is_dropback,is_sack,is_penalty)
    VALUES('401772810','1','CHI','MIN',0.5,1,0,1,0,0)""")
live.execute("""INSERT INTO nfl_epa_team_games(event_id,team,opponent,home_away,off_epa,off_plays,
    off_success,off_pass_epa,off_dropbacks,off_pass_success,off_rush_epa,off_designed_rushes,
    off_rush_success,def_epa,def_plays,def_pass_epa,def_dropbacks_faced,def_rush_epa,
    def_designed_rushes_faced,def_success_allowed,defense_sign_convention)
    VALUES('401772810','CHI','MIN','home',0.5,1,1,0.5,1,1,0,0,0,-0.4,1,-0.4,1,0,0,0,
           'negated_opponent_offense_higher_is_better')""")
live.execute("""INSERT INTO cfb_epa_games(event_id,season,season_type,week,home_team_id,
    away_team_id,source_dataset,source_url,source_hash,parser_version,predicate_version,model,
    source_says_completed,first_imported_at,imported_at,coverage,warnings_json)
    VALUES('401856634',2026,2,1,'333','151','compiled_season_parquet','u','h',1,1,'m',1,1,1,
           'complete','[]')""")
live.commit()

TABLES = ['users', 'pools', 'pool_members', 'picks', 'stat_snapshots',
          'nfl_epa_games', 'nfl_epa_plays', 'nfl_epa_team_games', 'cfb_epa_games']
before = {t: live.execute(f'SELECT * FROM {t}').fetchall() for t in TABLES}
live.executescript(m5)
after = {t: live.execute(f'SELECT * FROM {t}').fetchall() for t in TABLES}
for t in TABLES:
    # Row COUNT and every pre-existing column value must be unchanged. The new
    # columns append to the end of the tuple, so compare the shared prefix.
    assert len(before[t]) == len(after[t]) == 1, f'{t} row count changed'
    width = len(before[t][0])
    assert before[t][0] == after[t][0][:width], f'{t} lost or altered an existing value'
    # and the new columns really are NULL, not silently defaulted to 0
    for extra in after[t][0][width:]:
        assert extra is None, f'{t} new column defaulted to {extra!r} instead of NULL'
assert live.execute('PRAGMA foreign_key_check').fetchall() == []

# --- 4. 0005 applied twice still fails, clearly ---------------------------
try:
    live.executescript(m5)
except sqlite3.OperationalError as exc:
    assert 'duplicate column' in str(exc), f'unexpected failure: {exc}'
else:
    raise AssertionError(
        '0005 uses ALTER TABLE ADD COLUMN and must NOT be repeat-safe. Migration '
        'tracking is what prevents a second application; if this migration ever '
        'becomes idempotent, this expectation needs revisiting deliberately.')

# --- constraints that carry meaning ---------------------------------------
db = canonical
BIG = '401858212104999901'                # largest observed 2026 CFB play id
assert int(BIG) > 2 ** 53                 # beyond Number.MAX_SAFE_INTEGER
db.execute("""INSERT INTO cfb_epa_games(event_id,season,season_type,week,home_team_id,away_team_id,
    source_dataset,source_url,source_hash,parser_version,predicate_version,model,
    source_says_completed,first_imported_at,imported_at,coverage,warnings_json)
    VALUES('401856634',2026,2,1,'333','151','compiled_season_parquet','https://example/x','h',1,1,'m',1,1,1,'complete','[]')""")
db.execute("""INSERT INTO cfb_epa_plays(event_id,play_id,possession_team_id,defense_team_id,epa,
    is_pass,is_rush,is_sack,is_penalty_no_play) VALUES('401856634',?, '333','151',0.5,1,0,0,0)""", (BIG,))
got = db.execute('SELECT play_id FROM cfb_epa_plays').fetchone()[0]
assert got == BIG and isinstance(got, str), f'play id must round-trip as text, got {got!r}'

db.execute("""INSERT INTO cfb_epa_plays(event_id,play_id,possession_team_id,defense_team_id,epa,
    success,is_pass,is_rush,is_sack,is_penalty_no_play) VALUES('401856634','2','333','151',0.1,NULL,1,0,0,0)""")
assert db.execute("SELECT success FROM cfb_epa_plays WHERE play_id='2'").fetchone()[0] is None
assert fails(db, """INSERT INTO cfb_epa_plays(event_id,play_id,possession_team_id,defense_team_id,epa,
    success,is_pass,is_rush,is_sack,is_penalty_no_play) VALUES('401856634','3','333','151',0.1,7,1,0,0,0)"""), \
    'success must be constrained to 0, 1 or NULL'

team = """INSERT INTO cfb_epa_team_games(event_id,team_id,opponent_id,home_away,off_epa,off_plays,
    off_success,off_pass_epa,off_pass_plays,off_pass_success,off_rush_epa,off_rush_plays,off_rush_success,
    def_epa,def_plays,def_pass_epa,def_pass_plays_faced,def_rush_epa,def_rush_plays_faced,
    def_success_allowed,defense_sign_convention) VALUES('401856634','333','151',?,1,1,1,1,1,1,1,1,1,-1,1,-1,1,-1,1,1,?)"""
assert fails(db, team, ('home', 'higher_is_worse')), 'defense_sign_convention must be pinned'
assert fails(db, team, ('sideways', 'negated_opponent_offense_higher_is_better')), 'home_away is constrained'
db.execute(team, ('neutral', 'negated_opponent_offense_higher_is_better'))

state = "INSERT INTO cfb_epa_import_state(event_id,season,season_type,week,discovered_at,status) VALUES(?,2026,2,1,1,?)"
for status in ('discovered', 'imported', 'truncated', 'missing', 'partial', 'failed'):
    db.execute(state, (f'e-{status}', status))
assert fails(db, state, ('e-bogus', 'not_imported')), \
    'truncated / missing / failed must stay distinct states, not collapse into one'

assert fails(db, """INSERT INTO cfb_epa_player_games(event_id,athlete_id,team_id,role,epa,opportunities,
    successes,epa_basis) VALUES('401856634','1','333','qb',1,1,1,'play_epa_on_plays_where_athlete_is_named')"""), \
    "CFB roles are passer/rusher -- 'qb' is the NFL role and must not be accepted"
db.execute("""INSERT INTO cfb_epa_player_games(event_id,athlete_id,team_id,role,epa,opportunities,
    successes,epa_basis) VALUES('401856634','1','333','passer',1,1,1,'play_epa_on_plays_where_athlete_is_named')""")

db.execute("""INSERT INTO nfl_epa_games(event_id,nflverse_game_id,season,season_type,week,home_team,
    away_team,source_url,source_hash,parser_version,predicate_version,first_imported_at,imported_at,
    coverage,warnings_json) VALUES('401772810','2025_01_MIN_CHI',2025,2,1,'CHI','MIN','https://example/y','h',1,1,1,1,'complete','[]')""")
assert fails(db, """INSERT INTO nfl_epa_player_games(event_id,gsis_id,team,role,epa,opportunities,successes)
    VALUES('401772810','00-1','CHI','passer',1,1,1)"""), \
    "NFL roles are qb/rusher -- 'passer' is the CFB role and must not be accepted"
db.execute("""INSERT INTO nfl_epa_player_games(event_id,gsis_id,team,role,epa,opportunities,successes)
    VALUES('401772810','00-1','CHI','qb',1,1,1)""")
assert db.execute("SELECT espn_athlete_id FROM nfl_epa_player_games").fetchone()[0] is None

db.execute("""INSERT INTO cfb_epa_drives(event_id,drive_id,sequence,possession_team_id,
    result,plays,yards,epa,modeled_plays,coverage)
    VALUES('401856634','d1',1,'333','PUNT',3,19,-0.5,3,'complete')""")
assert fails(db, """INSERT INTO cfb_epa_drives(event_id,drive_id,sequence,possession_team_id,
    modeled_plays,coverage) VALUES('401856634','d2',2,'333',1,'unknown')"""), \
    'drive coverage is constrained to complete/partial'
assert db.execute("SELECT yards FROM cfb_epa_drives").fetchone()[0] == 19

assert db.execute('SELECT count(*) FROM cfb_epa_drives').fetchone()[0] == 1
db.execute("DELETE FROM cfb_epa_games WHERE event_id='401856634'")
assert db.execute('SELECT count(*) FROM cfb_epa_plays').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM cfb_epa_team_games').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM cfb_epa_player_games').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM cfb_epa_drives').fetchone()[0] == 0, 'drives cascade too'

print('PASS: schema.sql is repeat-safe and canonical; 0003/0004+0005-once matches it exactly; '
      'accounts, pools, picks, snapshots and EPA rows survive 0005 with new columns NULL; '
      '0005 twice still fails on a duplicate column; text play ids survive past 2^53; '
      'nullable success, pinned sign convention, distinct coverage states, per-league roles, '
      'drive constraints and cascade deletes all hold.')
