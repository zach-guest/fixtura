/**
 * Correction-aware atomic storage, against a real SQLite database built from
 * the actual schema.sql — not a mock. D1 is SQLite, so the constraints,
 * json_each expansion and conflict clauses all behave the way they will in
 * production. Nothing here touches a local or remote D1 binding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ingestEpaGame, recordImportState } from '../src/epa-store.js';
import { validateNflEpaPayload, validateCfbEpaPayload } from '../src/epa-validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

/** The slice of D1's interface epa-store.js actually uses, over node:sqlite. */
function d1(db) {
  const run = (sql, params) => {
    const stmt = db.prepare(sql);
    const info = stmt.run(...params);
    return { meta: { changes: info.changes }, results: [] };
  };
  const prepare = (sql) => ({
    bind: (...params) => ({
      first: () => db.prepare(sql).get(...params) ?? null,
      all: () => ({ results: db.prepare(sql).all(...params) }),
      run: () => run(sql, params),
      __sql: sql, __params: params,
    }),
  });
  return {
    prepare,
    // D1's batch is atomic. node:sqlite gives us a real transaction, so a
    // failing statement rolls the whole thing back exactly as D1 would.
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => run(s.__sql, s.__params));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return { db, DB: d1(db) };
}

const nflPlay = (over = {}) => ({
  play_id: '1', drive: '1', quarter: 1, clock: '15:00', down: 1, yards_to_go: 10,
  yardline_100: 75, possession_team: 'CHI', defense_team: 'MIN', play_type: 'pass',
  description: 'a pass', ep_before: 1.2, epa: 0.5, qb_epa: 0.5, success: 1,
  is_pass: true, is_rush: false, is_dropback: true, is_sack: false, is_penalty: false,
  passer_gsis_id: '00-0039918', rusher_gsis_id: null, receiver_gsis_id: null, ...over,
});

