/**
 * Worker-native validation and aggregation for EPA import payloads.
 *
 * No I/O. Callers decide where a payload came from and where the rows go.
 *
 * The offline tool in `scripts/epa/` already validates and aggregates, but that
 * is a convenience for whoever runs it, not a guarantee — it runs on someone's
 * laptop, in Python, outside this Worker's control. The same rule that governs
 * Pick'em applies here: a rule enforced in the client is not a rule. So this
 * module **recomputes every aggregate from the plays** and then cross-checks the
 * submitted team and player rows against what it derived. A mismatch is a
 * rejection, not a correction: if the two disagree, one of them is wrong and
 * silently storing either is worse than refusing.
 *
 * NFL and CFB are validated by separate exported functions with separate rules.
 * They share only the primitives at the top of this file. See DECISIONS.md,
 * "EPA spike accepted; storage contract settled".
 */

import { bad } from './http.js';

export const NFL_PARSER_VERSION = 1;
export const CFB_PARSER_VERSION = 1;

export const DEFENSE_SIGN = 'negated_opponent_offense_higher_is_better';
export const NFL_MODEL = 'nflverse/nflfastR expected points';
export const CFB_EPA_BASIS = 'play_epa_on_plays_where_athlete_is_named';

/** Float comparison tolerance for cross-checking sums of ~hundreds of doubles. */
const EPS = 1e-6;

const NFL_ROLES = new Set(['qb', 'rusher']);
const CFB_ROLES = new Set(['passer', 'rusher']);

/** ESPN ids are digit strings. Numbers are refused outright, not coerced:
 *  a CFB play id exceeds 2**53 and would already have been rounded by the
 *  JSON parser before this code could see it. */
function idString(value, field) {
  if (typeof value !== 'string' || !/^[0-9]{1,24}$/.test(value)) {
    throw bad(`${field} must be a numeric id as a string`, { got: typeof value === 'number' ? 'number (would lose precision)' : String(value).slice(0, 40) });
  }
  return value;
}

/** A short opaque token: a team abbreviation, a GSIS id, a role. */
function token(value, field, { max = 64, pattern = /^[A-Za-z0-9_.-]{1,64}$/ } = {}) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) {
    throw bad(`${field} is not a valid identifier`, { got: String(value).slice(0, 40) });
  }
  return value;
}

function num(value, field, { required = true } = {}) {
  if (value == null) {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw bad(`${field} must be a finite number`, { got: String(value).slice(0, 40) });
  }
  return value;
}

function intIn(value, field, lo, hi, { required = true } = {}) {
  if (value == null) {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw bad(`${field} must be an integer in [${lo}, ${hi}]`, { got: String(value).slice(0, 40) });
  }
  return value;
}

/** Tri-state. `null` survives as `null`: missing is not zero. */
function boolInt(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw bad(`${field} must be a boolean`, { got: String(value).slice(0, 40) });
}

function successValue(value, field) {
  if (value == null) return null;
  if (value === 0 || value === 1) return value;
  throw bad(`${field} must be 0, 1 or null`, { got: String(value).slice(0, 40) });
}

function text(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw bad(`${field} must be a string`, { got: typeof value });
  if (value.length > max) throw bad(`${field} exceeds ${max} characters`, { length: value.length });
  return value;
}

