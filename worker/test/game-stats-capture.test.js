import assert from 'node:assert/strict';
import test from 'node:test';
import firstSummary from './fixtures/nfl-401772723.json' with { type: 'json' };
import secondSummary from './fixtures/nfl-401772830.json' with { type: 'json' };
import { captureNFLGameStats, discoverNFLFinalGames } from '../src/game-stats-capture.js';

const NOW = 1_800_000_000;
const event = (id, week = 2) => ({ id, date: '2026-09-14T17:00:00.000Z', season: { year: 2026, type: 2 }, week: { number: week }, status: { type: { completed: true, state: 'post' } } });
const board = (events, type = 2, week = 2) => ({ season: { year: 2026, type }, week: { number: week }, events });
function discoveredSummary(source) {
  const summary = structuredClone(source);
  summary.header.season.year = 2026;
  summary.header.season.type = 2;
  summary.header.week = 2;
  summary.header.competitions[0].date = '2026-09-14T17:00:00.000Z';
  return summary;
}

class FakeDB {
  constructor() { this.states = new Map(); this.games = new Map(); }
  prepare(sql) {
    const db = this;
    return { bind(...params) { return { sql, params,
      async first() {
        if (sql.includes('SELECT captured_at')) return db.games.get(params[0]) || null;
        if (sql.includes('SELECT coverage')) return db.games.get(params[0]) || null;
        return null;
      },
      async all() {
        const ids = new Set(params);
        if (sql.includes('FROM nfl_stat_games')) return { results: [...db.games.entries()].filter(([id]) => ids.has(id)).map(([event_id, row]) => ({ event_id, ...row })) };
        if (sql.includes('FROM nfl_game_capture_state')) return { results: [...db.states.entries()].filter(([id]) => ids.has(id)).map(([event_id, row]) => ({ event_id, ...row })) };
        return { results: [] };
      },
      async run() {
        const id = sql.includes('attempt_count = attempt_count + 1') ? params[1]
          : sql.includes("status = 'failed'") ? params[1]
          : params[2];
        const state = db.states.get(id);
        if (sql.includes('attempt_count = attempt_count + 1')) {
          if (state.last_attempt_at == null || state.last_attempt_at <= params[2]) Object.assign(state, { attempt_count: state.attempt_count + 1, last_attempt_at: params[0], last_error: null });
        }
        else if (sql.includes("status = 'failed'")) Object.assign(state, { status: 'failed', last_error: params[0] });
        else if (sql.includes('SET status = ?')) Object.assign(state, { status: params[0], last_success_at: params[1], last_error: null });
        return { meta: { changes: 1 } };
      },
    }; } };
  }
  async batch(statements) {
    for (const statement of statements) {
      const sql = statement.sql || '';
      const params = statement.params || [];
      if (sql.includes('INSERT INTO nfl_game_capture_state')) {
        const [id, season, season_type, week, kickoff, discovered_at, last_seen_at] = params;
        const old = this.states.get(id);
        this.states.set(id, old ? { ...old, season, season_type, week, kickoff, last_seen_at } : { season, season_type, week, kickoff, discovered_at, last_seen_at, attempt_count: 0, status: 'discovered', last_attempt_at: null, last_success_at: null, last_error: null });
      } else if (sql.includes('INSERT INTO nfl_stat_games')) {
        const [id,,,,,,,, captured_at,,,, coverage] = params;
        const existed = this.games.has(id);
        this.games.set(id, { captured_at, coverage, content_hash: 'test', source_updated_at: null });
        return [{ meta: { changes: existed ? 1 : 1 } }];
      }
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

function feedFor(base, pages, summaries = {}) {
  return async (url) => {
    if (url.endsWith('/scoreboard')) return base;
    if (url.includes('/scoreboard?')) return pages.find(([needle]) => url.includes(needle))?.[1] || board([]);
    const id = new URL(url).searchParams.get('event');
    if (summaries[id] instanceof Error) throw summaries[id];
    return summaries[id];
  };
}

test('discovery rejects malformed entries and deduplicates completed finals', () => {
  const candidates = discoverNFLFinalGames(board([
    event('401772723'), event('401772723'),
    { ...event('401772830'), status: { type: { completed: false } } },
    { ...event('nope') }, { ...event('4017'), season: { year: 2026, type: 1 } },
  ]));
  assert.deepEqual(candidates, [{ eventId: '401772723', season: 2026, seasonType: 2, week: 2, kickoff: '2026-09-14T17:00:00.000Z' }]);
});

test('offseason or malformed current board skips without touching D1', async () => {
  const db = new FakeDB();
  const outcome = await captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON: feedFor(board([], 1), []) });
  assert.equal(outcome.status, 'skipped');
  assert.equal(db.states.size, 0);
});

test('caps due work, prioritizes missing games, and honors retry timing', async () => {
  const db = new FakeDB();
  const ids = Array.from({ length: 10 }, (_, i) => `4017727${String(30 + i).padStart(2, '0')}`);
  const events = ids.map((id) => event(id));
  // Two existing captures are not due; all missing games are due and the cap is eight.
  for (const id of ids.slice(8)) {
    db.games.set(id, { coverage: 'complete', captured_at: NOW - 100 });
    db.states.set(id, { discovered_at: NOW - 1000, last_seen_at: NOW - 1000, last_attempt_at: NOW - 100, last_success_at: NOW - 100, attempt_count: 1, status: 'captured' });
  }
  const fetchJSON = feedFor(board([], 2), [['week=2', board(events)], ['week=1', board([])]], Object.fromEntries(ids.map((id) => [id, new Error('planned failure')])));
  await assert.rejects(() => captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON }), /8 event/);
  assert.equal([...db.states.values()].filter((row) => row.last_attempt_at === NOW).length, 8);
  assert.equal(db.states.get(ids[8]).attempt_count, 1);
});

