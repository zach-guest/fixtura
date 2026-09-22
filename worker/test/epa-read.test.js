/**
 * EPA read routes, exercised through `handleEpaRead` against a real SQLite
 * database built from `schema.sql`. These assert exact response shapes from
 * the accepted contract in NFL-IMPLEMENTATION-PLAN.md, not just status codes.
 *
 * Fixtures are deliberately asymmetric — different pass and rush counts, and
 * different success counts per split — so a denominator or numerator mix-up
 * produces a wrong number rather than a coincidentally right one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleEpaRead } from '../src/epa-read.js';
import { ingestEpaGame } from '../src/epa-store.js';
import { validateNflEpaPayload, validateCfbEpaPayload } from '../src/epa-validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
const ORIGIN = 'https://zach-guest.github.io';

function d1(db) {
  const run = (sql, params) => ({ meta: { changes: db.prepare(sql).run(...params).changes }, results: [] });
  return {
    prepare: (sql) => ({
      bind: (...params) => ({
        first: () => db.prepare(sql).get(...params) ?? null,
        all: () => ({ results: db.prepare(sql).all(...params) }),
        run: () => run(sql, params),
        __sql: sql, __params: params,
      }),
    }),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => run(s.__sql, s.__params));
        db.exec('COMMIT');
        return out;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}

async function read(env, path) {
  const url = new URL(path, 'https://api.test');
  const segments = url.pathname.split('/').filter(Boolean);
  const res = await handleEpaRead(new Request(url, { method: 'GET' }), segments, env, {}, ORIGIN);
  return { res, body: await res.clone().json() };
}

/* ---------------------------------------------------------- fixtures -- */

// CHI: 3 dropbacks (2 successes), 2 designed rushes (1 success)
// MIN: 2 dropbacks (0 successes), 1 designed rush (1 success)
// Asymmetric on purpose: 5 CHI plays vs 3 MIN, and split successes that do
// not equal all-play successes.
const NFL_PLAYS = [
  ['1', 'CHI', 'MIN', true, false, 0.5, 1],
  ['2', 'CHI', 'MIN', true, false, 0.4, 1],
  ['3', 'CHI', 'MIN', true, false, -0.9, 0],
  ['4', 'CHI', 'MIN', false, true, 0.3, 1],
  ['5', 'CHI', 'MIN', false, true, -0.2, 0],
  ['6', 'MIN', 'CHI', true, false, -0.6, 0],
  ['7', 'MIN', 'CHI', true, false, -0.1, 0],
  ['8', 'MIN', 'CHI', false, true, 1.2, 1],
];

function nflPayload(over = {}) {
  const plays = NFL_PLAYS.map(([id, pos, def, isPass, isRush, epa, success], i) => ({
    play_id: id, drive: String(Math.floor(i / 3) + 1), quarter: 1, clock: `1${i}:00`,
    down: 1, yards_to_go: 10, yardline_100: 70, possession_team: pos, defense_team: def,
    play_type: isPass ? 'pass' : 'run', description: `play ${id}`, ep_before: 1,
    epa, qb_epa: isPass ? epa : null, success,
    is_pass: isPass, is_rush: isRush, is_dropback: isPass, is_sack: false, is_penalty: false,
    passer_gsis_id: isPass ? (pos === 'CHI' ? '00-CHIQB' : '00-MINQB') : null,
    rusher_gsis_id: isRush ? (pos === 'CHI' ? '00-CHIRB' : '00-MINRB') : null,
    receiver_gsis_id: null,
  }));
  return {
    league: 'nfl', event_id: '401700001', nflverse_game_id: '2098_01_MIN_CHI',
    season: 2098, season_type_espn: 2, week: 1, home_team: 'CHI', away_team: 'MIN',
    gameday: '2098-09-07', overtime: false, predicate_version: 1,
    source: { pbp_url: 'https://example.invalid/pbp.parquet', pbp_last_modified: 'Wed, 13 Aug 2098 12:26:09 GMT' },
    plays,
    drives: [
      { drive_id: '1', sequence: 1, possession_team: 'CHI', start_period: 1, start_clock: '15:00',
        end_period: 1, end_clock: '12:00', result: 'Punt', plays: 3, yards: null, epa: 0,
        modeled_plays: 3, coverage: 'complete' },
      { drive_id: '2', sequence: 2, possession_team: 'MIN', start_period: 1, start_clock: '12:00',
        end_period: 1, end_clock: '08:00', result: 'Touchdown', plays: 6, yards: null, epa: 0.5,
        modeled_plays: 3, coverage: 'partial' },
      { drive_id: '3', sequence: 3, possession_team: 'CHI', start_period: 2, start_clock: '15:00',
        end_period: 2, end_clock: '11:00', result: 'Field Goal', plays: 2, yards: null, epa: 0.1,
        modeled_plays: 2, coverage: 'complete' },
    ],
    coverage: { eligible_plays: 14, eligible_drives: 3 },
    ...over,
  };
}

