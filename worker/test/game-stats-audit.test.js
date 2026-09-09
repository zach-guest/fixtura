import assert from 'node:assert/strict';
import test from 'node:test';
import { auditFailed, parseAuditArgs, reconcileSummary, selectFinalEvents, validateLocalWorker } from '../scripts/audit-nfl-week.mjs';

const request = { season: 2025, seasonType: 2, week: 1 };
const event = (id, extra = {}) => ({ id, date: '2025-09-07T17:00:00.000Z', season: { year: 2025, type: 2 }, week: { number: 1 }, status: { type: { completed: true, state: 'post' } }, ...extra });

test('CLI arguments accept only bounded NFL weeks and a root loopback harness URL', () => {
  assert.deepEqual(parseAuditArgs(['--season', '2025', '--week', '1', '--worker', 'http://127.0.0.1:8791']), { season: 2025, week: 1, seasonType: 2, worker: 'http://127.0.0.1:8791', out: null });
  for (const worker of ['https://127.0.0.1:8791', 'http://example.test', 'http://127.0.0.1:8791/path', 'http://user@127.0.0.1:8791', 'http://127.0.0.1:8791/?x=1']) assert.throws(() => validateLocalWorker(worker), /loopback/);
  assert.throws(() => parseAuditArgs(['--season', '1999', '--week', '1', '--worker', 'http://localhost:8791']), /season/);
  assert.throws(() => parseAuditArgs(['--season', '2025', '--week', '31', '--worker', 'http://localhost:8791']), /week/);
});

test('final selection requires completed post events with matching metadata and deduplicates IDs', () => {
  const selected = selectFinalEvents({ events: [event('401'), event('401'), event('402', { status: { type: { completed: false, state: 'in' } } }), event('403', { week: { number: 2 } }), event('bad')] }, request);
  assert.deepEqual(selected.events, [{ eventId: '401', kickoff: '2025-09-07T17:00:00.000Z' }]);
  assert.equal(selected.scoreboardEvents, 5);
  assert.equal(selected.nonfinalEvents, 1);
  assert.equal(selected.excludedEvents, 3);
});

function summary() { return { header: { id: '401' }, boxscore: { teams: [{ team: { id: 'A' }, statistics: [
  { name: 'rushingAttempts', displayValue: '3' }, { name: 'rushingYards', displayValue: '10' }, { name: 'completionAttempts', displayValue: '2/4' }, { name: 'interceptions', displayValue: '1' }, { name: 'sacksYardsLost', displayValue: '1-7' }, { name: 'fumblesLost', displayValue: '0' }, { name: 'defensiveTouchdowns', displayValue: '0' },
] }] } }; }
const stat = (category, key, value) => ({ event_id: '401', team_id: 'A', category, stat_key: key, value });
const matchingStats = () => [stat('rushing', 'rushingAttempts', 3), stat('rushing', 'rushingYards', 10), stat('passing', 'completions', 2), stat('passing', 'passingAttempts', 4), stat('passing', 'interceptions', 1), stat('passing', 'sacksTaken', 1), stat('passing', 'sackYardsLost', 7), stat('receiving', 'receptions', 2), stat('fumbles', 'fumblesLost', 0), stat('defensive', 'defensiveTouchdowns', 0)];

test('reconciliation reports match, mismatch, and unavailable without filling missing values', () => {
  const match = reconcileSummary(summary(), matchingStats());
  assert.ok(match.every((item) => item.status === 'match'));
  const mismatch = reconcileSummary(summary(), [...matchingStats().filter((item) => item.stat_key !== 'rushingYards'), stat('rushing', 'rushingYards', 9)]);
  assert.deepEqual(mismatch.find((item) => item.comparison === 'rushing.rushingYards').status, 'mismatch');
  const unavailable = reconcileSummary(summary(), matchingStats().filter((item) => item.stat_key !== 'fumblesLost'));
  assert.equal(unavailable.find((item) => item.comparison === 'fumbles.fumblesLost').status, 'unavailable');
});

test('failure decision rejects import failures, partial coverage, ID mismatch, and available mismatches', () => {
  const base = { imports: { failed: 0 }, games: [], reconciliation: { missing_ids: [], unexpected_ids: [], comparisons: [] } };
  assert.equal(auditFailed(base), false);
  assert.equal(auditFailed({ ...base, imports: { failed: 1 } }), true);
  assert.equal(auditFailed({ ...base, games: [{ coverage: 'partial' }] }), true);
  assert.equal(auditFailed({ ...base, reconciliation: { ...base.reconciliation, missing_ids: ['401'] } }), true);
  assert.equal(auditFailed({ ...base, reconciliation: { ...base.reconciliation, comparisons: [{ status: 'mismatch' }] } }), true);
});
