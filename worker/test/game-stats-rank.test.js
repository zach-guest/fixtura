import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/http.js';
import { aggregateLeaderRows, handleNFLLeaders, readNFLLeaders } from '../src/game-stats-rank.js';

const row = (overrides = {}) => ({ event_id: '1', athlete_id: '10', team_id: '1', name: 'A Player', position: 'QB', kickoff: '2025-09-01T00:00:00Z', value: 1, ...overrides });
const options = { aggregation: 'sum', scope: 'league', onePerTeam: false };
function request(path, method = 'GET') { return new Request(`https://api.example${path}`, { method, headers: { Origin: 'http://localhost:8123' } }); }
function fakeDB({ coverageRows = [{}], leaderRows = [], teamGameRows = [] }) {
  return { prepare(sql) { return { bind() { return {
    first: async () => coverageRows[0],
    all: async () => ({ results: sql.includes('GROUP BY player.team_id') ? teamGameRows : leaderRows }),
  }; } }; } };
}

test('sums traded-player stints, retains latest identity/team, counts appearances, and retains stored zero', () => {
  const rows = aggregateLeaderRows([
    row({ event_id: '1', team_id: '1', value: 10, kickoff: '2025-09-01T00:00:00Z', name: 'Old Name' }),
    row({ event_id: '2', team_id: '2', value: 0, kickoff: '2025-09-08T00:00:00Z', name: 'New Name', position: 'WR' }),
    row({ event_id: '3', athlete_id: '11', team_id: '3', value: 9 }),
  ], options);
  assert.equal(rows[0].athlete_id, '10');
  assert.equal(rows[0].value, 10);
  assert.deepEqual(rows[0].team_ids, ['1', '2']);
  assert.equal(rows[0].latest_team_id, '2');
  assert.equal(rows[0].name, 'New Name');
  assert.equal(rows[0].games_played, 2);
  assert.equal(rows[0].games_with_stat, 2);
  assert.equal(rows[1].value, 9);
  assert.equal(aggregateLeaderRows([row({ value: 0 })], options)[0].value, 0);
});

test('max, team scope, missing values, ties, and limit rank deterministically', () => {
  const rows = aggregateLeaderRows([
    row({ athlete_id: '2', event_id: '1', value: 20 }), row({ athlete_id: '2', event_id: '2', value: 12 }),
    row({ athlete_id: '1', event_id: '3', value: 20 }), row({ athlete_id: '4', event_id: '5', value: 10 }),
    row({ athlete_id: '3', event_id: '4', value: null }),
  ], { aggregation: 'max', scope: 'team', onePerTeam: false });
  assert.deepEqual(rows.map(r => [r.athlete_id, r.value, r.rank]), [['1', 20, 1], ['2', 20, 1], ['4', 10, 3]]);
  assert.equal(rows.some(r => r.athlete_id === '3'), false);
  assert.deepEqual(rows.slice(0, 1).map(r => r.rank), [1]);
});

test('onePerTeam chooses each team representative and permits a traded athlete to represent two teams', () => {
  const rows = aggregateLeaderRows([
    row({ athlete_id: '7', event_id: '1', team_id: '1', value: 8 }),
    row({ athlete_id: '8', event_id: '2', team_id: '1', value: 9 }),
    row({ athlete_id: '7', event_id: '3', team_id: '2', value: 10 }),
  ], { ...options, onePerTeam: true });
  assert.deepEqual(rows.map(r => [r.athlete_id, r.team_id, r.value]), [['7', '2', 10], ['8', '1', 9]]);
});

test('handler returns coverage/query metadata with public headers', async () => {
  const env = { DB: fakeDB({
    coverageRows: [{ discovered_final_games: 2, captured_games: 2, complete_games: 2, partial_games: 0, failed_games: 0 }],
    leaderRows: [row({ value: 30 }), row({ athlete_id: '11', event_id: '2', value: 20 })],
  }) };
  const response = await handleNFLLeaders(request('/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&limit=1'), env, 'http://localhost:8123');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8123');
  const result = await response.json();
  assert.equal(result.aggregation, 'sum');
  assert.equal(result.coverage.status, 'complete_for_discovered_finals');
  assert.match(result.coverage.scope, /only discovered final games/i);
  assert.equal(result.rows[0].value, 30);
  assert.equal(result.rows.length, 1);
});

test('handler recomputes qualified rates from components and exposes qualification metadata', async () => {
  const env = { DB: fakeDB({
    coverageRows: [{ discovered_final_games: 2, captured_games: 2, complete_games: 2, partial_games: 0, failed_games: 0 }],
    teamGameRows: [{ team_id: '34', team_games: 2 }, { team_id: '14', team_games: 2 }],
    leaderRows: [
      row({ athlete_id: '20', team_id: '34', event_id: '1', numerator: 100, denominator: 10 }),
      row({ athlete_id: '20', team_id: '34', event_id: '2', kickoff: '2025-09-08T00:00:00Z', numerator: 180, denominator: 18 }),
      row({ athlete_id: '21', team_id: '14', event_id: '1', numerator: 270, denominator: 27 }),
    ],
  }) };
  const result = await readNFLLeaders(request('/stats/nfl/leaders?season=2025&category=passing&stat=yardsPerPassAttempt&throughWeek=2'), env);
  assert.equal(result.aggregation, 'recompute');
  assert.match(result.rate.formula, /passingYards/);
  assert.match(result.rate.qualification_source, /NFL Guide for Statisticians/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].value, 10);
  assert.equal(result.rows[0].numerator, 280);
  assert.equal(result.rows[0].denominator, 28);
  assert.equal(result.rows[0].required_minimum, 28);
  assert.equal(result.excluded_candidates, 1);
});

test('partial coverage and parameter validation reject unsupported/ambiguous requests', async () => {
  const env = { DB: fakeDB({ coverageRows: [{ discovered_final_games: 2, captured_games: 1, complete_games: 1, partial_games: 0, failed_games: 1 }] }) };
  const result = await readNFLLeaders(request('/stats/nfl/leaders?season=2025&category=rushing&stat=rushingYards&throughWeek=2&limit=999'), env);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.query.limit, 100);
  const badInputs = [
    '/stats/nfl/leaders?season=2025&category=passing&stat=QBRating',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&scope=team',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&scope=team&teamId=1&onePerTeam=false',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&teamId=1',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&onePerTeam=banana',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&throughWeek=31',
    '/stats/nfl/leaders?season=2025&category=passing&stat=passingYards&extra=1',
  ];
  for (const path of badInputs) await assert.rejects(readNFLLeaders(request(path), env), error => error instanceof ApiError && error.status === 400);
  await assert.rejects(readNFLLeaders(request('/stats/nfl/leaders?season=2025&category=passing&stat=passingYards', 'POST'), env), error => error instanceof ApiError && error.status === 400);
});