test('records captured, partial, and failed states while continuing after a failure', async () => {
  const db = new FakeDB();
  const partial = discoveredSummary(secondSummary);
  const passing = partial.boxscore.players[0].statistics.find((item) => item.name === 'passing');
  passing.athletes[0].stats[passing.keys.indexOf('passingYards')] = '--';
  const ids = ['401772723', '401772830', '401772999'];
  const fetchJSON = feedFor(board([], 2), [['week=2', board(ids.map((id) => event(id)))], ['week=1', board([])]], {
    '401772723': discoveredSummary(firstSummary), '401772830': partial, '401772999': new Error('summary unavailable'),
  });
  let failure;
  try { await captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON }); } catch (error) { failure = error; }
  assert.match(failure.message, /401772999/);
  assert.equal(failure.outcome.attempted, 3);
  assert.equal(db.states.get('401772723').status, 'captured');
  assert.equal(db.states.get('401772830').status, 'partial');
  assert.equal(db.states.get('401772999').status, 'failed');
  assert.equal(db.states.get('401772723').last_success_at, NOW);
  assert.equal(db.states.get('401772999').attempt_count, 1);
});

test('partial and failed rows wait thirty minutes before another attempt', async () => {
  const db = new FakeDB();
  for (const [id, status] of [['401772723', 'partial'], ['401772830', 'failed']]) {
    db.games.set(id, { coverage: status === 'partial' ? 'partial' : 'complete', captured_at: NOW - 10 });
    db.states.set(id, { discovered_at: NOW - 1000, last_seen_at: NOW - 1000, last_attempt_at: NOW - 10, last_success_at: NOW - 10, attempt_count: 1, status });
  }
  const fetchJSON = feedFor(board([], 2), [['week=2', board([event('401772723'), event('401772830')])], ['week=1', board([])]], {});
  const outcome = await captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON });
  assert.equal(outcome.due, 0);
  assert.equal(db.states.get('401772723').attempt_count, 1);
  assert.equal(db.states.get('401772830').attempt_count, 1);
});

test('discovery requires the completed post-game state and ignores an out-of-scope page event', async () => {
  const notPost = { ...event('401772723'), status: { type: { completed: true, state: 'in' } } };
  assert.deepEqual(discoverNFLFinalGames(board([notPost])), []);
  const db = new FakeDB();
  const otherWeek = event('401772830', 8);
  const fetchJSON = feedFor(board([], 2), [['week=2', board([otherWeek])], ['week=1', board([])]], {});
  const outcome = await captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON });
  assert.equal(outcome.discovered, 0);
  assert.equal(db.states.size, 0);
});

test('capture rejects a summary whose discovered season metadata does not match', async () => {
  const db = new FakeDB();
  const fetchJSON = feedFor(board([], 2), [['week=2', board([event('401772723')])], ['week=1', board([])]], {
    '401772723': structuredClone(firstSummary),
  });
  await assert.rejects(
    () => captureNFLGameStats({ DB: db }, null, { clock: () => NOW * 1000, fetchJSON }),
    /season does not match discovered event/,
  );
  assert.equal(db.states.get('401772723').status, 'failed');
});
