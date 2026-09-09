#!/usr/bin/env node
// LOCAL-ONLY archived-week audit. It can only post to the disposable test harness.
import { writeFile } from 'node:fs/promises';
import { aggregateLeaderRows } from '../src/game-stats-rank.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const USER_AGENT = 'Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)';

export function parseAuditArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--season', '--week', '--season-type', '--worker', '--out'].includes(flag) || values[flag]) throw Error('Usage: node scripts/audit-nfl-week.mjs --season YYYY --week N [--season-type 2|3] --worker http://127.0.0.1:8791 [--out FILE]');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw Error(`missing value for ${flag}`);
    values[flag] = value;
  }
  if (!values['--season'] || !values['--week'] || !values['--worker']) throw Error('season, week, and worker are required');
  const season = Number(values['--season']); const week = Number(values['--week']); const seasonType = values['--season-type'] == null ? 2 : Number(values['--season-type']);
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw Error('season must be an integer from 2000 through 2100');
  if (!Number.isInteger(week) || week < 1 || week > 30) throw Error('week must be an integer from 1 through 30');
  if (seasonType !== 2 && seasonType !== 3) throw Error('season type must be 2 or 3');
  return { season, week, seasonType, worker: validateLocalWorker(values['--worker']), out: values['--out'] || null };
}

