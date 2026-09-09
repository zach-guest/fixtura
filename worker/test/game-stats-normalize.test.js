import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/nfl-401772723.json' with { type: 'json' };
import secondFixture from './fixtures/nfl-401772830.json' with { type: 'json' };
import { normalizeNFLGame, STAT_DEFINITIONS } from '../src/game-stats-normalize.js';

const options = { expectedEventId: '401772723', capturedAt: 1_757_367_000 };
const copy = () => structuredClone(fixture);
const category = (summary, teamId, name) => summary.boxscore.players.find(team => team.team.id === teamId).statistics.find(item => item.name === name);
const stat = (result, athlete, categoryName, key) => result.stats.find(row => row.athlete_id === athlete && row.category === categoryName && row.key === key);

test('normalizes the final fixture while retaining category namespaces and provider raw values', () => {
  const result = normalizeNFLGame(copy(), options);
  assert.equal(result.event.event_id, '401772723');
  assert.equal(result.event.kickoff, '2025-09-07T20:25:00.000Z');
  assert.equal(result.event.coverage, 'complete');
  assert.deepEqual(result.warnings, []);
  assert.equal(stat(result, '4432577', 'passing', 'completions').value, 19);
  assert.equal(stat(result, '4432577', 'passing', 'passingAttempts').value, 27);
  assert.equal(stat(result, '4432577', 'passing', 'passingYards').value, 188);
  assert.equal(stat(result, '4432577', 'passing', 'interceptions').value, 1);
  assert.equal(stat(result, '4432577', 'passing', 'sacksTaken').value, 3);
  assert.equal(stat(result, '4432577', 'passing', 'sackYardsLost').value, 37);
  assert.equal(stat(result, '4432577', 'passing', 'sacksTaken').raw, '3-37');
  assert.equal(stat(result, '4243181', 'defensive', 'QBHits').value, 1);
  assert.equal(stat(result, '4384549', 'interceptions', 'interceptions').value, 1);
  assert.equal(STAT_DEFINITIONS['passing.yardsPerPassAttempt'].aggregation, 'recompute');
  assert.equal(STAT_DEFINITIONS['passing.QBRating'].aggregation, 'provider_only');
  assert.equal(STAT_DEFINITIONS['rushing.longRushing'].aggregation, 'max');
});

test('normalizes a second retained NFL final fixture', () => {
  const result = normalizeNFLGame(structuredClone(secondFixture), { expectedEventId: '401772830', capturedAt: options.capturedAt });
  assert.equal(result.event.kickoff, '2025-09-07T17:00:00.000Z');
  assert.equal(result.event.coverage, 'complete');
  assert.ok(result.players.length > 0);
  assert.ok(result.stats.length > 0);
});

test('uses keys rather than column order and accepts decimals, comma grouping, and negative yardage', () => {
  const summary = copy();
  const rushing = category(summary, '34', 'rushing');
  rushing.keys = [...rushing.keys].reverse();
  rushing.labels = [...rushing.labels].reverse();
  rushing.athletes.forEach(player => { player.stats = [...player.stats].reverse(); });
  const chubb = rushing.athletes.find(player => player.athlete.id === '3128720');
  chubb.stats[rushing.keys.indexOf('rushingYards')] = '-1,234.5';
  const result = normalizeNFLGame(summary, options);
  assert.equal(stat(result, '3128720', 'rushing', 'rushingYards').value, -1234.5);
  assert.equal(stat(result, '3128720', 'rushing', 'rushingYards').raw, '-1,234.5');
});

test('omits missing values and marks coverage partial without treating them as zero', () => {
  const summary = copy();
  const passing = category(summary, '34', 'passing');
  passing.athletes[0].stats[passing.keys.indexOf('passingYards')] = '--';
  const result = normalizeNFLGame(summary, options);
  assert.equal(stat(result, '4432577', 'passing', 'passingYards'), undefined);
  assert.equal(result.event.coverage, 'partial');
  assert.match(result.warnings.join('\n'), /missing passing\.passingYards/);
  assert.equal(stat(result, '4432577', 'passing', 'passingTouchdowns').value, 0);
});

