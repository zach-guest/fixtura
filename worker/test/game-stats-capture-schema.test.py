"""The capture-state migration is additive and exactly mirrors the fresh schema tail."""
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
schema = (root / 'schema.sql').read_text()
migration = (root / 'migrations/0002_nfl_game_capture_state.sql').read_text()
assert schema.endswith(migration), 'fresh schema must append the capture-state migration verbatim'

db = sqlite3.connect(':memory:')
db.executescript(schema[:-len(migration)])
db.execute("INSERT INTO users(id,provider,sub,name,created_at) VALUES(1,'test','capture','Test',1)")
before = db.execute('SELECT * FROM users').fetchall()
db.executescript(migration)
db.executescript(migration)
assert db.execute('SELECT * FROM users').fetchall() == before
db.execute("INSERT INTO nfl_game_capture_state(event_id,season,season_type,week,kickoff,discovered_at,last_seen_at,status) VALUES('401',2026,2,1,'2026-09-01T00:00:00Z',1,1,'discovered')")
assert db.execute("SELECT status FROM nfl_game_capture_state WHERE event_id='401'").fetchone() == ('discovered',)
print('PASS: capture-state migration is additive, repeat-safe, and appended verbatim.')