const nflPayload = (over = {}) => ({
  league: 'nfl', event_id: '401772810', nflverse_game_id: '2025_01_MIN_CHI',
  season: 2025, season_type_espn: 2, week: 1, home_team: 'CHI', away_team: 'MIN',
  gameday: '2025-09-08', overtime: false, predicate_version: 1,
  source: { pbp_url: 'https://example/pbp.parquet' },
  plays: [nflPlay(), nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' })],
  ...over,
});

const BIG_PLAY_ID = '401858212104999901';
const cfbPayload = (over = {}) => ({
  league: 'cfb', event_id: '401856634', season: 2026, season_type_espn: 2, week: 1,
  home_team_id: '333', away_team_id: '151', source_says_completed: true,
  predicate_version: 1, model: 'cfbfastR/SportsDataverse college expected points',
  source: { pbp_url: 'https://example/cfb.parquet', release_timestamp: { last_updated: '2026-09-09 11:12:05 EDT' } },
  plays: [
    { play_id: BIG_PLAY_ID, play_number: 1, drive_id: '4018582121', period: 1, clock: '15:00',
      down: 1, yards_to_go: 10, yards_to_endzone: 75, possession_team_id: '333',
      possession_team: 'Alabama', defense_team_id: '151', defense_team: 'East Carolina',
      play_type: 'Pass Reception', description: 'pass', ep_before: 1.1, epa: 0.4, success: 1,
      is_pass: true, is_rush: false, is_sack: false, is_penalty_no_play: true,
      passer_athlete_id: '5144959', rusher_athlete_id: null, receiver_athlete_id: null },
    { play_id: '401858212104999902', play_number: 2, drive_id: '4018582122', period: 1, clock: '10:00',
      down: 1, yards_to_go: 10, yards_to_endzone: 60, possession_team_id: '151',
      possession_team: 'East Carolina', defense_team_id: '333', defense_team: 'Alabama',
      play_type: 'Rush', description: 'run', ep_before: 1.0, epa: -0.2, success: 0,
      is_pass: false, is_rush: true, is_sack: false, is_penalty_no_play: false,
      passer_athlete_id: null, rusher_athlete_id: '4877259', receiver_athlete_id: null },
  ],
  ...over,
});

const counts = (db, league) => ({
  games: db.prepare(`SELECT count(*) c FROM ${league}_epa_games`).get().c,
  plays: db.prepare(`SELECT count(*) c FROM ${league}_epa_plays`).get().c,
  teams: db.prepare(`SELECT count(*) c FROM ${league}_epa_team_games`).get().c,
  players: db.prepare(`SELECT count(*) c FROM ${league}_epa_player_games`).get().c,
});

test('inserts a game, its plays, team rows and player rows in one batch', async () => {
  const { db, DB } = fresh();
  const out = await ingestEpaGame(DB, validateNflEpaPayload(nflPayload()), { importedAt: 1000 });
  assert.equal(out.status, 'inserted');
  assert.deepEqual(counts(db, 'nfl'), { games: 1, plays: 2, teams: 2, players: 2 });
  const chi = db.prepare("SELECT * FROM nfl_epa_team_games WHERE team = 'CHI'").get();
  assert.equal(chi.off_plays, 1);
  assert.equal(Math.round(chi.def_epa * 100) / 100, 0.4);   // negation of MIN's -0.4
  assert.equal(chi.defense_sign_convention, 'negated_opponent_offense_higher_is_better');
});

test('re-importing identical data is unchanged and writes nothing', async () => {
  const { db, DB } = fresh();
  const n = validateNflEpaPayload(nflPayload());
  await ingestEpaGame(DB, n, { importedAt: 1000 });
  const first = db.prepare('SELECT first_imported_at, imported_at, source_hash FROM nfl_epa_games').get();
  const again = await ingestEpaGame(DB, n, { importedAt: 2000 });
  assert.equal(again.status, 'unchanged');
  const after = db.prepare('SELECT first_imported_at, imported_at, source_hash FROM nfl_epa_games').get();
  assert.deepEqual(after, first, 'an unchanged re-import must not touch the row at all');
  assert.deepEqual(counts(db, 'nfl'), { games: 1, plays: 2, teams: 2, players: 2 });
});

test('a correction replaces children atomically and keeps first_imported_at', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateNflEpaPayload(nflPayload()), { importedAt: 1000 });
  const corrected = nflPayload({
    plays: [
      nflPlay({ epa: 0.9, qb_epa: 0.9 }),
      nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' }),
      nflPlay({ play_id: '3', epa: 0.1, qb_epa: 0.1, success: 0 }),
    ],
  });
  const out = await ingestEpaGame(DB, validateCorrected(corrected), { importedAt: 2000 });
  assert.equal(out.status, 'updated');
  assert.deepEqual(counts(db, 'nfl'), { games: 1, plays: 3, teams: 2, players: 2 });
  const row = db.prepare('SELECT first_imported_at, imported_at FROM nfl_epa_games').get();
  assert.equal(row.first_imported_at, 1000, 'first_imported_at survives a correction');
  assert.equal(row.imported_at, 2000);
  const chi = db.prepare("SELECT off_epa, off_plays FROM nfl_epa_team_games WHERE team = 'CHI'").get();
  assert.equal(chi.off_plays, 2);
  assert.equal(Math.round(chi.off_epa * 100) / 100, 1);
});

function validateCorrected(p) { return validateNflEpaPayload(p); }

test('an older import never overwrites a newer one', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateNflEpaPayload(nflPayload()), { importedAt: 5000 });
  const older = await ingestEpaGame(DB, validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ epa: 99, qb_epa: 99 }), nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' })],
  })), { importedAt: 1000 });
  assert.equal(older.status, 'stale');
  const chi = db.prepare("SELECT off_epa FROM nfl_epa_team_games WHERE team = 'CHI'").get();
  assert.equal(Math.round(chi.off_epa * 100) / 100, 0.5, 'the newer data survived');
});