const CFB_BIG = '401858212104999901';
function cfbPayload(over = {}) {
  const mk = (n, pos, def, isPass, epa, success) => ({
    play_id: String(BigInt(CFB_BIG) + BigInt(n)), play_number: n, drive_id: `40185821${Math.floor(n / 3) + 1}`,
    period: 1, clock: `1${n}:00`, down: 1, yards_to_go: 10, yards_to_endzone: 70,
    possession_team_id: pos, possession_team: pos === '333' ? 'Alabama' : 'East Carolina',
    defense_team_id: def, defense_team: def === '333' ? 'Alabama' : 'East Carolina',
    play_type: isPass ? 'Pass Reception' : 'Rush', description: `play ${n}`, ep_before: 1,
    epa, success, is_pass: isPass, is_rush: !isPass, is_sack: false, is_penalty_no_play: false,
    passer_athlete_id: isPass ? (pos === '333' ? '5000001' : '5000002') : null,
    rusher_athlete_id: isPass ? null : (pos === '333' ? '5000003' : '5000004'),
    receiver_athlete_id: null,
  });
  return {
    league: 'cfb', event_id: '401700002', season: 2098, season_type_espn: 2, week: 1,
    home_team_id: '333', away_team_id: '151', source_says_completed: true, predicate_version: 1,
    model: 'cfbfastR/SportsDataverse college expected points',
    source: { pbp_url: 'https://example.invalid/cfb.parquet', release_timestamp: { last_updated: '2098-09-09 11:12:05 EDT' } },
    plays: [
      mk(1, '333', '151', true, 0.8, 1), mk(2, '333', '151', true, -0.3, 0),
      mk(3, '333', '151', false, 0.2, 1), mk(4, '151', '333', true, -0.5, 0),
      mk(5, '151', '333', false, 0.9, 1),
    ],
    drives: [
      { drive_id: '401858211', sequence: 1, possession_team_id: '333', possession_team: 'Alabama',
        start_period: 1, start_clock: '15:00', end_period: 1, end_clock: '11:00', result: 'PUNT',
        plays: 3, yards: 19, epa: 0.7, modeled_plays: 3, coverage: 'complete' },
      { drive_id: '401858212', sequence: 2, possession_team_id: '151', possession_team: 'East Carolina',
        start_period: 1, start_clock: '11:00', end_period: 1, end_clock: '07:00', result: 'TD',
        plays: 4, yards: 75, epa: 0.4, modeled_plays: 2, coverage: 'partial' },
    ],
    coverage: { eligible_plays: 9, eligible_drives: 2 },
    ...over,
  };
}

