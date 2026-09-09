import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_DEFINITIONS, aggregateNFLRateRows, getRateDefinition } from '../src/game-stats-rate.js';

const row = (overrides = {}) => ({ event_id: '1', athlete_id: '10', team_id: '1', kickoff: '2025-09-01T00:00:00Z', name: 'A Player', position: 'QB', numerator: 10, denominator: 2, ...overrides });
const options = (category, stat, extra = {}) => ({ category, stat, teamGames: { 1: 16, 2: 16 }, ...extra });

test('defines exactly every supported recompute formula with source metadata', () => {
  const expected = {
    'passing.yardsPerPassAttempt': [224, 'passingYards', 'passingAttempts'],
    'rushing.yardsPerRushAttempt': [100, 'rushingYards', 'rushingAttempts'],
    'receiving.yardsPerReception': [32, 'receivingYards', 'receptions'],
    'kickReturns.yardsPerKickReturn': [20, 'kickReturnYards', 'kickReturns'],
    'puntReturns.yardsPerPuntReturn': [20, 'puntReturnYards', 'puntReturns'],
    'punting.grossAvgPuntYards': [40, 'puntYards', 'punts'],
    'kicking.fieldGoalPct': [null, 'fieldGoalsMade', 'fieldGoalAttempts'],
  };
  assert.deepEqual(Object.keys(RATE_DEFINITIONS), Object.keys(expected));
  for (const [key, [minimum, numerator, denominator]] of Object.entries(expected)) {
    assert.equal(RATE_DEFINITIONS[key].full_season_minimum, minimum);
    assert.equal(RATE_DEFINITIONS[key].numerator.key, numerator);
    assert.equal(RATE_DEFINITIONS[key].denominator.key, denominator);
  }
});

test('calculates every supported formula from its numerator and denominator totals', () => {
  for (const [key, definition] of Object.entries(RATE_DEFINITIONS)) {
    const [category, stat] = key.split('.');
    const denominator = definition.full_season_minimum || 2;
    const numerator = definition.full_season_minimum == null ? 1 : denominator * 2;
    const result = aggregateNFLRateRows([row({ numerator, denominator })], options(category, stat));
    assert.equal(result.rows[0].value, definition.full_season_minimum == null ? 50 : 2, key);
  }
});

test('recomputes across games from totals instead of averaging weekly rates', () => {
  const result = aggregateNFLRateRows([
    row({ event_id: '1', numerator: 100, denominator: 10 }),
    row({ event_id: '2', numerator: 50, denominator: 20, kickoff: '2025-09-08T00:00:00Z' }),
  ], options('passing', 'yardsPerPassAttempt', { teamGames: { 1: 2 } }));
  assert.equal(result.rows[0].value, 5); // (100 + 50) / (10 + 20), not (10 + 2.5) / 2
  assert.equal(result.rows[0].required_minimum, 28);
});

test('each qualification threshold accepts exact minimum, excludes just under, prorates, and caps at 17 games', () => {
  const exact = aggregateNFLRateRows([row({ numerator: 2240, denominator: 224 })], options('passing', 'yardsPerPassAttempt'));
  assert.equal(exact.rows[0].qualified, true);
  const below = aggregateNFLRateRows([row({ numerator: 2230, denominator: 223 })], options('passing', 'yardsPerPassAttempt'));
  assert.equal(below.rows.length, 0);
  assert.equal(below.excluded[0].reason, 'below_required_minimum');
  const prorated = aggregateNFLRateRows([row({ numerator: 140, denominator: 14 })], options('passing', 'yardsPerPassAttempt', { teamGames: { 1: 1 } }));
  assert.equal(prorated.rows[0].required_minimum, 14);
  const capped = aggregateNFLRateRows([row({ numerator: 2240, denominator: 224 })], options('passing', 'yardsPerPassAttempt', { teamGames: { 1: 17 } }));
  assert.equal(capped.rows[0].required_minimum, 224);
});

test('fails closed for missing numerator, retains real zero, and excludes zero denominator', () => {
  const missing = aggregateNFLRateRows([row({ numerator: null, denominator: 224 })], options('passing', 'yardsPerPassAttempt'));
  assert.equal(missing.excluded[0].reason, 'missing_numerator');
  const zero = aggregateNFLRateRows([row({ numerator: 0, denominator: 224 })], options('passing', 'yardsPerPassAttempt'));
  assert.equal(zero.rows[0].value, 0);
  const noVolume = aggregateNFLRateRows([row({ numerator: 0, denominator: 0 })], options('passing', 'yardsPerPassAttempt'));
  assert.equal(noVolume.excluded[0].reason, 'no_positive_denominator');
});

test('combined traded rows qualify on the latest team while team scope isolates contributions', () => {
  const combined = aggregateNFLRateRows([
    row({ event_id: '1', team_id: '1', numerator: 1000, denominator: 100 }),
    row({ event_id: '2', team_id: '2', numerator: 1240, denominator: 124, kickoff: '2025-09-08T00:00:00Z' }),
  ], options('passing', 'yardsPerPassAttempt', { teamGames: { 1: 16, 2: 8 } }));
  assert.equal(combined.rows[0].latest_team_id, '2');
  assert.equal(combined.rows[0].team_games, 8);
  assert.equal(combined.rows[0].required_minimum, 112);
  const team = aggregateNFLRateRows([row({ team_id: '1', numerator: 990, denominator: 99 })], options('passing', 'yardsPerPassAttempt', { scope: 'team' }));
  assert.equal(team.rows.length, 0);
});

test('onePerTeam discards ineligible high rate before team selection and ranks rounded ties stably', () => {
  const result = aggregateNFLRateRows([
    row({ athlete_id: '9', team_id: '1', numerator: 1000, denominator: 100 }), // unqualified
    row({ athlete_id: '8', team_id: '1', numerator: 2240, denominator: 224 }),
    row({ athlete_id: '2', team_id: '2', numerator: 2240, denominator: 224 }),
    row({ athlete_id: '1', team_id: '3', numerator: 2239.96, denominator: 224 }),
  ], options('passing', 'yardsPerPassAttempt', { onePerTeam: true, teamGames: { 1: 16, 2: 16, 3: 16 } }));
  assert.deepEqual(result.rows.map(item => [item.athlete_id, item.team_id, item.value, item.rank]), [['1', '3', 10, 1], ['2', '2', 10, 1], ['8', '1', 10, 1]]);
});

test('field-goal percentage has no published threshold and unsupported rates are absent', () => {
  const result = aggregateNFLRateRows([row({ numerator: 1, denominator: 2 })], options('kicking', 'fieldGoalPct', { teamGames: {} }));
  assert.equal(result.definition.qualification_source, 'none_published');
  assert.equal(result.rows[0].value, 50);
  assert.equal(result.rows[0].required_minimum, null);
  assert.equal(getRateDefinition('passing', 'QBRating'), null);
  assert.throws(() => aggregateNFLRateRows([], options('passing', 'QBRating')), /Unsupported recomputed rate/);
});