test('a CFB play id past 2**53 round-trips exactly through storage', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateCfbEpaPayload(cfbPayload()), { importedAt: 1000 });
  const row = db.prepare('SELECT play_id FROM cfb_epa_plays ORDER BY play_id LIMIT 1').get();
  assert.equal(row.play_id, BIG_PLAY_ID);
  assert.equal(typeof row.play_id, 'string');
});

test('CFB stores the penalty-no-play audit flag and the completeness flag', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateCfbEpaPayload(cfbPayload()), { importedAt: 1000 });
  assert.equal(db.prepare('SELECT is_penalty_no_play FROM cfb_epa_plays WHERE play_id = ?').get(BIG_PLAY_ID).is_penalty_no_play, 1);
  assert.equal(db.prepare('SELECT source_says_completed FROM cfb_epa_games').get().source_says_completed, 1);
  assert.equal(db.prepare('SELECT epa_basis FROM cfb_epa_player_games LIMIT 1').get().epa_basis, 'play_epa_on_plays_where_athlete_is_named');
});

test('the content hash ignores cosmetic renames but not the numbers', async () => {
  const { DB } = fresh();
  const base = cfbPayload();
  await ingestEpaGame(DB, validateCfbEpaPayload(base), { importedAt: 1000 });
  // Same plays, team label spelled differently upstream: not a correction.
  const renamed = cfbPayload({
    plays: base.plays.map((p) => ({ ...p, possession_team: p.possession_team + ' Crimson Tide', defense_team: 'ECU' })),
  });
  assert.equal((await ingestEpaGame(DB, validateCfbEpaPayload(renamed), { importedAt: 2000 })).status, 'unchanged');
  // A changed EPA is a correction.
  const changed = cfbPayload({ plays: base.plays.map((p, i) => (i === 0 ? { ...p, epa: 0.45 } : p)) });
  assert.equal((await ingestEpaGame(DB, validateCfbEpaPayload(changed), { importedAt: 3000 })).status, 'updated');
});

test('the two leagues do not collide on the same event id', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateNflEpaPayload(nflPayload({ event_id: '401856634' })), { importedAt: 1000 });
  await ingestEpaGame(DB, validateCfbEpaPayload(cfbPayload()), { importedAt: 1000 });
  assert.equal(counts(db, 'nfl').games, 1);
  assert.equal(counts(db, 'cfb').games, 1);
  assert.equal(counts(db, 'nfl').plays, 2);
  assert.equal(counts(db, 'cfb').plays, 2);
});

test('import state records an attempt, including one that never validated', async () => {
  const { db, DB } = fresh();
  const game = { event_id: '401999999', season: 2026, season_type: 2, week: 3 };
  await recordImportState(DB, 'cfb', game, { importedAt: 1000, status: 'failed', error: 'bad payload' });
  let row = db.prepare('SELECT * FROM cfb_epa_import_state').get();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.last_success_at, null);
  await recordImportState(DB, 'cfb', game, { importedAt: 2000, status: 'imported', sourceHash: 'abc' });
  row = db.prepare('SELECT * FROM cfb_epa_import_state').get();
  assert.equal(row.status, 'imported');
  assert.equal(row.attempt_count, 2, 'attempts accumulate rather than reset');
  assert.equal(row.last_success_at, 2000);
});

test('deleting a game cascades to every child row', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateCfbEpaPayload(cfbPayload()), { importedAt: 1000 });
  db.prepare('DELETE FROM cfb_epa_games WHERE event_id = ?').run('401856634');
  assert.deepEqual(counts(db, 'cfb'), { games: 0, plays: 0, teams: 0, players: 0 });
});

/* Every child row of one league's game, keyed and ordered, for comparing two
   databases row for row. */
function childRows(db, league) {
  const out = {};
  for (const t of ['plays', 'team_games', 'player_games', 'drives']) {
    out[t] = db.prepare(`SELECT * FROM ${league}_epa_${t} ORDER BY 1, 2, 3`).all()
      .map((r) => JSON.stringify(r, Object.keys(r).sort()));
  }
  return out;
}