function array(value, field, { min = 1, max = 5000 } = {}) {
  if (!Array.isArray(value)) throw bad(`${field} must be an array`);
  if (value.length < min) throw bad(`${field} must contain at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  if (value.length > max) throw bad(`${field} exceeds ${max} entries`, { length: value.length });
  return value;
}

function close(a, b) {
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Compare a derived aggregate against the one the client sent.
 * Reports the field and both values, so a mismatch is diagnosable from the
 * response rather than requiring a re-run with logging.
 */
function agree(derived, claimed, fields, label) {
  for (const f of fields) {
    const d = derived[f];
    const c = claimed[f];
    const ok = typeof d === 'number' && typeof c === 'number'
      ? close(d, c)
      : d === c;
    if (!ok) {
      throw bad(`${label}: submitted ${f} does not match the value derived from the plays`, {
        field: f, derived: d, submitted: c,
      });
    }
  }
}

/**
 * Validate provider drive summaries.
 *
 * `result`, `plays` and `yards` are the upstream's own values and are stored
 * verbatim. Only `epa` is derived, by summing the plays that passed the
 * qualifying predicate — which is why `modeled_plays` travels beside the
 * provider's `plays` and why `coverage` distinguishes the two. Most drives are
 * `partial` for ordinary reasons (kickoffs, punts and kneels sit outside the
 * predicate), so partial is not a fault; it is the number a chart needs in
 * order to say how many drives it is leaving out.
 *
 * `yards` is null for every NFL drive. nflverse publishes no drive net-yards
 * field, and subtracting its start/end yard-line strings would be a
 * field-position inference the contract forbids.
 */
function validateDrives(raw, { teamField, teamValues, eventId }) {
  if (raw == null) return [];
  const rows = array(raw, 'drives', { min: 0, max: 400 });
  const seenId = new Set();
  const seenSeq = new Set();
  const out = [];

  for (const d of rows) {
    if (!d || typeof d !== 'object') throw bad('every drive must be an object');
    const drive_id = idString(d.drive_id, 'drive.drive_id');
    if (seenId.has(drive_id)) throw bad('duplicate drive_id', { drive_id });
    seenId.add(drive_id);

    const sequence = intIn(d.sequence, 'drive.sequence', 1, 400);
    if (seenSeq.has(sequence)) throw bad('duplicate drive sequence', { sequence });
    seenSeq.add(sequence);

    const team = d[teamField];
    if (!teamValues.has(team)) {
      throw bad('drive names a team that is not in this game', { drive_id, [teamField]: String(team).slice(0, 24) });
    }

    const plays = intIn(d.plays, 'drive.plays', 0, 100, { required: false });
    const modeled_plays = intIn(d.modeled_plays, 'drive.modeled_plays', 0, 100);
    const in_scope = intIn(d.in_scope_plays, 'drive.in_scope_plays', 0, 100, { required: false });

    // NOT compared against the provider's `plays`. Measured on nflverse 2025:
    // `drive_play_count` excludes accepted-penalty plays while the qualifying
    // predicate deliberately keeps them, so modeled exceeds the provider count
    // on 18.1% of drives. An earlier version rejected exactly those payloads,
    // and a "complete means modeled == provider" rule would have marked a fifth
    // of the league partial for no real reason. The two counts measure
    // different things and both are stored.
    if (in_scope != null && modeled_plays > in_scope) {
      throw bad('drive scored more plays than were in scope for the model', { drive_id, in_scope, modeled_plays });
    }
    const coverage = d.coverage;
    if (coverage !== 'complete' && coverage !== 'partial') {
      throw bad('drive coverage must be complete or partial', { drive_id, got: String(coverage).slice(0, 20) });
    }
    if (coverage === 'complete' && in_scope != null && modeled_plays !== in_scope) {
      throw bad('a complete drive must have scored every play in scope for the model',
        { drive_id, in_scope, modeled_plays });
    }

    out.push({
      event_id: eventId,
      drive_id,
      sequence,
      [teamField]: team,
      ...(teamField === 'possession_team_id' ? { possession_team: text(d.possession_team, 'drive.possession_team', 120) } : {}),
      start_period: intIn(d.start_period, 'drive.start_period', 1, 12, { required: false }),
      start_clock: text(d.start_clock, 'drive.start_clock', 16),
      end_period: intIn(d.end_period, 'drive.end_period', 1, 12, { required: false }),
      end_clock: text(d.end_clock, 'drive.end_clock', 16),
      result: text(d.result, 'drive.result', 64),
      plays,
      yards: intIn(d.yards, 'drive.yards', -200, 200, { required: false }),
      epa: num(d.epa, 'drive.epa', { required: false }),
      modeled_plays,
      coverage,
    });
  }
  out.sort((a, b) => a.sequence - b.sequence);
  return out;
}

/**
 * Coverage counts. `eligible_*` is what the source held; `modeled_*` is what
 * passed the predicate. Both are required by the contract so a UI can report
 * "129 of 129" rather than implying a complete game from a non-empty array.
 */
function validateCoverage(raw, { plays, drives }) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const modeled_plays = plays.length;
  const complete_drives = drives.filter((d) => d.coverage === 'complete').length;
  const eligible_plays = intIn(c.eligible_plays, 'coverage.eligible_plays', 0, 100000, { required: false });
  const eligible_drives = intIn(c.eligible_drives, 'coverage.eligible_drives', 0, 1000, { required: false });

  if (eligible_plays != null && eligible_plays < modeled_plays) {
    throw bad('coverage claims fewer eligible plays than were modeled', { eligible_plays, modeled_plays });
  }
  if (eligible_drives != null && eligible_drives < drives.length) {
    throw bad('coverage claims fewer eligible drives than were supplied', { eligible_drives, drives: drives.length });
  }
  // Derived here rather than trusted, for the same reason the aggregates are.
  return { eligible_plays, modeled_plays, eligible_drives, complete_drives };
}

/* ------------------------------------------------------------------ NFL -- */

/**
 * Validate an NFL EPA payload and return storable rows.
 *
 * Rejects (never repairs): duplicate play keys, non-finite EPA, a team outside
 * the game's two, possession === defense, an aggregate that disagrees with the
 * plays, an unknown role, or a dropback credited to a passer with no qb_epa.
 */
export function validateNflEpaPayload(payload) {
  if (!payload || typeof payload !== 'object') throw bad('payload must be an object');
  if (payload.league !== 'nfl') throw bad('league must be "nfl"', { got: String(payload.league).slice(0, 20) });

  const event_id = idString(payload.event_id, 'event_id');
  const nflverse_game_id = token(payload.nflverse_game_id, 'nflverse_game_id', { pattern: /^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$/ });
  const season = intIn(payload.season, 'season', 2000, 2100);
  const season_type = intIn(payload.season_type_espn, 'season_type_espn', 1, 3);
  const week = intIn(payload.week, 'week', 1, 30);
  const home_team = token(payload.home_team, 'home_team', { pattern: /^[A-Z]{2,4}$/ });
  const away_team = token(payload.away_team, 'away_team', { pattern: /^[A-Z]{2,4}$/ });
  if (home_team === away_team) throw bad('home_team and away_team are the same');

  const teams = new Set([home_team, away_team]);
  const rawPlays = array(payload.plays, 'plays');
  const seen = new Set();
  const plays = [];

  for (const p of rawPlays) {
    if (!p || typeof p !== 'object') throw bad('every play must be an object');
    const play_id = idString(p.play_id, 'play.play_id');
    if (seen.has(play_id)) throw bad('duplicate play_id', { play_id });
    seen.add(play_id);

    const possession_team = token(p.possession_team, 'play.possession_team', { pattern: /^[A-Z]{2,4}$/ });
    const defense_team = token(p.defense_team, 'play.defense_team', { pattern: /^[A-Z]{2,4}$/ });
    if (!teams.has(possession_team) || !teams.has(defense_team)) {
      throw bad('play references a team that is not in this game', { play_id, possession_team, defense_team });
    }
    if (possession_team === defense_team) throw bad('play has possession_team === defense_team', { play_id });

    const is_pass = boolInt(p.is_pass, 'play.is_pass');
    const is_rush = boolInt(p.is_rush, 'play.is_rush');
    if (is_pass === 1 && is_rush === 1) throw bad('play is flagged as both pass and rush', { play_id });
    if (is_pass === 0 && is_rush === 0) {
      // The NFL predicate requires pass or rush; a play that is neither should
      // never have reached the payload. CFB is different and deliberately so.
      throw bad('NFL play is neither pass nor rush; the qualifying predicate should have excluded it', { play_id });
    }
    const is_dropback = boolInt(p.is_dropback, 'play.is_dropback');
    const qb_epa = num(p.qb_epa, 'play.qb_epa', { required: false });
    const passer_gsis_id = p.passer_gsis_id == null ? null : token(p.passer_gsis_id, 'play.passer_gsis_id');
    if (is_dropback === 1 && passer_gsis_id && qb_epa == null) {
      throw bad('dropback names a passer but carries no qb_epa', { play_id });
    }

    plays.push({
      event_id,
      play_id,
      drive: p.drive == null ? null : token(p.drive, 'play.drive', { pattern: /^[0-9]{1,6}$/ }),
      quarter: intIn(p.quarter, 'play.quarter', 1, 10, { required: false }),
      clock: text(p.clock, 'play.clock', 16),
      down: intIn(p.down, 'play.down', 1, 4, { required: false }),
      yards_to_go: intIn(p.yards_to_go, 'play.yards_to_go', 0, 99, { required: false }),
      yardline_100: intIn(p.yardline_100, 'play.yardline_100', 0, 100, { required: false }),
      possession_team,
      defense_team,
      play_type: text(p.play_type, 'play.play_type', 64),
      description: text(p.description, 'play.description', 1000),
      ep_before: num(p.ep_before, 'play.ep_before', { required: false }),
      epa: num(p.epa, 'play.epa'),
      qb_epa,
      success: successValue(p.success, 'play.success'),
      is_pass,
      is_rush,
      is_dropback,
      is_sack: boolInt(p.is_sack, 'play.is_sack'),
      is_penalty: boolInt(p.is_penalty, 'play.is_penalty'),
      passer_gsis_id,
      rusher_gsis_id: p.rusher_gsis_id == null ? null : token(p.rusher_gsis_id, 'play.rusher_gsis_id'),
      receiver_gsis_id: p.receiver_gsis_id == null ? null : token(p.receiver_gsis_id, 'play.receiver_gsis_id'),
    });
  }

  const team_games = deriveNflTeamGames({ event_id, home_team, away_team }, plays);
  const player_games = deriveNflPlayerGames(event_id, plays, payload.player_games);
  const drives = validateDrives(payload.drives, { teamField: 'possession_team', teamValues: teams, eventId: event_id });
  const coverage = validateCoverage(payload.coverage, { plays, drives });

  crossCheckTeams(team_games, payload.team_games, 'team', 'team', [
    'off_epa', 'off_plays', 'off_success', 'off_pass_epa', 'off_dropbacks', 'off_pass_success',
    'off_rush_epa', 'off_designed_rushes', 'off_rush_success',
  ]);
  crossCheckPlayers(player_games, payload.player_games, (r) => `${r.gsis_id}/${r.role}`, 'gsis_id');

  return {
    league: 'nfl',
    game: {
      event_id, nflverse_game_id, season, season_type, week, home_team, away_team,
      gameday: text(payload.gameday, 'gameday', 32),
      overtime: payload.overtime == null ? 0 : boolInt(payload.overtime, 'overtime'),
      source_url: text(payload.source?.pbp_url, 'source.pbp_url', 500) || '',
      source_updated_at: text(payload.source?.pbp_last_modified, 'source.pbp_last_modified', 64),
      parser_version: NFL_PARSER_VERSION,
      predicate_version: intIn(payload.predicate_version, 'predicate_version', 1, 999),
      model: NFL_MODEL,
      // nflverse publishes no model version string. Null rather than invented.
      model_version: text(payload.model_version, 'model_version', 64),
      coverage: 'complete',
      ...coverage,
    },
    plays,
    drives,
    team_games,
    player_games,
    warnings: [],
  };
}

function deriveNflTeamGames(game, plays) {
  const blank = (team, opponent, home_away) => ({
    event_id: game.event_id, team, opponent, home_away,
    off_epa: 0, off_plays: 0, off_success: 0,
    off_pass_epa: 0, off_dropbacks: 0, off_pass_success: 0,
    off_rush_epa: 0, off_designed_rushes: 0, off_rush_success: 0,
  });
  const rows = new Map([
    [game.home_team, blank(game.home_team, game.away_team, 'home')],
    [game.away_team, blank(game.away_team, game.home_team, 'away')],
  ]);

  for (const p of plays) {
    const t = rows.get(p.possession_team);
    t.off_epa += p.epa;
    t.off_plays += 1;
    t.off_success += p.success || 0;
    if (p.is_pass) {
      t.off_pass_epa += p.epa;
      t.off_dropbacks += 1;
      t.off_pass_success += p.success || 0;
    }
    if (p.is_rush) {
      t.off_rush_epa += p.epa;
      t.off_designed_rushes += 1;
      t.off_rush_success += p.success || 0;
    }
  }

  const out = [];
  for (const row of rows.values()) {
    const opp = rows.get(row.opponent);
    // NFL only: pass and rush partition the qualifying plays exactly, because
    // the predicate requires one or the other. The CFB table cannot assert
    // this — see epa-validate's CFB half and migration 0004.
    if (row.off_dropbacks + row.off_designed_rushes !== row.off_plays) {
      throw bad('NFL pass and rush counts do not partition the team\'s plays', { team: row.team });
    }
    out.push({
      ...row,
      def_epa: -opp.off_epa,
      def_plays: opp.off_plays,
      def_pass_epa: -opp.off_pass_epa,
      def_dropbacks_faced: opp.off_dropbacks,
      def_rush_epa: -opp.off_rush_epa,
      def_designed_rushes_faced: opp.off_designed_rushes,
      def_success_allowed: opp.off_success,
      // Split success allowed, mirrored from the opponent's offensive splits.
      // Without these a pass success rate could only be produced by dividing
      // an all-play success count by a split denominator, which is a different
      // quantity wearing the right label.
      def_pass_success_allowed: opp.off_pass_success,
      def_rush_success_allowed: opp.off_rush_success,
      defense_sign_convention: DEFENSE_SIGN,
    });
  }
  out.sort((a, b) => a.team.localeCompare(b.team));
  return out;
}

function deriveNflPlayerGames(event_id, plays, claimed) {
  const rows = new Map();
  const identity = new Map();
  for (const r of Array.isArray(claimed) ? claimed : []) {
    if (r && typeof r === 'object' && typeof r.gsis_id === 'string') {
      identity.set(`${r.gsis_id}/${r.role}`, {
        // Nullable by design: a missing crosswalk costs a player-popup link,
        // never a team's EPA.
        espn_athlete_id: r.espn_athlete_id == null ? null : idString(r.espn_athlete_id, 'player.espn_athlete_id'),
        display_name: text(r.display_name, 'player.display_name', 120),
      });
    }
  }

  const bucket = (gsis_id, role, team) => {
    const key = `${gsis_id}/${role}`;
    if (!rows.has(key)) {
      const known = identity.get(key) || {};
      rows.set(key, {
        event_id, gsis_id, role, team,
        espn_athlete_id: known.espn_athlete_id ?? null,
        display_name: known.display_name ?? null,
        epa: 0, opportunities: 0, successes: 0,
      });
    }
    const row = rows.get(key);
    // One player cannot be on both teams in one game. If the plays say
    // otherwise the payload is corrupt, and picking the first team seen would
    // silently attribute half a player's EPA to the wrong side.
    if (row.team !== team) {
      throw bad('player is credited to two different teams in one game', { gsis_id, role, teams: [row.team, team] });
    }
    return row;
  };

  for (const p of plays) {
    if (p.is_dropback && p.passer_gsis_id) {
      const r = bucket(p.passer_gsis_id, 'qb', p.possession_team);
      r.epa += p.qb_epa;              // QB rows use nflverse qb_epa, not play epa
      r.opportunities += 1;
      r.successes += p.success || 0;
    }
    if (p.is_rush && p.rusher_gsis_id) {
      const r = bucket(p.rusher_gsis_id, 'rusher', p.possession_team);
      r.epa += p.epa;
      r.opportunities += 1;
      r.successes += p.success || 0;
    }
  }

  const out = [...rows.values()];
  for (const r of out) {
    if (!NFL_ROLES.has(r.role)) throw bad('unknown NFL player role', { role: r.role });
  }
  out.sort((a, b) => (a.role + a.gsis_id).localeCompare(b.role + b.gsis_id));
  return out;
}

/* ------------------------------------------------------------------ CFB -- */

/**
 * Validate a CFB EPA payload and return storable rows.
 *
 * Differs from the NFL half in ways that are deliberate, not accidental:
 *  - a play need not be pass or rush (the college denominator is
 *    `scrimmage_play`, which admits fumble recoveries, safeties and defensive
 *    two-point conversions — about 1% of plays), so no partition check;
 *  - roles are passer/rusher, not qb/rusher, and every player row carries
 *    `epa_basis` because college has no `qb_epa` equivalent;
 *  - a game the source itself calls incomplete is refused outright.
 */
export function validateCfbEpaPayload(payload) {
  if (!payload || typeof payload !== 'object') throw bad('payload must be an object');
  if (payload.league !== 'cfb') throw bad('league must be "cfb"', { got: String(payload.league).slice(0, 20) });

  // The completeness gate, enforced here rather than trusted to the importer.
  // 44 of ESPN's 99 week-1 2026 finals were present upstream but captured
  // mid-game; one held 179 plays against a complete game's 161, so play count
  // is not a substitute check.
  if (payload.source_says_completed !== true) {
    throw bad('refusing a CFB game the source does not mark completed', {
      event_id: String(payload.event_id).slice(0, 20),
      hint: 'source_says_completed must be true; a mid-game capture is not analysis',
    });
  }

  const event_id = idString(payload.event_id, 'event_id');
  const season = intIn(payload.season, 'season', 2000, 2100);
  const season_type = intIn(payload.season_type_espn, 'season_type_espn', 1, 3);
  const week = intIn(payload.week, 'week', 1, 30);
  const home_team_id = idString(payload.home_team_id, 'home_team_id');
  const away_team_id = idString(payload.away_team_id, 'away_team_id');
  if (home_team_id === away_team_id) throw bad('home_team_id and away_team_id are the same');

  const teams = new Set([home_team_id, away_team_id]);
  const rawPlays = array(payload.plays, 'plays');
  const seen = new Set();
  const plays = [];

  for (const p of rawPlays) {
    if (!p || typeof p !== 'object') throw bad('every play must be an object');
    const play_id = idString(p.play_id, 'play.play_id');
    if (seen.has(play_id)) throw bad('duplicate play_id', { play_id });
    seen.add(play_id);

    const possession_team_id = idString(p.possession_team_id, 'play.possession_team_id');
    const defense_team_id = idString(p.defense_team_id, 'play.defense_team_id');
    if (!teams.has(possession_team_id) || !teams.has(defense_team_id)) {
      throw bad('play references a team that is not in this game', { play_id, possession_team_id, defense_team_id });
    }
    if (possession_team_id === defense_team_id) throw bad('play has possession === defense', { play_id });

    const is_pass = boolInt(p.is_pass, 'play.is_pass');
    const is_rush = boolInt(p.is_rush, 'play.is_rush');
    if (is_pass === 1 && is_rush === 1) throw bad('play is flagged as both pass and rush', { play_id });
    // No "neither" check: see the function comment.

    plays.push({
      event_id,
      play_id,
      play_number: intIn(p.play_number, 'play.play_number', 1, 999, { required: false }),
      drive_id: p.drive_id == null ? null : idString(p.drive_id, 'play.drive_id'),
      period: intIn(p.period, 'play.period', 1, 12, { required: false }),
      clock: text(p.clock, 'play.clock', 16),
      down: intIn(p.down, 'play.down', 1, 4, { required: false }),
      yards_to_go: intIn(p.yards_to_go, 'play.yards_to_go', 0, 99, { required: false }),
      yards_to_endzone: intIn(p.yards_to_endzone, 'play.yards_to_endzone', 0, 100, { required: false }),
      possession_team_id,
      possession_team: text(p.possession_team, 'play.possession_team', 120),
      defense_team_id,
      defense_team: text(p.defense_team, 'play.defense_team', 120),
      play_type: text(p.play_type, 'play.play_type', 64),
      description: text(p.description, 'play.description', 1000),
      ep_before: num(p.ep_before, 'play.ep_before', { required: false }),
      epa: num(p.epa, 'play.epa'),
      success: successValue(p.success, 'play.success'),
      is_pass,
      is_rush,
      is_sack: boolInt(p.is_sack, 'play.is_sack'),
      // The audit flag that keeps the penalty-no-play decision reversible.
      is_penalty_no_play: boolInt(p.is_penalty_no_play, 'play.is_penalty_no_play'),
      passer_athlete_id: p.passer_athlete_id == null ? null : idString(p.passer_athlete_id, 'play.passer_athlete_id'),
      rusher_athlete_id: p.rusher_athlete_id == null ? null : idString(p.rusher_athlete_id, 'play.rusher_athlete_id'),
      receiver_athlete_id: p.receiver_athlete_id == null ? null : idString(p.receiver_athlete_id, 'play.receiver_athlete_id'),
    });
  }

  const team_games = deriveCfbTeamGames({ event_id, home_team_id, away_team_id }, plays);
  const player_games = deriveCfbPlayerGames(event_id, plays, payload.player_games);
  const drives = validateDrives(payload.drives, { teamField: 'possession_team_id', teamValues: teams, eventId: event_id });
  const coverage = validateCoverage(payload.coverage, { plays, drives });

  crossCheckTeams(team_games, payload.team_games, 'team_id', 'team_id', [
    'off_epa', 'off_plays', 'off_success', 'off_pass_epa', 'off_pass_plays', 'off_pass_success',
    'off_rush_epa', 'off_rush_plays', 'off_rush_success',
  ]);
  crossCheckPlayers(player_games, payload.player_games, (r) => `${r.athlete_id}/${r.role}`, 'athlete_id');

  const release = payload.source?.release_timestamp;
  return {
    league: 'cfb',
    game: {
      event_id, season, season_type, week, home_team_id, away_team_id,
      source_dataset: 'compiled_season_parquet',
      source_url: text(payload.source?.pbp_url, 'source.pbp_url', 500) || '',
      source_release_timestamp: text(release && typeof release === 'object' ? release.last_updated : release, 'source.release_timestamp', 64),
      model: text(payload.model, 'model', 200) || 'cfbfastR/SportsDataverse college expected points',
      source_says_completed: 1,
      parser_version: CFB_PARSER_VERSION,
      predicate_version: intIn(payload.predicate_version, 'predicate_version', 1, 999),
      // The release timestamp is the closest thing this source publishes to a
      // model version, so it is recorded as one rather than invented.
      model_version: text(payload.model_version, 'model_version', 64),
      coverage: 'complete',
      ...coverage,
    },
    plays,
    drives,
    team_games,
    player_games,
    warnings: [],
  };
}

function deriveCfbTeamGames(game, plays) {
  const blank = (team_id, opponent_id, home_away) => ({
    event_id: game.event_id, team_id, team: null, opponent_id, opponent: null, home_away,
    conference: null,
    off_epa: 0, off_plays: 0, off_success: 0,
    off_pass_epa: 0, off_pass_plays: 0, off_pass_success: 0,
    off_rush_epa: 0, off_rush_plays: 0, off_rush_success: 0,
  });
  const rows = new Map([
    [game.home_team_id, blank(game.home_team_id, game.away_team_id, 'home')],
    [game.away_team_id, blank(game.away_team_id, game.home_team_id, 'away')],
  ]);

  for (const p of plays) {
    const t = rows.get(p.possession_team_id);
    t.team = t.team || p.possession_team;
    t.off_epa += p.epa;
    t.off_plays += 1;
    t.off_success += p.success || 0;
    if (p.is_pass) {
      t.off_pass_epa += p.epa;
      t.off_pass_plays += 1;
      t.off_pass_success += p.success || 0;
    }
    if (p.is_rush) {
      t.off_rush_epa += p.epa;
      t.off_rush_plays += 1;
      t.off_rush_success += p.success || 0;
    }
  }

  const out = [];
  for (const row of rows.values()) {
    const opp = rows.get(row.opponent_id);
    out.push({
      ...row,
      opponent: opp.team,
      def_epa: -opp.off_epa,
      def_plays: opp.off_plays,
      def_pass_epa: -opp.off_pass_epa,
      def_pass_plays_faced: opp.off_pass_plays,
      def_rush_epa: -opp.off_rush_epa,
      def_rush_plays_faced: opp.off_rush_plays,
      def_success_allowed: opp.off_success,
      def_pass_success_allowed: opp.off_pass_success,
      def_rush_success_allowed: opp.off_rush_success,
      defense_sign_convention: DEFENSE_SIGN,
    });
  }
  out.sort((a, b) => a.team_id.localeCompare(b.team_id));
  return out;
}

function deriveCfbPlayerGames(event_id, plays, claimed) {
  const names = new Map();
  for (const r of Array.isArray(claimed) ? claimed : []) {
    if (r && typeof r === 'object' && typeof r.athlete_id === 'string') {
      names.set(`${r.athlete_id}/${r.role}`, text(r.display_name, 'player.display_name', 120));
    }
  }
  const rows = new Map();
  const bucket = (athlete_id, role, team_id, team) => {
    const key = `${athlete_id}/${role}`;
    if (!rows.has(key)) {
      rows.set(key, {
        event_id, athlete_id, role, team_id, team,
        display_name: names.get(key) ?? null,
        epa: 0, opportunities: 0, successes: 0,
        epa_basis: CFB_EPA_BASIS,
      });
    }
    const row = rows.get(key);
    if (row.team_id !== team_id) {
      throw bad('player is credited to two different teams in one game', { athlete_id, role, team_ids: [row.team_id, team_id] });
    }
    return row;
  };

  for (const p of plays) {
    if (p.is_pass && p.passer_athlete_id) {
      const r = bucket(p.passer_athlete_id, 'passer', p.possession_team_id, p.possession_team);
      r.epa += p.epa;
      r.opportunities += 1;
      r.successes += p.success || 0;
    }
    if (p.is_rush && p.rusher_athlete_id) {
      const r = bucket(p.rusher_athlete_id, 'rusher', p.possession_team_id, p.possession_team);
      r.epa += p.epa;
      r.opportunities += 1;
      r.successes += p.success || 0;
    }
  }

  const out = [...rows.values()];
  for (const r of out) {
    if (!CFB_ROLES.has(r.role)) throw bad('unknown CFB player role', { role: r.role });
  }
  out.sort((a, b) => (a.role + a.athlete_id).localeCompare(b.role + b.athlete_id));
  return out;
}

/* --------------------------------------------------------- cross-checks -- */

function crossCheckTeams(derived, claimed, keyField, label, fields) {
  if (claimed == null) return;              // aggregates are optional to send
  const rows = array(claimed, 'team_games', { min: 2, max: 2 });
  const byKey = new Map(derived.map((r) => [r[keyField], r]));
  for (const c of rows) {
    if (!c || typeof c !== 'object') throw bad('every team_game must be an object');
    const key = c[keyField];
    const d = byKey.get(key);
    if (!d) throw bad('team_games names a team that is not in this game', { [label]: String(key).slice(0, 20) });
    agree(d, c, fields, `team ${key}`);
  }
}

function crossCheckPlayers(derived, claimed, keyOf, label) {
  if (claimed == null) return;
  const rows = array(claimed, 'player_games', { min: 0, max: 500 });
  const byKey = new Map(derived.map((r) => [keyOf(r), r]));
  if (rows.length !== derived.length) {
    throw bad('player_games count does not match the rows derived from the plays', {
      derived: derived.length, submitted: rows.length,
    });
  }
  for (const c of rows) {
    if (!c || typeof c !== 'object') throw bad('every player_game must be an object');
    const key = keyOf(c);
    const d = byKey.get(key);
    if (!d) throw bad('player_games names a player/role not derivable from the plays', { [label]: String(key).slice(0, 40) });
    agree(d, c, ['epa', 'opportunities', 'successes'], `player ${key}`);
  }
}