async function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const env = { DB: d1(db) };
  await ingestEpaGame(env.DB, validateNflEpaPayload(nflPayload()), { importedAt: 1_700_000_000 });
  await ingestEpaGame(env.DB, validateCfbEpaPayload(cfbPayload()), { importedAt: 1_700_000_000 });
  return { db, env };
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b}`);

/* -------------------------------------------------------------- tests -- */

test('game: teams come back away then home', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  assert.deepEqual(body.teams.map((t) => t.homeAway), ['away', 'home']);
  assert.equal(body.teams[0].teamId, 'MIN');   // away
  assert.equal(body.teams[1].teamId, 'CHI');   // home
});

test('game: split rates use their own denominators and numerators', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  const chi = body.teams.find((t) => t.teamId === 'CHI').offense;
  assert.equal(chi.plays, 5);
  assert.equal(chi.dropbacks, 3);
  assert.equal(chi.designedRushes, 2);
  // pass EPA over dropbacks, NOT over all plays
  near(chi.passEpaPerDropback.value, (0.5 + 0.4 - 0.9) / 3);
  assert.equal(chi.passEpaPerDropback.denominator, 3);
  near(chi.rushEpaPerDesignedRush.value, (0.3 - 0.2) / 2);
  assert.equal(chi.rushEpaPerDesignedRush.denominator, 2);
  // split success numerators are their own, not the all-play count
  assert.equal(chi.successRate.numerator, 3);       // 2 pass + 1 rush
  assert.equal(chi.passSuccessRate.numerator, 2);
  assert.equal(chi.passSuccessRate.denominator, 3);
  assert.equal(chi.rushSuccessRate.numerator, 1);
  assert.equal(chi.rushSuccessRate.denominator, 2);
});

test('game: defensive splits divide by plays faced, not all defensive plays', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  const chiDef = body.teams.find((t) => t.teamId === 'CHI').defense;
  // CHI's defense faced MIN's offense: 2 dropbacks, 1 designed rush
  assert.equal(chiDef.plays, 3);
  assert.equal(chiDef.dropbacksFaced, 2);
  assert.equal(chiDef.designedRushesFaced, 1);
  near(chiDef.passEpa, 0.7);                        // negation of MIN's -0.7
  near(chiDef.passEpaPerDropback.value, 0.7 / 2);
  assert.equal(chiDef.passEpaPerDropback.denominator, 2);
  near(chiDef.rushEpaPerDesignedRush.value, -1.2 / 1);
  // split success allowed mirrors the opponent's split successes
  assert.equal(chiDef.passSuccessRateAllowed.numerator, 0);
  assert.equal(chiDef.passSuccessRateAllowed.denominator, 2);
  assert.equal(chiDef.rushSuccessRateAllowed.numerator, 1);
  assert.equal(chiDef.rushSuccessRateAllowed.denominator, 1);
});

test('game: drives come back in sequence with provider fields', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  assert.deepEqual(body.drives.map((d) => d.sequence), [1, 2, 3]);
  const first = body.drives[0];
  assert.equal(first.driveId, '1');
  assert.equal(first.possessionTeamId, 'CHI');
  assert.equal(first.startPeriod, 1);
  assert.equal(first.startClock, '15:00');
  assert.equal(first.endClock, '12:00');
  assert.equal(first.result, 'Punt');
  assert.equal(first.plays, 3);
  assert.equal(first.coverage, 'complete');
  assert.equal(body.drives[1].coverage, 'partial');
  assert.equal(body.drives[1].modeledPlays, 3);
});

test('game: NFL drive yards are null, never inferred', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  assert.ok(body.drives.every((d) => d.yards === null));
  assert.ok(body.coverage.warnings.some((w) => /no drive net-yards field/.test(w)));
});

test('game: CFB drive yards are real provider values', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/cfb/epa/games/401700002');
  assert.deepEqual(body.drives.map((d) => d.yards), [19, 75]);
  assert.equal(body.drives[0].result, 'PUNT');
});

test('game: impact plays carry clock and driveId, sorted by |EPA| then playId', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  const p = body.impactPlays;
  assert.equal(p.length, 5);
  for (const row of p) {
    assert.ok(typeof row.clock === 'string' && row.clock.length > 0, 'clock present');
    assert.ok(typeof row.driveId === 'string' && row.driveId.length > 0, 'driveId present');
    assert.ok(typeof row.playId === 'string');
    assert.ok(typeof row.period === 'number');
  }
  const mags = p.map((r) => Math.abs(r.epa));
  assert.deepEqual(mags, [...mags].sort((a, b) => b - a), 'descending absolute EPA');
});

test('game: equal-magnitude plays break the tie deterministically by play id', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const env = { DB: d1(db) };
  // Every play has |EPA| = 0.5, so only the play-id order can decide.
  //
  // Honest limitation: this assertion does NOT detect removal of the explicit
  // `play_id ASC` tiebreaker. The plays table's primary key is
  // (event_id, play_id), so a WHERE on event_id already walks that index and
  // SQLite's stable sort preserves play-id order among ties even without it —
  // measured, with ids inserted in descending order (9,7,5,3,2,1) so natural
  // insertion order differs; both orderings return 1,2,3,5,7.
  //
  // The explicit tiebreaker stays because the contract requires a deterministic
  // order and incidental index behaviour is not a guarantee: a different query
  // plan, a schema change, or D1's engine could reorder ties at any time. This
  // test locks in the observable contract; it cannot police the clause.
  const plays = [
    ['9', 'CHI', 'MIN', true, false, 0.5, 1], ['7', 'CHI', 'MIN', true, false, -0.5, 0],
    ['5', 'CHI', 'MIN', true, false, 0.5, 1], ['3', 'MIN', 'CHI', true, false, -0.5, 0],
    ['2', 'MIN', 'CHI', true, false, 0.5, 1], ['1', 'MIN', 'CHI', true, false, -0.5, 0],
  ];
  const payload = nflPayload({
    plays: plays.map(([id, pos, def, isPass, isRush, epa, success]) => ({
      play_id: id, drive: '1', quarter: 1, clock: '10:00', down: 1, yards_to_go: 10,
      yardline_100: 70, possession_team: pos, defense_team: def, play_type: 'pass',
      description: `p${id}`, ep_before: 1, epa, qb_epa: isPass ? epa : null, success,
      is_pass: isPass, is_rush: isRush, is_dropback: isPass, is_sack: false, is_penalty: false,
      passer_gsis_id: isPass ? (pos === 'CHI' ? '00-CHIQB' : '00-MINQB') : null,
      rusher_gsis_id: isRush ? (pos === 'CHI' ? '00-CHIRB' : '00-MINRB') : null,
      receiver_gsis_id: null,
    })),
    drives: [{ drive_id: '1', sequence: 1, possession_team: 'CHI', start_period: 1, start_clock: '15:00', end_period: 1, end_clock: '12:00', result: 'Punt', plays: 6, yards: null, epa: 0.2, modeled_plays: 6, coverage: 'complete' }],
    coverage: { eligible_plays: 6, eligible_drives: 1 },
  });
  await ingestEpaGame(env.DB, validateNflEpaPayload(payload), { importedAt: 1_700_000_000 });
  const a = (await read(env, '/stats/nfl/epa/games/401700001')).body.impactPlays.map((r) => r.playId);
  const b = (await read(env, '/stats/nfl/epa/games/401700001')).body.impactPlays.map((r) => r.playId);
  assert.deepEqual(a, b, 'stable across calls');
  assert.deepEqual(a, ['1', '2', '3', '5', '7'], 'ties resolved by ascending play id, not insertion order');
});

test('game: coverage and provenance satisfy the contract', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/games/401700001');
  assert.equal(body.status, 'complete');
  assert.equal(body.coverage.eligiblePlays, 14);
  assert.equal(body.coverage.modeledPlays, 8);
  assert.equal(body.coverage.eligibleDrives, 3);
  assert.equal(body.coverage.completeDrives, 2);
  assert.equal(body.coverage.drivesReturned, 3);
  assert.ok(Array.isArray(body.coverage.warnings));
  const p = body.provenance;
  for (const key of ['model', 'modelVersion', 'source', 'sourceReleasedAt', 'importedAt', 'parserVersion', 'responseVersion']) {
    assert.ok(key in p, `provenance.${key} present`);
  }
  assert.match(p.model, /nflfastR/);
  assert.equal(p.sourceReleasedAt, 'Wed, 13 Aug 2098 12:26:09 GMT');
  assert.equal(p.importedAt, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(p.modelVersion, null, 'nflverse publishes no model version; null, not invented');
});

test('game: CFB names its own model and keeps a huge play id as a string', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/cfb/epa/games/401700002');
  assert.match(body.provenance.model, /cfbfastR/);
  assert.equal(body.provenance.sourceReleasedAt, '2098-09-09 11:12:05 EDT');
  const id = body.impactPlays[0].playId;
  assert.equal(typeof id, 'string');
  assert.ok(BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER));
});

test('teams: offense and defense ranking both order meaningfully', async () => {
  const { env } = await seeded();
  const off = (await read(env, '/stats/nfl/epa/teams?season=2098&side=offense&metric=per_play')).body;
  assert.equal(off.ranking.side, 'offense');
  assert.equal(off.ranking.direction, 'desc');
  assert.equal(off.ranking.better, 'higher');
  assert.equal(off.teams[0].rank, 1);
  const values = off.teams.map((t) => t.offense.epaPerPlay.value);
  assert.deepEqual(values, [...values].sort((a, b) => b - a));

  const def = (await read(env, '/stats/nfl/epa/teams?season=2098&side=defense&metric=per_play')).body;
  assert.equal(def.ranking.better, 'higher', 'defensive EPA is already negated');
  const dv = def.teams.map((t) => t.defense.epaPerPlay.value);
  assert.deepEqual(dv, [...dv].sort((a, b) => b - a));
  // The best defense is the one whose opponent gained least.
  assert.equal(def.teams[0].teamId, 'MIN');
});

test('teams: defensive success rate ranks ascending, because lower is better', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/teams?season=2098&side=defense&metric=success_rate');
  assert.equal(body.ranking.direction, 'asc');
  assert.equal(body.ranking.better, 'lower');
  const v = body.teams.map((t) => t.defense.successRateAllowed.value);
  assert.deepEqual(v, [...v].sort((a, b) => a - b));
  // CHI allowed 1 of 3; MIN allowed 3 of 5. CHI is the better defense.
  assert.equal(body.teams[0].teamId, 'CHI');
});

test('teams: a pass split never divides by all-play opportunities', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/teams?season=2098&split=pass&metric=per_play');
  const chi = body.teams.find((t) => t.teamId === 'CHI');
  assert.equal(chi.offense.dropbacks, 3);
  assert.equal(chi.offense.plays, 5);
  assert.equal(chi.offense.passEpaPerDropback.denominator, 3, 'not 5');
  near(chi.offense.passEpaPerDropback.value, (0.5 + 0.4 - 0.9) / 3);
  assert.equal(chi.offense.passSuccessRate.denominator, 3);
  assert.equal(chi.offense.passSuccessRate.numerator, 2);
});

test('teams: season totals sum numerators then divide once', async () => {
  const { db, env } = await seeded();
  // A second CHI game with very different volume: averaging per-game rates
  // would give a different answer from summing totals first.
  const second = nflPayload({
    event_id: '401700003', nflverse_game_id: '2098_02_MIN_CHI', week: 2,
    plays: [
      { play_id: '1', drive: '1', quarter: 1, clock: '15:00', down: 1, yards_to_go: 10,
        yardline_100: 70, possession_team: 'CHI', defense_team: 'MIN', play_type: 'pass',
        description: 'x', ep_before: 1, epa: 3.0, qb_epa: 3.0, success: 1, is_pass: true,
        is_rush: false, is_dropback: true, is_sack: false, is_penalty: false,
        passer_gsis_id: '00-CHIQB', rusher_gsis_id: null, receiver_gsis_id: null },
      { play_id: '2', drive: '1', quarter: 1, clock: '14:00', down: 1, yards_to_go: 10,
        yardline_100: 70, possession_team: 'MIN', defense_team: 'CHI', play_type: 'run',
        description: 'y', ep_before: 1, epa: -1.0, qb_epa: null, success: 0, is_pass: false,
        is_rush: true, is_dropback: false, is_sack: false, is_penalty: false,
        passer_gsis_id: null, rusher_gsis_id: '00-MINRB', receiver_gsis_id: null },
    ],
    drives: [{ drive_id: '1', sequence: 1, possession_team: 'CHI', start_period: 1,
      start_clock: '15:00', end_period: 1, end_clock: '14:00', result: 'Touchdown', plays: 1,
      yards: null, epa: 3.0, modeled_plays: 1, coverage: 'complete' }],
    coverage: { eligible_plays: 2, eligible_drives: 1 },
  });
  await ingestEpaGame(env.DB, validateNflEpaPayload(second), { importedAt: 1_700_000_100 });
  const { body } = await read(env, '/stats/nfl/epa/teams?season=2098');
  const chi = body.teams.find((t) => t.teamId === 'CHI').offense;
  assert.equal(chi.plays, 6);                       // 5 + 1
  near(chi.epa, 0.5 + 0.4 - 0.9 + 0.3 - 0.2 + 3.0);
  near(chi.epaPerPlay.value, chi.epa / 6);
  // The average of the two per-game rates would be (0.1/5 + 3.0/1) / 2 = 1.51
  assert.ok(Math.abs(chi.epaPerPlay.value - 1.51) > 0.5, 'not an average of per-game rates');
  db.close();
});

test('players: identity is the LATEST team by chronology, totals still aggregate', async () => {
  const { env } = await seeded();
  // Same QB, later week, different team. MAX() would return whichever string
  // sorted highest; chronology must return the week-2 team.
  const traded = nflPayload({
    event_id: '401700004', nflverse_game_id: '2098_02_GB_DET', week: 2,
    home_team: 'DET', away_team: 'GB',
    plays: [
      { play_id: '1', drive: '1', quarter: 1, clock: '15:00', down: 1, yards_to_go: 10,
        yardline_100: 70, possession_team: 'GB', defense_team: 'DET', play_type: 'pass',
        description: 'x', ep_before: 1, epa: 1.0, qb_epa: 1.0, success: 1, is_pass: true,
        is_rush: false, is_dropback: true, is_sack: false, is_penalty: false,
        passer_gsis_id: '00-CHIQB', rusher_gsis_id: null, receiver_gsis_id: null },
      { play_id: '2', drive: '1', quarter: 1, clock: '14:00', down: 1, yards_to_go: 10,
        yardline_100: 70, possession_team: 'DET', defense_team: 'GB', play_type: 'run',
        description: 'y', ep_before: 1, epa: -0.5, qb_epa: null, success: 0, is_pass: false,
        is_rush: true, is_dropback: false, is_sack: false, is_penalty: false,
        passer_gsis_id: null, rusher_gsis_id: '00-DETRB', receiver_gsis_id: null },
    ],
    drives: [{ drive_id: '1', sequence: 1, possession_team: 'GB', start_period: 1,
      start_clock: '15:00', end_period: 1, end_clock: '14:00', result: 'Touchdown', plays: 1,
      yards: null, epa: 1.0, modeled_plays: 1, coverage: 'complete' }],
    coverage: { eligible_plays: 2, eligible_drives: 1 },
  });
  await ingestEpaGame(env.DB, validateNflEpaPayload(traded), { importedAt: 1_700_000_200 });
  const { body } = await read(env, '/stats/nfl/epa/players?season=2098&role=qb');
  const qb = body.players.find((p) => p.gsisId === '00-CHIQB');
  assert.equal(qb.team, 'GB', 'latest team by week, not MAX()');
  assert.equal(qb.games, 2, 'both games still counted');
  near(qb.epa, (0.5 + 0.4 - 0.9) + 1.0, 1e-9);
  assert.equal(qb.opportunities, 4, 'all qualifying contributions aggregate');
});

test('players: rates carry numerator and denominator, and the threshold is labelled ours', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/players?season=2098&role=qb');
  const qb = body.players[0];
  assert.equal(qb.epaPerOpportunity.denominator, qb.opportunities);
  assert.equal(qb.successRate.denominator, qb.opportunities);
  assert.match(body.qualificationNote, /Fixtura display threshold/);
  assert.equal(body.minimumOpportunities, 1);
});

test('players: role vocabularies do not cross leagues', async () => {
  const { env } = await seeded();
  await assert.rejects(() => read(env, '/stats/nfl/epa/players?season=2098&role=passer'), /role must be one of/);
  await assert.rejects(() => read(env, '/stats/cfb/epa/players?season=2098&role=qb'), /role must be one of/);
  const cfb = (await read(env, '/stats/cfb/epa/players?season=2098&role=passer')).body;
  assert.ok(cfb.players.every((p) => p.role === 'passer'));
  assert.ok(cfb.players.every((p) => p.epaBasis === 'play_epa_on_plays_where_athlete_is_named'));
});

test('coverage: reports modeled and eligible counts for plays and drives', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/coverage?season=2098');
  assert.equal(body.totals.importedGames, 1);
  assert.equal(body.totals.eligiblePlays, 14);
  assert.equal(body.totals.modeledPlays, 8);
  assert.equal(body.totals.eligibleDrives, 3);
  assert.equal(body.totals.completeDrives, 2);
  assert.equal(body.weeks[0].week, 1);
  assert.match(body.coverageScope, /does not establish a complete schedule/);
});

test('coverage: CFB explains truncated upstream captures', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/cfb/epa/coverage?season=2098');
  assert.match(body.truncationNote, /stopped mid-game/);
});

test('reads are public and cacheable; writes and unknown params are refused', async () => {
  const { env } = await seeded();
  const { res } = await read(env, '/stats/nfl/epa/games/401700001');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  await assert.rejects(() => read(env, '/stats/nfl/epa/teams?season=2098&bogus=1'), /unknown query parameter/);
  await assert.rejects(() => read(env, '/stats/nfl/epa/games/not-an-id'), /numeric ESPN id/);
  await assert.rejects(() => read(env, '/stats/nhl/epa/coverage?season=2098'), /unknown league/);
  await assert.rejects(() => read(env, '/stats/nfl/epa/games/401799999'), /no EPA data/);
});

test('missing values stay null and never become zero', async () => {
  const { env } = await seeded();
  const { body } = await read(env, '/stats/nfl/epa/teams?season=2098&limit=1');
  const t = body.teams[0];
  // Every rate object exposes its parts; a zero denominator yields null, not 0.
  for (const block of [t.offense, t.defense]) {
    for (const key of Object.keys(block)) {
      const v = block[key];
      if (v && typeof v === 'object' && 'denominator' in v) {
        if (!v.denominator) assert.equal(v.value, null, `${key} with no denominator is null`);
      }
    }
  }
});
