"""The capture-state migration is additive and is embedded verbatim in schema.sql."""
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
schema = (root / 'schema.sql').read_text()
migration = (root / 'migrations/0002_nfl_game_capture_state.sql').read_text()
# schema.sql is the canonical final schema rather than a concatenation of
# migrations (the EPA section inlines 0005's columns so the file stays
# repeat-safe), so this checks that 0002 is embedded verbatim and builds the
# pre-0002 database from the prefix before it.
assert migration in schema, 'fresh schema must embed the capture-state migration verbatim'
cut = schema.index(migration)

db = sqlite3.connect(':memory:')
db.executescript(schema[:cut])
db.execute("INSERT INTO users(id,provider,sub,name,created_at) VALUES(1,'test','capture','Test',1)")
before = db.execute('SELECT * FROM users').fetchall()
db.executescript(migration)
db.executescript(migration)
assert db.execute('SELECT * FROM users').fetchall() == before
db.execute("INSERT INTO nfl_game_capture_state(event_id,season,season_type,week,kickoff,discovered_at,last_seen_at,status) VALUES('401',2026,2,1,'2026-09-01T00:00:00Z',1,1,'discovered')")
assert db.execute("SELECT status FROM nfl_game_capture_state WHERE event_id='401'").fetchone() == ('discovered',)
print('PASS: capture-state migration is additive, repeat-safe, and embedded verbatim.')
