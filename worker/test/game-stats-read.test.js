import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/http.js';
import { handleGameStats } from '../src/game-stats-read.js';

function fakeDB(rows, seen = []) {
  return { prepare(sql) { return { bind(...params) { seen.push({ sql, params }); return { all: async () => ({ results: rows }) }; } }; } };
}
function request(path, method = 'GET', origin = 'http://localhost:8123') {
  return new Request(`https://api.example${path}`, { method, headers: { Origin: origin } });
}
async function body(response) { return response.json(); }

test('coverage returns only discovered-final wording and grouped capture counts', async () => {
  const seen = [];
  const env = { DB: fakeDB([{ week: 2, discovered_final_games: 3, captured_games: 2, complete_games: 1, partial_games: 1, failed_games: 1, last_seen_at: 100, last_success_at: 90 }], seen) };
  const response = await handleGameStats(request('/stats/nfl/coverage?season=2025&seasonType=3'), ['stats', 'nfl', 'coverage'], env, null, 'http://localhost:8123');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8123');
  const result = await body(response);
  assert.match(result.coverage_scope, /only discovered final games/i);
  assert.match(result.coverage_scope, /does not establish full schedule or season completeness/i);
  assert.deepEqual(result.weeks[0], { week: 2, discovered_final_games: 3, captured_games: 2, complete_games: 1, partial_games: 1, failed_games: 1, last_seen_at: 100, last_success_at: 90 });
  assert.deepEqual(seen[0].params, [2025, 3]);
});

test('coverage treats no capture rows as a valid empty result', async () => {
  const response = await handleGameStats(request('/stats/nfl/coverage?season=2100'), ['stats', 'nfl', 'coverage'], { DB: fakeDB([]) }, null, '');
  assert.deepEqual((await body(response)).weeks, []);
});

test('player games group stat cells, preserve missing cells, order rows, and safely parse warnings', async () => {
  const seen = [];
  const rows = [
    { event_id: 'b', athlete_id: '4432577', team_id: '34', name: 'Quarter Back', position: 'QB', week: 2, kickoff: '2025-09-14T20:00:00Z', coverage: 'complete', captured_at: 20, source_updated_at: '2025-09-15T00:00:00Z', warnings_json: '["late source"]', category: 'passing', stat_key: 'passingYards', value: 250, raw_value: '250', aggregation: 'sum' },
    { event_id: 'b', athlete_id: '4432577', team_id: '34', name: 'Quarter Back', position: 'QB', week: 2, kickoff: '2025-09-14T20:00:00Z', coverage: 'complete', captured_at: 20, source_updated_at: '2025-09-15T00:00:00Z', warnings_json: '["late source"]', category: 'passing', stat_key: 'QBRating', value: 98.5, raw_value: '98.5', aggregation: 'provider_only' },
    { event_id: 'a', athlete_id: '4432577', team_id: '34', name: 'Quarter Back', position: 'QB', week: 1, kickoff: '2025-09-07T20:00:00Z', coverage: 'partial', captured_at: 10, source_updated_at: null, warnings_json: '{bad json', category: null, stat_key: null, value: null, raw_value: null, aggregation: null },
  ];
  const response = await handleGameStats(request('/stats/nfl/players/4432577/games?season=2025&limit=99'), ['stats', 'nfl', 'players', '4432577', 'games'], { DB: fakeDB(rows, seen) }, null, '');
  const result = await body(response);
  assert.deepEqual(result.player, { athlete_id: '4432577', name: 'Quarter Back', position: 'QB' });
  assert.deepEqual(result.games.map(game => game.event_id), ['b', 'a']);
  assert.equal(result.games[0].name, 'Quarter Back');
  assert.equal(result.games[0].position, 'QB');
  assert.deepEqual(result.games[0].stats.passing.passingYards, { value: 250, raw: '250', aggregation: 'sum' });
  assert.equal(result.games[0].stats.passing.QBRating.value, 98.5);
  assert.deepEqual(result.games[0].warnings, ['late source']);
  assert.deepEqual(result.games[1].warnings, []);
  assert.deepEqual(result.games[1].stats, {});
  assert.deepEqual(seen[0].params, ['4432577', 2025, 2, 50]);
});

test('unknown athletes are an empty public response, not 404', async () => {
  const response = await handleGameStats(request('/stats/nfl/players/1/games?season=2025'), ['stats', 'nfl', 'players', '1', 'games'], { DB: fakeDB([]) }, null, '');
  assert.deepEqual(await body(response), { league: 'nfl', season: 2025, season_type: 2, player: null, games: [] });
});

test('stats validates method, path, ids, seasons, query names, and numeric parameters', async () => {
  const env = { DB: fakeDB([]) };
  const cases = [
    [request('/stats/nfl/coverage?season=2025', 'POST'), ['stats', 'nfl', 'coverage'], 400],
    [request('/stats/nfl/nope?season=2025'), ['stats', 'nfl', 'nope'], 404],
    [request('/stats/nfl/coverage?season=1999'), ['stats', 'nfl', 'coverage'], 400],
    [request('/stats/nfl/coverage?season=2025&seasonType=1'), ['stats', 'nfl', 'coverage'], 400],
    [request('/stats/nfl/coverage?season=2025&extra=1'), ['stats', 'nfl', 'coverage'], 400],
    [request('/stats/nfl/players/abc/games?season=2025'), ['stats', 'nfl', 'players', 'abc', 'games'], 400],
    [request('/stats/nfl/players/2/games?season=2025&limit=0'), ['stats', 'nfl', 'players', '2', 'games'], 400],
  ];
  for (const [req, segments, status] of cases) {
    await assert.rejects(handleGameStats(req, segments, env, null, ''), error => error instanceof ApiError && error.status === status);
  }
});