test('a correction writes only the rows that changed and ends identical to a fresh import', async () => {
  const original = nflPayload({
    plays: [
      nflPlay(),
      nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' }),
      nflPlay({ play_id: '3', epa: 0.1, qb_epa: 0.1, success: 0 }),
    ],
  });
  // Play 1 corrected, play 3 removed by the provider, play 2 untouched.
  const corrected = nflPayload({
    plays: [
      nflPlay({ epa: 0.9, qb_epa: 0.9 }),
      nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' }),
    ],
  });

  const a = fresh();
  await ingestEpaGame(a.DB, validateNflEpaPayload(original), { importedAt: 1000 });
  const out = await ingestEpaGame(a.DB, validateNflEpaPayload(corrected), { importedAt: 2000 });
  assert.equal(out.status, 'updated');
  assert.deepEqual(out.changed.nfl_epa_plays, { upserted: 1, deleted: 1 }, 'only play 1 rewritten, play 3 deleted');

  const b = fresh();
  await ingestEpaGame(b.DB, validateNflEpaPayload(corrected), { importedAt: 2000 });
  assert.deepEqual(childRows(a.db, 'nfl'), childRows(b.db, 'nfl'));
  assert.equal(a.db.prepare('SELECT source_hash FROM nfl_epa_games').get().source_hash,
    b.db.prepare('SELECT source_hash FROM nfl_epa_games').get().source_hash);
});

test('CFB: a correction diff ends identical to a fresh import, big play ids included', async () => {
  const base = cfbPayload();
  const corrected = cfbPayload({ plays: [{ ...base.plays[0], epa: 0.75 }] });
  const a = fresh();
  await ingestEpaGame(a.DB, validateCfbEpaPayload(base), { importedAt: 1000 });
  const out = await ingestEpaGame(a.DB, validateCfbEpaPayload(corrected), { importedAt: 2000 });
  assert.equal(out.status, 'updated');
  assert.deepEqual(out.changed.cfb_epa_plays, { upserted: 1, deleted: 1 });
  const b = fresh();
  await ingestEpaGame(b.DB, validateCfbEpaPayload(corrected), { importedAt: 2000 });
  assert.deepEqual(childRows(a.db, 'cfb'), childRows(b.db, 'cfb'));
  assert.equal(a.db.prepare('SELECT play_id FROM cfb_epa_plays').get().play_id, BIG_PLAY_ID);
});

test('a diff computed against rows that changed underneath it is re-read, not stacked', async () => {
  const { db, DB } = fresh();
  await ingestEpaGame(DB, validateNflEpaPayload(nflPayload()), { importedAt: 1000 });
  // Simulate another import landing between our read and our batch: the
  // first batch this ingest sends sees a different stored hash.
  // It changes play 2, which OUR diff (computed before it landed) treats as
  // unchanged — so only a re-read can put play 2 back to what we are importing.
  const other = nflPayload({ plays: [nflPlay(), nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -1.5, qb_epa: -1.5, success: 0, passer_gsis_id: '00-0039923' })] });
  let interleaved = false;
  const racing = { ...DB, batch: async (stmts) => {
    if (!interleaved) { interleaved = true; await ingestEpaGame(DB, validateNflEpaPayload(other), { importedAt: 1500 }); }
    return DB.batch(stmts);
  } };
  const mine = nflPayload({ plays: [nflPlay({ epa: 0.9, qb_epa: 0.9 }), nflPlay({ play_id: '2', possession_team: 'MIN', defense_team: 'CHI', epa: -0.4, qb_epa: -0.4, success: 0, passer_gsis_id: '00-0039923' })] });
  const out = await ingestEpaGame(racing, validateNflEpaPayload(mine), { importedAt: 2000 });
  assert.equal(out.status, 'updated');
  const b = fresh();
  await ingestEpaGame(b.DB, validateNflEpaPayload(mine), { importedAt: 2000 });
  assert.deepEqual(childRows(db, 'nfl'), childRows(b.db, 'nfl'));
});