export function validateLocalWorker(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('worker must be a valid local http URL'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('worker must be an http loopback URL with no path, credentials, query, or hash');
  return url.toString().replace(/\/$/, '');
}

function positive(value) { return Number.isInteger(value) && value > 0 ? value : null; }
function isFinal(status) { return status?.completed === true && status?.state === 'post'; }

export function selectFinalEvents(scoreboard, request) {
  if (!Array.isArray(scoreboard?.events)) throw Error('ESPN scoreboard is missing events[]');
  const selected = new Map(); let postFinal = 0;
  for (const event of scoreboard.events) {
    const statuses = [event?.status?.type, ...(event?.competitions || []).map((competition) => competition?.status?.type)];
    if (!statuses.some(isFinal)) continue;
    postFinal += 1;
    const id = typeof event?.id === 'string' && /^\d+$/.test(event.id) ? event.id : null;
    if (!id || positive(event?.season?.year) !== request.season || event?.season?.type !== request.seasonType || positive(event?.week?.number) !== request.week || typeof event?.date !== 'string' || !Number.isFinite(Date.parse(event.date))) continue;
    selected.set(id, { eventId: id, kickoff: event.date });
  }
  return { events: [...selected.values()].sort((a, b) => a.eventId.localeCompare(b.eventId)), scoreboardEvents: scoreboard.events.length, finalEvents: selected.size, nonfinalEvents: scoreboard.events.length - postFinal, excludedEvents: postFinal - selected.size };
}

function integer(value) { return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : null; }
function pair(value, separator) { const match = typeof value === 'string' && value.match(new RegExp(`^(-?\\d+)${separator}(-?\\d+)$`)); return match ? [Number(match[1]), Number(match[2])] : null; }
function sum(rows, eventId, teamId, category, key) {
  const values = rows.filter((row) => row.event_id === eventId && row.team_id === teamId && row.category === category && row.stat_key === key).map((row) => row.value);
  return values.length && values.every(Number.isInteger) ? values.reduce((total, value) => total + value, 0) : null;
}
function compare(eventId, teamId, name, expected, actual) {
  const available = expected !== null && actual !== null;
  const delta = available ? (Array.isArray(expected) ? expected.map((v, i) => v - actual[i]) : expected - actual) : null;
  const match = available && (Array.isArray(delta) ? delta.every((v) => v === 0) : delta === 0);
  return { event_id: eventId, team_id: teamId, comparison: name, status: available ? (match ? 'match' : 'mismatch') : 'unavailable', expected, actual, delta };
}

/** Compare only player aggregates and team fields with identical NFL semantics. */
export function reconcileSummary(summary, stats) {
  const eventId = summary?.header?.id; const results = [];
  for (const team of summary?.boxscore?.teams || []) {
    const teamId = team?.team?.id;
    if (typeof eventId !== 'string' || typeof teamId !== 'string' || !Array.isArray(team.statistics)) continue;
    const fields = new Map();
    for (const field of team.statistics) if (!fields.has(field?.name)) fields.set(field?.name, field?.displayValue);
    const stat = (name) => integer(fields.get(name));
    const completions = sum(stats, eventId, teamId, 'passing', 'completions');
    const attempts = sum(stats, eventId, teamId, 'passing', 'passingAttempts');
    const sacks = sum(stats, eventId, teamId, 'passing', 'sacksTaken');
    const sackYards = sum(stats, eventId, teamId, 'passing', 'sackYardsLost');
    results.push(compare(eventId, teamId, 'rushing.rushingAttempts', stat('rushingAttempts'), sum(stats, eventId, teamId, 'rushing', 'rushingAttempts')));
    results.push(compare(eventId, teamId, 'rushing.rushingYards', stat('rushingYards'), sum(stats, eventId, teamId, 'rushing', 'rushingYards')));
    results.push(compare(eventId, teamId, 'passing.completionAttempts', pair(fields.get('completionAttempts'), '\\/'), [completions, attempts].every((v) => v !== null) ? [completions, attempts] : null));
    results.push(compare(eventId, teamId, 'passing.interceptions', stat('interceptions'), sum(stats, eventId, teamId, 'passing', 'interceptions')));
    results.push(compare(eventId, teamId, 'passing.sacksYardsLost', pair(fields.get('sacksYardsLost'), '-'), [sacks, sackYards].every((v) => v !== null) ? [sacks, sackYards] : null));
    results.push(compare(eventId, teamId, 'receiving.receptions', pair(fields.get('completionAttempts'), '\\/')?.[0] ?? null, sum(stats, eventId, teamId, 'receiving', 'receptions')));
    results.push(compare(eventId, teamId, 'fumbles.fumblesLost', stat('fumblesLost'), sum(stats, eventId, teamId, 'fumbles', 'fumblesLost')));
    results.push(compare(eventId, teamId, 'defensive.defensiveTouchdowns', stat('defensiveTouchdowns'), sum(stats, eventId, teamId, 'defensive', 'defensiveTouchdowns')));
  }
  return results;
}

export function auditFailed(report) {
  return report.imports.failed > 0 || report.reconciliation.missing_ids.length > 0 || report.reconciliation.unexpected_ids.length > 0 || report.games.some((game) => game.coverage === 'partial') || report.reconciliation.comparisons.some((item) => item.status === 'mismatch');
}

async function jsonFetch(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw Error(`${options?.method || 'GET'} ${url} returned ${response.status}`);
  return response.json();
}
async function postHarness(fetchImpl, worker, body) { return jsonFetch(fetchImpl, worker, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }

export async function runAudit(request, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const sourceTimestamp = new Date(now()).toISOString();
  const boardUrl = `${ESPN}/scoreboard?${new URLSearchParams({ dates: String(request.season), seasontype: String(request.seasonType), week: String(request.week), limit: '1000' })}`;
  const scoreboard = await jsonFetch(fetchImpl, boardUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  const selection = selectFinalEvents(scoreboard, request);
  await postHarness(fetchImpl, request.worker, { action: 'setup' });
  const captures = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < selection.events.length) {
      const candidate = selection.events[cursor++];
      try {
        const summary = await jsonFetch(fetchImpl, `${ESPN}/summary?event=${candidate.eventId}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        const result = await postHarness(fetchImpl, request.worker, { summary, options: {
          expectedEventId: candidate.eventId,
          expectedSeason: request.season,
          expectedSeasonType: request.seasonType,
          expectedWeek: request.week,
          expectedKickoff: candidate.kickoff,
          capturedAt: Math.floor(now() / 1000),
        } });
        captures.set(candidate.eventId, { summary, result });
      } catch (error) { captures.set(candidate.eventId, { error: String(error?.message || error) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, selection.events.length) }, worker));
  let inspected = { games: [], players: [], stats: [] }; let inspectError = null;
  try { inspected = await postHarness(fetchImpl, request.worker, { action: 'inspect' }); } catch (error) { inspectError = String(error?.message || error); }
  const expectedIds = selection.events.map((item) => item.eventId); const actualIds = (inspected.games || []).map((game) => game.event_id).sort();
  const missingIds = expectedIds.filter((id) => !actualIds.includes(id)); const unexpectedIds = actualIds.filter((id) => !expectedIds.includes(id));
  const imported = [...captures.values()]; const reconciliations = [...captures.values()].flatMap((capture) => capture.summary ? reconcileSummary(capture.summary, inspected.stats || []) : []);
  const fields = [...new Set((inspected.stats || []).map((row) => `${row.category}.${row.stat_key}`))].sort();
  const perCategory = Object.fromEntries([...new Set((inspected.stats || []).map((row) => row.category))].sort().map((category) => [category, (inspected.stats || []).filter((row) => row.category === category).length]));
  const perField = Object.fromEntries(fields.map((field) => {
    const cells = (inspected.stats || []).filter((row) => `${row.category}.${row.stat_key}` === field);
    return [field, {
      stat_cells: cells.length,
      games_present: new Set(cells.map((row) => row.event_id)).size,
      teams_present: new Set(cells.map((row) => `${row.event_id}/${row.team_id}`)).size,
      players_present: new Set(cells.map((row) => row.athlete_id)).size,
    }];
  }));
  const rankingFields = [
    ['passing', 'passingYards'],
    ['rushing', 'rushingYards'],
    ['receiving', 'receivingYards'],
    ['defensive', 'sacks'],
    ['defensive', 'tacklesForLoss'],
    ['interceptions', 'interceptions'],
  ];
  const gameById = new Map((inspected.games || []).map((game) => [game.event_id, game]));
  const statsByPlayerGame = new Map((inspected.stats || []).map((stat) => [
    `${stat.event_id}/${stat.athlete_id}/${stat.team_id}/${stat.category}/${stat.stat_key}`,
    stat,
  ]));
  const rankingSamples = Object.fromEntries(rankingFields.map(([category, stat]) => {
    const rows = (inspected.players || []).map((player) => ({
      ...player,
      kickoff: gameById.get(player.event_id)?.kickoff,
      value: statsByPlayerGame.get(`${player.event_id}/${player.athlete_id}/${player.team_id}/${category}/${stat}`)?.value ?? null,
    }));
    return [`${category}.${stat}`, aggregateLeaderRows(rows, { aggregation: 'sum', scope: 'league', onePerTeam: false }).slice(0, 5)];
  }));
  const report = { request: { season: request.season, week: request.week, season_type: request.seasonType, worker: request.worker }, source_timestamp: sourceTimestamp,
    scoreboard: { events: selection.scoreboardEvents, finals: selection.finalEvents, nonfinal: selection.nonfinalEvents, excluded: selection.excludedEvents },
    imports: { attempted: selection.events.length, succeeded: imported.filter((item) => !item.error).length, failed: imported.filter((item) => item.error).length, inserted: imported.filter((item) => item.result?.status === 'inserted').length, updated: imported.filter((item) => item.result?.status === 'updated').length, unchanged: imported.filter((item) => item.result?.status === 'unchanged').length, partial: imported.filter((item) => item.result?.coverage === 'partial' || item.result?.status === 'partial-rejected').length, failures: Object.fromEntries(selection.events.filter(({ eventId }) => captures.get(eventId)?.error).map(({ eventId }) => [eventId, captures.get(eventId).error])) },
    database: { games: (inspected.games || []).length, player_rows: (inspected.players || []).length, stat_cells: (inspected.stats || []).length, per_category: perCategory, fields, per_field: perField },
    ranking_samples: rankingSamples,
    games: (inspected.games || []).map((game) => ({ event_id: game.event_id, coverage: game.coverage, warnings: JSON.parse(game.warnings_json || '[]') })).sort((a, b) => a.event_id.localeCompare(b.event_id)),
    reconciliation: { expected_ids: expectedIds, database_ids: actualIds, missing_ids: missingIds, unexpected_ids: unexpectedIds, inspect_error: inspectError, comparisons: reconciliations } };
  report.failed = auditFailed(report) || Boolean(inspectError);
  return report;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const request = parseAuditArgs(process.argv.slice(2)); const report = await runAudit(request); const output = JSON.stringify(report, null, 2);
    if (request.out) await writeFile(request.out, output + '\n');
    console.log(output); if (report.failed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
