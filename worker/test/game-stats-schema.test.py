"""Migration must preserve an existing database; uses only in-memory SQLite."""
import pathlib, sqlite3
root = pathlib.Path(__file__).resolve().parents[1]
schema = (root / 'schema.sql').read_text()
migration = (root / 'migrations/0001_nfl_game_stats.sql').read_text()
capture_migration = (root / 'migrations/0002_nfl_game_capture_state.sql').read_text()
assert schema.endswith(capture_migration), 'fresh schema must end with the latest migration'
foundation_end = len(schema) - len(capture_migration)
foundation_start = foundation_end - len(migration)
assert schema[foundation_start:foundation_end] == migration, 'fresh schema must include the same player-game table definitions before capture state'
db = sqlite3.connect(':memory:')
db.executescript(schema[:foundation_start])
db.execute("INSERT INTO users(id,provider,sub,name,created_at) VALUES(1,'test','disposable','Test',1)")
db.execute("INSERT INTO pools(id,name,league,season,mode,owner_id,join_code,created_at) VALUES(1,'Test','nfl',2025,'su',1,'TEST123',1)")
db.execute("INSERT INTO picks(pool_id,user_id,event_id,week,selection_id,locks_at,created_at,updated_at) VALUES(1,1,'sample',1,'34',1,1,1)")
db.execute("INSERT INTO stat_snapshots(league,season,week,category,rank,athlete_id,value,captured_at) VALUES('nfl',2025,1,'passingYards',1,'sample',10,1)")
tables = ['users','pools','picks','stat_snapshots']
before = {t:db.execute('SELECT * FROM '+t).fetchall() for t in tables}
db.executescript(migration)
db.executescript(migration)
assert before == {t:db.execute('SELECT * FROM '+t).fetchall() for t in tables}
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
print('PASS: additive migration preserves existing account, pool, pick, and snapshot records; repeat apply is safe.')