test('also treats null cells as absent data', () => {
  const summary = copy();
  const passing = category(summary, '34', 'passing');
  passing.athletes[0].stats[passing.keys.indexOf('passingYards')] = null;
  const result = normalizeNFLGame(summary, options);
  assert.equal(stat(result, '4432577', 'passing', 'passingYards'), undefined);
  assert.equal(result.event.coverage, 'partial');
});

test('warns and marks partial for stale unknown schema while retaining known values', () => {
  const summary = copy();
  const receiving = category(summary, '14', 'receiving');
  receiving.keys.push('mysteryMetric');
  receiving.labels.push('MYST');
  receiving.athletes.forEach(player => player.stats.push('7'));
  const result = normalizeNFLGame(summary, options);
  assert.equal(result.event.coverage, 'partial');
  assert.match(result.warnings.join('\n'), /unknown stat receiving\.mysteryMetric/);
  assert.equal(stat(result, '4426515', 'receiving', 'receivingYards').value, 130);
});

test('skips unknown cells before parsing and notices missing expected keys even with no athletes', () => {
  const summary = copy();
  const receiving = category(summary, '14', 'receiving');
  receiving.keys.push('mysteryMetric');
  receiving.labels.push('MYST');
  receiving.athletes.forEach(player => player.stats.push('not numeric'));
  const interceptions = category(summary, '34', 'interceptions');
  interceptions.keys.push('unknownEmptyKey');
  interceptions.labels.push('UNKNOWN');
  const passing = category(summary, '34', 'passing');
  passing.keys = [];
  passing.labels = [];
  passing.athletes.forEach(player => { player.stats = []; });
  const result = normalizeNFLGame(summary, options);
  assert.equal(result.event.coverage, 'partial');
  assert.match(result.warnings.join('\n'), /unknown stat receiving\.mysteryMetric/);
  assert.match(result.warnings.join('\n'), /unknown stat interceptions\.unknownEmptyKey/);
  assert.match(result.warnings.join('\n'), /missing expected passing\.passingYards/);
});

test('rejects summaries that are unsafe to ingest', () => {
  const cases = [
    ['wrong event', summary => { summary.header.id = '1'; }],
    ['nonfinal', summary => { summary.header.competitions[0].status.type.completed = false; summary.header.competitions[0].status.type.state = 'in'; }],
    ['out of range season', summary => { summary.header.season.year = 1999; }],
    ['out of range week', summary => { summary.header.week = 31; }],
    ['bad source updated date', summary => { summary.meta = { lastUpdatedAt: 'not a date' }; }],
    ['malformed numeric', summary => { const c = category(summary, '34', 'passing'); c.athletes[0].stats[c.keys.indexOf('passingYards')] = '188 yards'; }],
    ['malformed comma grouping', summary => { const c = category(summary, '34', 'passing'); c.athletes[0].stats[c.keys.indexOf('passingYards')] = '1,,2'; }],
    ['duplicate category', summary => { summary.boxscore.players[0].statistics.push(structuredClone(summary.boxscore.players[0].statistics[0])); }],
    ['unaligned cells', summary => { category(summary, '34', 'passing').athletes[0].stats.pop(); }],
    ['player on two teams', summary => { category(summary, '14', 'passing').athletes[0].athlete.id = '4432577'; }],
    ['competitor nested team mismatch', summary => { summary.header.competitions[0].competitors[0].team.id = '999'; }],
    ['bad position', summary => { category(summary, '34', 'passing').athletes[0].athlete.position = { abbreviation: 7 }; }],
    ['duplicate normalized stat', summary => { const c = category(summary, '34', 'passing'); c.keys.push('completions'); c.labels.push('CMP'); c.athletes.forEach(player => player.stats.push('19')); }],
  ];
  for (const [name, mutate] of cases) {
    const summary = copy();
    mutate(summary);
    assert.throws(() => normalizeNFLGame(summary, options), { message: /Invalid NFL game summary/ }, name);
  }
});
