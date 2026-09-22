/**
 * Worker-native EPA validation and aggregation. Pure functions, no I/O.
 *
 * The point of most of these is that the Worker does not trust the importer:
 * it recomputes every aggregate from the plays and refuses a payload whose
 * submitted totals disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNflEpaPayload, validateCfbEpaPayload, DEFENSE_SIGN, CFB_EPA_BASIS } from '../src/epa-validate.js';

const nflPlay = (over = {}) => ({
  play_id: '1', drive: '1', quarter: 1, clock: '15:00', down: 1, yards_to_go: 10,
  yardline_100: 75, possession_team: 'CHI', defense_team: 'MIN', play_type: 'pass',
  description: 'short pass', ep_before: 1.2, epa: 0.5, qb_epa: 0.5, success: 1,
  is_pass: true, is_rush: false, is_dropback: true, is_sack: false, is_penalty: false,
  passer_gsis_id: '00-0039918', rusher_gsis_id: null, receiver_gsis_id: null, ...over,
});

const nflPayload = (over = {}) => ({
  league: 'nfl', event_id: '401772810', nflverse_game_id: '2025_01_MIN_CHI',
  season: 2025, season_type_espn: 2, week: 1, home_team: 'CHI', away_team: 'MIN',
  gameday: '2025-09-08', overtime: false, predicate_version: 1,
  source: { pbp_url: 'https://example/pbp.parquet' },
  plays: [
    nflPlay(),
    nflPlay({ play_id: '2', epa: -0.25, qb_epa: -0.25, success: 0 }),
    nflPlay({ play_id: '3', is_pass: false, is_rush: true, is_dropback: false, epa: 0.75, qb_epa: null, success: 1, passer_gsis_id: null, rusher_gsis_id: '00-0036264' }),
    nflPlay({ play_id: '4', possession_team: 'MIN', defense_team: 'CHI', epa: 1.5, qb_epa: 1.5, success: 1, passer_gsis_id: '00-0039923' }),
  ],
  ...over,
});

const cfbPlay = (over = {}) => ({
  play_id: '401858212104999901', play_number: 1, drive_id: '4018582121', period: 1,
  clock: '15:00', down: 1, yards_to_go: 10, yards_to_endzone: 75,
  possession_team_id: '333', possession_team: 'Alabama', defense_team_id: '151',
  defense_team: 'East Carolina', play_type: 'Pass Reception', description: 'pass',
  ep_before: 1.1, epa: 0.4, success: 1, is_pass: true, is_rush: false, is_sack: false,
  is_penalty_no_play: false, passer_athlete_id: '5144959', rusher_athlete_id: null,
  receiver_athlete_id: null, ...over,
});

const cfbPayload = (over = {}) => ({
  league: 'cfb', event_id: '401856634', season: 2026, season_type_espn: 2, week: 1,
  home_team_id: '333', away_team_id: '151', source_says_completed: true,
  predicate_version: 1, model: 'cfbfastR/SportsDataverse college expected points',
  source: { pbp_url: 'https://example/cfb.parquet', release_timestamp: { last_updated: '2026-09-09 11:12:05 EDT' } },
  plays: [
    cfbPlay(),
    cfbPlay({ play_id: '401858212104999902', epa: -0.6, success: 0 }),
    cfbPlay({ play_id: '401858212104999903', is_pass: false, is_rush: true, epa: 0.2, passer_athlete_id: null, rusher_athlete_id: '4877259' }),
    cfbPlay({ play_id: '401858212104999904', possession_team_id: '151', possession_team: 'East Carolina', defense_team_id: '333', defense_team: 'Alabama', epa: -0.3, success: 0, passer_athlete_id: '5113896' }),
  ],
  ...over,
});

const rejects = (fn, match) => assert.throws(fn, (err) => {
  assert.equal(err.status, 400);
  if (match) assert.match(err.message, match);
  return true;
});

test('NFL: derives team aggregates from plays, with defense as the negated opponent', () => {
  const out = validateNflEpaPayload(nflPayload());
  const chi = out.team_games.find((t) => t.team === 'CHI');
  const min = out.team_games.find((t) => t.team === 'MIN');
  assert.equal(chi.off_plays, 3);
  assert.equal(round(chi.off_epa), 1);            // 0.5 - 0.25 + 0.75
  assert.equal(chi.off_dropbacks, 2);
  assert.equal(chi.off_designed_rushes, 1);
  assert.equal(round(chi.def_epa), -1.5);          // negation of MIN's offense
  assert.equal(round(min.off_epa), 1.5);
  assert.equal(chi.defense_sign_convention, DEFENSE_SIGN);
  // pass + rush partition the plays exactly, for the NFL only
  assert.equal(chi.off_dropbacks + chi.off_designed_rushes, chi.off_plays);
});

test('NFL: QB rows aggregate qb_epa, rusher rows aggregate play epa', () => {
  const out = validateNflEpaPayload(nflPayload());
  const qb = out.player_games.find((p) => p.gsis_id === '00-0039918');
  assert.equal(qb.role, 'qb');
  assert.equal(round(qb.epa), 0.25);               // 0.5 + (-0.25) from qb_epa
  assert.equal(qb.opportunities, 2);
  const rusher = out.player_games.find((p) => p.gsis_id === '00-0036264');
  assert.equal(rusher.role, 'rusher');
  assert.equal(round(rusher.epa), 0.75);
});

test('NFL: a submitted aggregate that disagrees with the plays is rejected', () => {
  const payload = nflPayload();
  const derived = validateNflEpaPayload(payload);
  const tampered = {
    ...payload,
    team_games: derived.team_games.map((t) => t.team === 'CHI' ? { ...t, off_epa: t.off_epa + 5 } : t),
  };
  rejects(() => validateNflEpaPayload(tampered), /does not match the value derived/);
});

test('NFL: a tampered player total is rejected too', () => {
  const payload = nflPayload();
  const derived = validateNflEpaPayload(payload);
  const tampered = {
    ...payload,
    player_games: derived.player_games.map((p) => p.role === 'qb' ? { ...p, epa: 99 } : p),
  };
  rejects(() => validateNflEpaPayload(tampered), /does not match the value derived/);
});

test('NFL: matching submitted aggregates pass, and identity is carried through', () => {
  const payload = nflPayload();
  const derived = validateNflEpaPayload(payload);
  const withAggregates = {
    ...payload,
    team_games: derived.team_games,
    player_games: derived.player_games.map((p) => ({ ...p, espn_athlete_id: '4431611', display_name: 'Caleb Williams' })),
  };
  const out = validateNflEpaPayload(withAggregates);
  assert.equal(out.player_games[0].espn_athlete_id, '4431611');
  assert.equal(out.player_games[0].display_name, 'Caleb Williams');
});

test('NFL: a player with no ESPN id still stores, keeping the GSIS id', () => {
  const payload = nflPayload();
  const derived = validateNflEpaPayload(payload);
  const out = validateNflEpaPayload({
    ...payload,
    player_games: derived.player_games.map((p) => ({ ...p, espn_athlete_id: null })),
  });
  const qb = out.player_games.find((p) => p.role === 'qb');
  assert.equal(qb.espn_athlete_id, null);
  assert.equal(qb.gsis_id, '00-0039918');
});

test('rejects duplicate play ids, foreign teams, and self-play', () => {
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [nflPlay(), nflPlay()],
  })), /duplicate play_id/);
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ possession_team: 'GB' })],
  })), /team that is not in this game/);
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ defense_team: 'CHI' })],
  })), /possession_team === defense_team/);
});

test('rejects non-finite EPA rather than storing a hole', () => {
  for (const epa of [null, undefined, 'x', Infinity, NaN]) {
    rejects(() => validateNflEpaPayload(nflPayload({ plays: [nflPlay({ epa })] })));
  }
});

test('NFL: a play that is neither pass nor rush is rejected', () => {
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ is_pass: false, is_rush: false, is_dropback: false, passer_gsis_id: null })],
  })), /neither pass nor rush/);
});

test('NFL: a dropback naming a passer must carry qb_epa', () => {
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ qb_epa: null })],
  })), /no qb_epa/);
});

test('success survives as null; missing is not zero', () => {
  const out = validateNflEpaPayload(nflPayload({
    plays: [nflPlay({ success: null })],
  }));
  assert.equal(out.plays[0].success, null);
  assert.equal(out.team_games.find((t) => t.team === 'CHI').off_success, 0);
  rejects(() => validateNflEpaPayload(nflPayload({ plays: [nflPlay({ success: 7 })] })), /0, 1 or null/);
});

test('CFB: a play id past 2**53 survives exactly, and a number is refused', () => {
  const out = validateCfbEpaPayload(cfbPayload());
  assert.equal(out.plays[0].play_id, '401858212104999901');
  assert.ok(Number('401858212104999901') > 2 ** 53);
  rejects(() => validateCfbEpaPayload(cfbPayload({
    plays: [cfbPlay({ play_id: 401858212104999901 })],
  })), /must be a numeric id as a string/);
});

test('CFB: a game the source does not call completed is refused', () => {
  rejects(() => validateCfbEpaPayload(cfbPayload({ source_says_completed: false })), /does not mark completed/);
  rejects(() => validateCfbEpaPayload(cfbPayload({ source_says_completed: undefined })), /does not mark completed/);
});

test('CFB: a play that is neither pass nor rush is ACCEPTED', () => {
  // The college denominator is scrimmage_play, which admits fumble
  // recoveries, safeties and defensive two-point conversions -- about 1% of
  // plays. This is the deliberate divergence from the NFL predicate.
  const out = validateCfbEpaPayload(cfbPayload({
    plays: [
      cfbPlay(),
      cfbPlay({ play_id: '401858212104999905', is_pass: false, is_rush: false, epa: -0.9, passer_athlete_id: null, play_type: 'Fumble Recovery (Opponent)' }),
      cfbPlay({ play_id: '401858212104999904', possession_team_id: '151', possession_team: 'East Carolina', defense_team_id: '333', epa: 0.1, passer_athlete_id: '5113896' }),
    ],
  }));
  const bama = out.team_games.find((t) => t.team_id === '333');
  assert.equal(bama.off_plays, 2);
  assert.equal(bama.off_pass_plays + bama.off_rush_plays, 1);   // NOT equal to off_plays
});

test('CFB: penalty-no-play is kept, with its audit flag intact', () => {
  const out = validateCfbEpaPayload(cfbPayload({
    plays: [cfbPlay({ is_penalty_no_play: true }), cfbPlay({ play_id: '401858212104999904', possession_team_id: '151', possession_team: 'EC', defense_team_id: '333', epa: 0.1, passer_athlete_id: '5113896' })],
  }));
  assert.equal(out.plays[0].is_penalty_no_play, 1);
  assert.equal(out.team_games.find((t) => t.team_id === '333').off_plays, 1);
});

test('CFB: player rows are passer/rusher and carry epa_basis', () => {
  const out = validateCfbEpaPayload(cfbPayload());
  const passer = out.player_games.find((p) => p.athlete_id === '5144959');
  assert.equal(passer.role, 'passer');
  assert.equal(passer.epa_basis, CFB_EPA_BASIS);
  assert.equal(round(passer.epa), -0.2);            // 0.4 + (-0.6), play EPA not qb_epa
  assert.equal(passer.team_id, '333');
  assert.ok(out.player_games.every((p) => p.role !== 'qb'));
});

test('a player credited to both teams in one game is rejected, not silently split', () => {
  rejects(() => validateCfbEpaPayload(cfbPayload({
    plays: [
      cfbPlay(),
      cfbPlay({ play_id: '401858212104999904', possession_team_id: '151', possession_team: 'East Carolina', defense_team_id: '333', epa: 0.1 }),
    ],
  })), /two different teams in one game/);
  rejects(() => validateNflEpaPayload(nflPayload({
    plays: [
      nflPlay(),
      nflPlay({ play_id: '9', possession_team: 'MIN', defense_team: 'CHI', epa: 0.2, qb_epa: 0.2 }),
    ],
  })), /two different teams in one game/);
});

test('a drive may model MORE plays than the provider counted', () => {
  // Measured on nflverse 2025: drive_play_count excludes accepted-penalty
  // plays while the predicate keeps them, so modeled exceeds the provider
  // count on 18.1% of drives. Rejecting that shape rejected every real NFL
  // week; judging coverage by equality would call a fifth of the league
  // partial. Coverage is measured against what the model was in scope to
  // score, and the provider's own count is stored beside ours untouched.
  const out = validateNflEpaPayload(nflPayload({
    drives: [{
      drive_id: '1', sequence: 1, possession_team: 'CHI', start_period: 1,
      start_clock: '15:00', end_period: 1, end_clock: '12:00', result: 'Punt',
      plays: 2,                 // provider count, smaller
      modeled_plays: 3,         // ours, larger, because of accepted penalties
      in_scope_plays: 3,
      yards: null, epa: 0.65, coverage: 'complete',
    }],
  }));
  assert.equal(out.drives[0].plays, 2);
  assert.equal(out.drives[0].modeled_plays, 3);
  assert.equal(out.drives[0].coverage, 'complete');
});

test('a drive that missed a play in scope is partial, and cannot claim complete', () => {
  const drive = (over) => ({
    drive_id: '1', sequence: 1, possession_team: 'CHI', start_period: 1,
    start_clock: '15:00', end_period: 1, end_clock: '12:00', result: 'Punt',
    plays: 5, modeled_plays: 3, in_scope_plays: 4, yards: null, epa: 0.1, ...over,
  });
  const out = validateNflEpaPayload(nflPayload({ drives: [drive({ coverage: 'partial' })] }));
  assert.equal(out.drives[0].coverage, 'partial');
  rejects(() => validateNflEpaPayload(nflPayload({ drives: [drive({ coverage: 'complete' })] })),
    /must have scored every play in scope/);
  rejects(() => validateNflEpaPayload(nflPayload({
    drives: [drive({ coverage: 'partial', modeled_plays: 9 })],
  })), /scored more plays than were in scope/);
});

test('league must match the payload', () => {
  rejects(() => validateNflEpaPayload(cfbPayload()), /league must be "nfl"/);
  rejects(() => validateCfbEpaPayload(nflPayload()), /league must be "cfb"/);
});

test('an oversized description or a bad season is refused', () => {
  rejects(() => validateNflEpaPayload(nflPayload({ plays: [nflPlay({ description: 'x'.repeat(1001) })] })), /exceeds 1000/);
  rejects(() => validateNflEpaPayload(nflPayload({ season: 1899 })));
  rejects(() => validateNflEpaPayload(nflPayload({ week: 0 })));
});

function round(n) { return Math.round(n * 1e6) / 1e6; }
