/**
 * PUBLIC EPA reads, answered from D1.
 *
 * These sit in the local public lane (`stats` in LOCAL_PUBLIC_PREFIXES), so
 * they use `pub()` and are edge-cacheable. Nothing here reads a session, a
 * user, or a pool — there is no per-caller data in this file at all.
 *
 * The response shape follows the accepted contract in
 * NFL-IMPLEMENTATION-PLAN.md ("Game response contract") verbatim, including
 * its **camelCase keys**. That differs from the older `/stats/nfl/...` routes,
 * which are snake_case; the deviation is deliberate and confined to the EPA
 * tree, because the contract is the specification the frontend slice was
 * designed against. Every id is a string.
 *
 * Three rules shape every response:
 *
 * 1. **Numerators and denominators, never a bare rate.** A season rate is
 *    recomputed from summed totals, never averaged across games, and a split
 *    rate is always divided by its own split denominator.
 * 2. **Coverage is stated, and stated honestly.** Imported games are not a
 *    claim about a complete schedule; modeled counts are not eligible counts;
 *    and for college a truncated upstream capture is its own state.
 * 3. **Missing stays missing.** A null rate is null, never zero.
 *
 * NFL and CFB are separate route trees with separate model labels and role
 * vocabularies. They are never merged into one leaderboard: NFL QB rows
 * aggregate nflverse `qb_epa` and college passer rows aggregate play EPA.
 */

import { pub, bad, notFound } from './http.js';

const READ_TTL = 300;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Bumped when this file changes the shape of a response, so a client cache
 *  can tell a new shape from new data. */
const RESPONSE_VERSION = '2';

const MODELS = {
  nfl: { model: 'nflverse/nflfastR expected points', source: 'nflverse processed play-by-play' },
  cfb: { model: 'cfbfastR/SportsDataverse college expected points', source: 'SportsDataverse espn_cfb_pbp' },
};

const COVERAGE_SCOPE = 'Counts games imported from the upstream EPA source. It does not establish a complete schedule; verify against the provider scoreboard separately.';
const CFB_TRUNCATION_NOTE = 'The college source can publish a final game whose capture stopped mid-game. Only captures the source marks complete are imported, so importedGames can trail discovered finals for days.';
const DEFENSE_NOTE = "Defensive EPA is the negation of the opponent's offensive EPA: higher is better.";
const NFL_DRIVE_YARDS_NOTE = 'nflverse publishes no drive net-yards field, so NFL drive yards are null rather than inferred from start/end yard lines.';

const T = {
  nfl: {
    games: 'nfl_epa_games', plays: 'nfl_epa_plays', teams: 'nfl_epa_team_games',
    players: 'nfl_epa_player_games', drives: 'nfl_epa_drives', state: 'nfl_epa_import_state',
    teamKey: 'team', playerKey: 'gsis_id', roles: new Set(['qb', 'rusher']),
    passPlays: 'off_dropbacks', rushPlays: 'off_designed_rushes',
    passFaced: 'def_dropbacks_faced', rushFaced: 'def_rush_designed_placeholder',
    passFacedReal: 'def_dropbacks_faced', rushFacedReal: 'def_designed_rushes_faced',
    drivePossession: 'possession_team', sourceReleased: 'source_updated_at',
  },
  cfb: {
    games: 'cfb_epa_games', plays: 'cfb_epa_plays', teams: 'cfb_epa_team_games',
    players: 'cfb_epa_player_games', drives: 'cfb_epa_drives', state: 'cfb_epa_import_state',
    teamKey: 'team_id', playerKey: 'athlete_id', roles: new Set(['passer', 'rusher']),
    passPlays: 'off_pass_plays', rushPlays: 'off_rush_plays',
    passFacedReal: 'def_pass_plays_faced', rushFacedReal: 'def_rush_plays_faced',
    drivePossession: 'possession_team_id', sourceReleased: 'source_release_timestamp',
  },
};

/* ------------------------------------------------------------- helpers -- */

function jsonPrimitive(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // A CFB play id exceeds 2**53. Anything that would lose precision as a
  // number goes out as a string rather than silently rounding.
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return String(value);
}

function rowPrimitives(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonPrimitive(v)]));
}

/** An integer count, or null. Never coerced to 0 — missing is not zero. */
function count(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function queryParams(request, allowed) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw bad(`unknown query parameter: ${key}`);
  }
  return url.searchParams;
}

function readSeason(params) {
  const raw = params.get('season');
  const season = Number(raw);
  if (!raw || !/^[0-9]{4}$/.test(raw) || !Number.isInteger(season) || season < 2000 || season > 2100) {
    throw bad('season must be a year', { got: raw });
  }
  return season;
}

function readSeasonType(params) {
  const raw = params.get('seasonType');
  if (raw == null) return 2;
  if (raw !== '2' && raw !== '3') throw bad('seasonType must be 2 or 3', { got: raw });
  return Number(raw);
}

function readThroughWeek(params) {
  const raw = params.get('throughWeek');
  if (raw == null) return null;
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > 30) throw bad('throughWeek must be a week number', { got: raw });
  return Number(raw);
}

function readLimit(params) {
  const raw = params.get('limit');
  if (raw == null) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw bad('limit must be a positive integer', { got: raw });
  return Math.min(Number(raw), MAX_LIMIT);
}

function readSplit(params) {
  const raw = params.get('split');
  if (raw == null) return 'all';
  if (!['all', 'pass', 'rush'].includes(raw)) throw bad('split must be all, pass or rush', { got: raw });
  return raw;
}

function readMetric(params) {
  const raw = params.get('metric');
  if (raw == null) return 'total';
  if (!['total', 'per_play', 'success_rate'].includes(raw)) {
    throw bad('metric must be total, per_play or success_rate', { got: raw });
  }
  return raw;
}

function readSide(params) {
  const raw = params.get('side');
  if (raw == null) return 'offense';
  if (raw !== 'offense' && raw !== 'defense') throw bad('side must be offense or defense', { got: raw });
  return raw;
}

function eventId(value) {
  if (!/^[1-9][0-9]{0,17}$/.test(value)) throw bad('eventId must be a numeric ESPN id', { got: String(value).slice(0, 24) });
  return value;
}

/** A rate, plus the two numbers it came from. Never a rate on its own, and
 *  null rather than 0 when the denominator is missing or zero. */
function rate(numerator, denominator) {
  const n = count(numerator);
  const d = count(denominator);
  return { numerator: n, denominator: d, value: n != null && d != null && d > 0 ? n / d : null };
}

function safeWarnings(raw) {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(jsonPrimitive) : [];
  } catch {
    return [];
  }
}

function envelope(league, extra) {
  return {
    league,
    model: MODELS[league].model,
    source: MODELS[league].source,
    postgameOnly: true,
    defenseSignConvention: DEFENSE_NOTE,
    responseVersion: RESPONSE_VERSION,
    ...extra,
  };
}

/** Unix seconds to ISO-8601, as the contract's provenance block requires. */
function iso(seconds) {
  const n = count(seconds);
  return n == null ? null : new Date(n * 1000).toISOString();
}

/* ------------------------------------------------------------ coverage -- */

async function coverage(env, league, season, seasonType) {
  const t = T[league];
  const imported = await env.DB.prepare(`SELECT week,
      COUNT(*) AS importedGames,
      SUM(CASE WHEN coverage = 'complete' THEN 1 ELSE 0 END) AS completeGames,
      SUM(CASE WHEN coverage = 'partial' THEN 1 ELSE 0 END) AS partialGames,
      SUM(eligible_plays) AS eligiblePlays,
      SUM(modeled_plays) AS modeledPlays,
      SUM(eligible_drives) AS eligibleDrives,
      SUM(complete_drives) AS completeDrives,
      MAX(imported_at) AS lastImportedAt,
      MAX(${t.sourceReleased}) AS latestSourceReleasedAt
    FROM ${t.games} WHERE season = ? AND season_type = ?
    GROUP BY week ORDER BY week ASC`).bind(season, seasonType).all();

  const states = await env.DB.prepare(`SELECT week, status, COUNT(*) AS n
      FROM ${t.state} WHERE season = ? AND season_type = ?
      GROUP BY week, status`).bind(season, seasonType).all();

  const byWeek = new Map();
  for (const row of imported.results || []) {
    const r = rowPrimitives(row);
    byWeek.set(r.week, {
      week: r.week,
      importedGames: count(r.importedGames) || 0,
      completeGames: count(r.completeGames) || 0,
      partialGames: count(r.partialGames) || 0,
      eligiblePlays: count(r.eligiblePlays),
      modeledPlays: count(r.modeledPlays),
      eligibleDrives: count(r.eligibleDrives),
      completeDrives: count(r.completeDrives),
      lastImportedAt: iso(r.lastImportedAt),
      latestSourceReleasedAt: r.latestSourceReleasedAt ?? null,
      states: {},
    });
  }
  for (const row of states.results || []) {
    const week = jsonPrimitive(row.week);
    if (!byWeek.has(week)) {
      byWeek.set(week, {
        week, importedGames: 0, completeGames: 0, partialGames: 0,
        eligiblePlays: null, modeledPlays: null, eligibleDrives: null, completeDrives: null,
        lastImportedAt: null, latestSourceReleasedAt: null, states: {},
      });
    }
    byWeek.get(week).states[String(row.status)] = count(row.n) || 0;
  }
  return [...byWeek.values()].sort((a, b) => a.week - b.week);
}

/* ---------------------------------------------------------------- game -- */

function teamBlock(r, t) {
  const passPlays = r[t.passPlays];
  const rushPlays = r[t.rushPlays];
  const passFaced = r[t.passFacedReal];
  const rushFaced = r[t.rushFacedReal];
  return {
    offense: {
      epa: r.off_epa,
      plays: count(r.off_plays),
      epaPerPlay: rate(r.off_epa, r.off_plays),
      successes: count(r.off_success),
      successRate: rate(r.off_success, r.off_plays),
      passEpa: r.off_pass_epa,
      // Split denominators, never the all-play count.
      dropbacks: count(passPlays),
      passEpaPerDropback: rate(r.off_pass_epa, passPlays),
      passSuccessRate: rate(r.off_pass_success, passPlays),
      rushEpa: r.off_rush_epa,
      designedRushes: count(rushPlays),
      rushEpaPerDesignedRush: rate(r.off_rush_epa, rushPlays),
      rushSuccessRate: rate(r.off_rush_success, rushPlays),
    },
    defense: {
      epa: r.def_epa,
      plays: count(r.def_plays),
      epaPerPlay: rate(r.def_epa, r.def_plays),
      successesAllowed: count(r.def_success_allowed),
      successRateAllowed: rate(r.def_success_allowed, r.def_plays),
      passEpa: r.def_pass_epa,
      dropbacksFaced: count(passFaced),
      passEpaPerDropback: rate(r.def_pass_epa, passFaced),
      // Null until migration 0005's numerator is populated by an import;
      // an all-play success count over a split denominator would be a
      // different quantity wearing the right label.
      passSuccessRateAllowed: rate(r.def_pass_success_allowed, passFaced),
      rushEpa: r.def_rush_epa,
      designedRushesFaced: count(rushFaced),
      rushEpaPerDesignedRush: rate(r.def_rush_epa, rushFaced),
      rushSuccessRateAllowed: rate(r.def_rush_success_allowed, rushFaced),
    },
  };
}

async function gameDetail(env, league, id) {
  const t = T[league];
  const game = await env.DB.prepare(`SELECT * FROM ${t.games} WHERE event_id = ?`).bind(id).first();
  if (!game) return null;
  const g = rowPrimitives(game);

  // Teams AWAY then HOME, as the contract requires. 'away' sorts before
  // 'home' alphabetically, so ASC is the away-first order — the previous DESC
  // put home first.
  const teams = await env.DB.prepare(
    `SELECT * FROM ${t.teams} WHERE event_id = ? ORDER BY home_away ASC`
  ).bind(id).all();

  const drives = await env.DB.prepare(
    `SELECT * FROM ${t.drives} WHERE event_id = ? ORDER BY sequence ASC`
  ).bind(id).all();

  // Descending absolute EPA with a deterministic play-id tiebreaker, so two
  // plays of equal magnitude always come back in the same order.
  const impact = await env.DB.prepare(`SELECT play_id, ${league === 'cfb'
    ? 'period, possession_team_id AS possessionTeamId, drive_id'
    : 'quarter AS period, possession_team AS possessionTeamId, drive AS drive_id'},
        clock, down, yards_to_go, play_type, description, epa, success
      FROM ${t.plays} WHERE event_id = ?
      ORDER BY ABS(epa) DESC, play_id ASC LIMIT 5`).bind(id).all();

  const teamRows = (teams.results || []).map((row) => {
    const r = rowPrimitives(row);
    return {
      teamId: league === 'cfb' ? r.team_id : r.team,
      homeAway: r.home_away,
      abbreviation: league === 'cfb' ? (r.team ?? null) : r.team,
      opponentId: league === 'cfb' ? r.opponent_id : r.opponent,
      ...teamBlock(r, t),
    };
  });

  const driveRows = (drives.results || []).map((row) => {
    const r = rowPrimitives(row);
    return {
      driveId: r.drive_id,
      sequence: count(r.sequence),
      possessionTeamId: r[t.drivePossession],
      startPeriod: count(r.start_period),
      startClock: r.start_clock,
      endPeriod: count(r.end_period),
      endClock: r.end_clock,
      result: r.result,
      plays: count(r.plays),
      // NFL is always null here; see NFL_DRIVE_YARDS_NOTE.
      yards: count(r.yards),
      epa: r.epa,
      modeledPlays: count(r.modeled_plays),
      coverage: r.coverage,
    };
  });

  const impactPlays = (impact.results || []).map((row) => {
    const r = rowPrimitives(row);
    return {
      playId: r.play_id,
      possessionTeamId: r.possessionTeamId,
      period: count(r.period),
      clock: r.clock,
      driveId: r.drive_id,
      description: r.description,
      epa: r.epa,
      success: count(r.success),
    };
  });

  const warnings = safeWarnings(g.warnings_json);
  if (league === 'nfl') warnings.push(NFL_DRIVE_YARDS_NOTE);

  const modeled = count(g.modeled_plays);
  const eligible = count(g.eligible_plays);
  // `partial` is a data-quality state, not a licence to imply full-game
  // totals. It is asserted from the stored coverage, never guessed from an
  // empty array.
  const status = g.coverage === 'partial' || (modeled != null && eligible != null && modeled === 0)
    ? 'partial'
    : 'complete';

  return {
    eventId: g.event_id,
    season: count(g.season),
    seasonType: count(g.season_type),
    week: count(g.week),
    status,
    ...(league === 'cfb'
      ? { sourceDataset: g.source_dataset, sourceSaysCompleted: !!g.source_says_completed }
      : { nflverseGameId: g.nflverse_game_id, overtime: !!g.overtime }),
    teams: teamRows,
    drives: driveRows,
    impactPlays,
    coverage: {
      eligiblePlays: eligible,
      modeledPlays: modeled,
      eligibleDrives: count(g.eligible_drives),
      completeDrives: count(g.complete_drives),
      drivesReturned: driveRows.length,
      warnings,
    },
    provenance: {
      model: g.model ?? MODELS[league].model,
      modelVersion: g.model_version ?? null,
      source: g.source_url,
      sourceReleasedAt: g[t.sourceReleased] ?? null,
      importedAt: iso(g.imported_at),
      firstImportedAt: iso(g.first_imported_at),
      parserVersion: String(count(g.parser_version) ?? ''),
      predicateVersion: String(count(g.predicate_version) ?? ''),
      responseVersion: RESPONSE_VERSION,
    },
  };
}

/* --------------------------------------------------------------- teams -- */

/**
 * Ranking direction, stated rather than assumed.
 *
 * Defensive EPA is already negated so higher is better, and descending sort
 * works for it. Defensive success rate is NOT negated — it is the share of
 * opponent plays that succeeded — so lower is better and it sorts ascending.
 * Getting this wrong ranks the worst defense first, which is why the chosen
 * direction is returned in the response instead of being left implicit.
 */
function rankDirection(side, metric) {
  if (side === 'defense' && metric === 'success_rate') return { direction: 'asc', better: 'lower' };
  return { direction: 'desc', better: 'higher' };
}

async function teamSeason(env, league, season, seasonType, throughWeek, { metric, split, side, limit, teamId }) {
  const t = T[league];
  const where = ['g.season = ?', 'g.season_type = ?'];
  const binds = [season, seasonType];
  if (throughWeek != null) { where.push('g.week <= ?'); binds.push(throughWeek); }
  if (teamId != null) { where.push(`tg.${t.teamKey} = ?`); binds.push(teamId); }

  // Totals are summed, then divided once. Never an average of per-game rates.
  const rows = await env.DB.prepare(`SELECT tg.${t.teamKey} AS teamKey,
      MAX(tg.team) AS teamLabel,
      COUNT(*) AS games,
      SUM(tg.off_epa) AS offEpa, SUM(tg.off_plays) AS offPlays, SUM(tg.off_success) AS offSuccess,
      SUM(tg.off_pass_epa) AS offPassEpa, SUM(tg.${t.passPlays}) AS offPassPlays,
      SUM(tg.off_pass_success) AS offPassSuccess,
      SUM(tg.off_rush_epa) AS offRushEpa, SUM(tg.${t.rushPlays}) AS offRushPlays,
      SUM(tg.off_rush_success) AS offRushSuccess,
      SUM(tg.def_epa) AS defEpa, SUM(tg.def_plays) AS defPlays,
      SUM(tg.def_success_allowed) AS defSuccessAllowed,
      SUM(tg.def_pass_epa) AS defPassEpa, SUM(tg.${t.passFacedReal}) AS defPassPlays,
      SUM(tg.def_pass_success_allowed) AS defPassSuccessAllowed,
      SUM(tg.def_rush_epa) AS defRushEpa, SUM(tg.${t.rushFacedReal}) AS defRushPlays,
      SUM(tg.def_rush_success_allowed) AS defRushSuccessAllowed
    FROM ${t.teams} AS tg JOIN ${t.games} AS g ON g.event_id = tg.event_id
    WHERE ${where.join(' AND ')}
    GROUP BY tg.${t.teamKey}`).bind(...binds).all();

  const { direction, better } = rankDirection(side, metric);

  const teams = (rows.results || []).map((row) => {
    const r = rowPrimitives(row);
    // Each split divides by its OWN denominator and its OWN success numerator.
    const offense = {
      epa: count(r.offEpa),
      plays: count(r.offPlays),
      epaPerPlay: rate(r.offEpa, r.offPlays),
      successRate: rate(r.offSuccess, r.offPlays),
      passEpa: count(r.offPassEpa),
      dropbacks: count(r.offPassPlays),
      passEpaPerDropback: rate(r.offPassEpa, r.offPassPlays),
      passSuccessRate: rate(r.offPassSuccess, r.offPassPlays),
      rushEpa: count(r.offRushEpa),
      designedRushes: count(r.offRushPlays),
      rushEpaPerDesignedRush: rate(r.offRushEpa, r.offRushPlays),
      rushSuccessRate: rate(r.offRushSuccess, r.offRushPlays),
    };
    const defense = {
      epa: count(r.defEpa),
      plays: count(r.defPlays),
      epaPerPlay: rate(r.defEpa, r.defPlays),
      successRateAllowed: rate(r.defSuccessAllowed, r.defPlays),
      passEpa: count(r.defPassEpa),
      dropbacksFaced: count(r.defPassPlays),
      passEpaPerDropback: rate(r.defPassEpa, r.defPassPlays),
      passSuccessRateAllowed: rate(r.defPassSuccessAllowed, r.defPassPlays),
      rushEpa: count(r.defRushEpa),
      designedRushesFaced: count(r.defRushPlays),
      rushEpaPerDesignedRush: rate(r.defRushEpa, r.defRushPlays),
      rushSuccessRateAllowed: rate(r.defRushSuccessAllowed, r.defRushPlays),
    };

    const block = side === 'defense' ? defense : offense;
    const pick = () => {
      if (split === 'pass') {
        if (metric === 'total') return block.passEpa;
        if (metric === 'per_play') return block.passEpaPerDropback.value;
        return (side === 'defense' ? block.passSuccessRateAllowed : block.passSuccessRate).value;
      }
      if (split === 'rush') {
        if (metric === 'total') return block.rushEpa;
        if (metric === 'per_play') return block.rushEpaPerDesignedRush.value;
        return (side === 'defense' ? block.rushSuccessRateAllowed : block.rushSuccessRate).value;
      }
      if (metric === 'total') return block.epa;
      if (metric === 'per_play') return block.epaPerPlay.value;
      return (side === 'defense' ? block.successRateAllowed : block.successRate).value;
    };

    return {
      teamId: r.teamKey,
      abbreviation: r.teamLabel ?? r.teamKey,
      games: count(r.games),
      offense,
      defense,
      sortValue: pick(),
    };
  });

  // Teams with no value for the chosen metric sort last in both directions
  // rather than being treated as the best or worst.
  teams.sort((a, b) => {
    const av = a.sortValue;
    const bv = b.sortValue;
    if (av == null && bv == null) return String(a.teamId).localeCompare(String(b.teamId));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return direction === 'asc' ? av - bv : bv - av;
    return String(a.teamId).localeCompare(String(b.teamId));
  });

  const ranked = teams.slice(0, limit).map((row, i) => {
    const { sortValue, ...rest } = row;
    return { rank: sortValue == null ? null : i + 1, ...rest };
  });
  return {
    ranking: { side, metric, split, direction, better },
    teams: ranked,
    totalTeams: teams.length,
    rankedTeams: teams.filter((x) => x.sortValue != null).length,
  };
}

/* -------------------------------------------------------------- players -- */

async function playerSeason(env, league, season, seasonType, throughWeek, { role, limit, minOpportunities, playerId }) {
  const t = T[league];
  const idCol = league === 'nfl' ? 'p.gsis_id' : 'p.athlete_id';
  const where = ['g.season = ?', 'g.season_type = ?'];
  const binds = [season, seasonType];
  if (throughWeek != null) { where.push('g.week <= ?'); binds.push(throughWeek); }
  if (role != null) { where.push('p.role = ?'); binds.push(role); }
  if (playerId != null) {
    where.push(league === 'nfl' ? '(p.espn_athlete_id = ? OR p.gsis_id = ?)' : 'p.athlete_id = ?');
    binds.push(playerId);
    if (league === 'nfl') binds.push(playerId);
  }

  // Team identity is the LATEST team by game chronology, not MAX() — which
  // returns whichever value sorts highest and is meaningless for a traded
  // player. Every qualifying contribution still aggregates into the totals;
  // only the displayed team is chronological.
  const scopeWhere = ['g2.season = ?', 'g2.season_type = ?'];
  const scopeBinds = [season, seasonType];
  if (throughWeek != null) { scopeWhere.push('g2.week <= ?'); scopeBinds.push(throughWeek); }
  const latest = (col) => `(SELECT p2.${col} FROM ${t.players} AS p2
        JOIN ${t.games} AS g2 ON g2.event_id = p2.event_id
       WHERE p2.${league === 'nfl' ? 'gsis_id' : 'athlete_id'} = ${idCol} AND p2.role = p.role
         AND ${scopeWhere.join(' AND ')}
       ORDER BY g2.week DESC, g2.event_id DESC LIMIT 1)`;

  const sql = `SELECT ${idCol} AS playerKey, p.role AS role,
      ${latest('display_name')} AS displayName,
      ${latest('team')} AS team,
      ${league === 'nfl' ? `${latest('espn_athlete_id')} AS espnAthleteId,` : `${latest('team_id')} AS teamId,`}
      COUNT(*) AS games, SUM(p.epa) AS epa, SUM(p.opportunities) AS opportunities,
      SUM(p.successes) AS successes
    FROM ${t.players} AS p JOIN ${t.games} AS g ON g.event_id = p.event_id
    WHERE ${where.join(' AND ')}
    GROUP BY ${idCol}, p.role`;

  // The correlated sub-selects bind before the outer WHERE, three times for
  // NFL (name, team, espn id) and twice for CFB (name, team) plus one more
  // for team_id.
  const perLatest = scopeBinds;
  const latestCount = league === 'nfl' ? 3 : 3;
  const allBinds = [];
  for (let i = 0; i < latestCount; i += 1) allBinds.push(...perLatest);
  allBinds.push(...binds);

  const rows = await env.DB.prepare(sql).bind(...allBinds).all();

  const players = (rows.results || []).map((row) => {
    const r = rowPrimitives(row);
    const epa = count(r.epa);
    const opportunities = count(r.opportunities);
    return {
      playerId: r.playerKey,
      ...(league === 'nfl'
        ? { gsisId: r.playerKey, espnAthleteId: r.espnAthleteId ?? null }
        : { athleteId: r.playerKey, teamId: r.teamId ?? null }),
      displayName: r.displayName ?? null,
      team: r.team ?? null,
      role: r.role,
      games: count(r.games),
      epa,
      opportunities,
      epaPerOpportunity: rate(r.epa, r.opportunities),
      successRate: rate(r.successes, r.opportunities),
      // College EPA is not qb_epa. Carried per row so the two leagues can
      // never be quietly compared.
      epaBasis: league === 'cfb'
        ? 'play_epa_on_plays_where_athlete_is_named'
        : 'nflverse_qb_epa_for_qb_rows_play_epa_for_rushers',
      qualified: opportunities != null && opportunities >= minOpportunities,
    };
  });

  const qualified = players.filter((p) => p.qualified);
  qualified.sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity)
    || String(a.playerId).localeCompare(String(b.playerId)));
  return {
    players: qualified.slice(0, limit).map((row, i) => {
      const { qualified: _q, ...rest } = row;
      return { rank: i + 1, ...rest };
    }),
    totalPlayers: players.length,
    qualifiedPlayers: qualified.length,
    minimumOpportunities: minOpportunities,
    qualificationNote: 'minimumOpportunities is a Fixtura display threshold, not an official qualification standard.',
  };
}

/* -------------------------------------------------------------- routing -- */

/**
 * GET /stats/:league/epa/coverage?season&seasonType
 * GET /stats/:league/epa/games/:eventId
 * GET /stats/:league/epa/teams[/:teamId]?season&seasonType&throughWeek&side&metric&split&limit
 * GET /stats/:league/epa/players[/:playerId]?season&seasonType&throughWeek&role&limit&minOpportunities
 */
export async function handleEpaRead(request, segments, env, ctx, origin) {
  if (request.method !== 'GET') throw bad('epa reads are GET only');
  const league = segments[1];
  if (!T[league]) throw notFound(`unknown league: ${league}`);
  if (segments[2] !== 'epa') throw notFound('unknown stats route');

  const resource = segments[3];
  const rest = segments.slice(4);
  const scope = (season, seasonType, throughWeek) => ({
    season, seasonType, throughWeek,
    coverageScope: COVERAGE_SCOPE,
    ...(league === 'cfb' ? { truncationNote: CFB_TRUNCATION_NOTE } : {}),
  });

  if (resource === 'coverage' && rest.length === 0) {
    const params = queryParams(request, new Set(['season', 'seasonType']));
    const season = readSeason(params);
    const seasonType = readSeasonType(params);
    const weeks = await coverage(env, league, season, seasonType);
    const totals = weeks.reduce((acc, w) => {
      acc.importedGames += w.importedGames;
      acc.completeGames += w.completeGames;
      acc.partialGames += w.partialGames;
      for (const key of ['eligiblePlays', 'modeledPlays', 'eligibleDrives', 'completeDrives']) {
        if (w[key] != null) acc[key] = (acc[key] ?? 0) + w[key];
      }
      for (const [k, v] of Object.entries(w.states)) acc.states[k] = (acc.states[k] || 0) + v;
      return acc;
    }, {
      importedGames: 0, completeGames: 0, partialGames: 0,
      eligiblePlays: null, modeledPlays: null, eligibleDrives: null, completeDrives: null,
      states: {},
    });
    return pub(JSON.stringify(envelope(league, { ...scope(season, seasonType, null), totals, weeks })), { ttl: READ_TTL, origin });
  }

  if (resource === 'games' && rest.length === 1) {
    const id = eventId(rest[0]);
    const game = await gameDetail(env, league, id);
    if (!game) throw notFound('no EPA data for this game');
    return pub(JSON.stringify(envelope(league, { coverageScope: COVERAGE_SCOPE, ...game })), { ttl: READ_TTL, origin });
  }

  if (resource === 'teams' && rest.length <= 1) {
    const allowed = new Set(['season', 'seasonType', 'throughWeek', 'side', 'metric', 'split', 'limit']);
    const params = queryParams(request, allowed);
    const season = readSeason(params);
    const seasonType = readSeasonType(params);
    const throughWeek = readThroughWeek(params);
    const teamId = rest.length === 1 ? rest[0] : null;
    if (teamId != null && !/^[A-Za-z0-9]{1,12}$/.test(teamId)) throw bad('teamId is not valid', { got: String(teamId).slice(0, 20) });
    const data = await teamSeason(env, league, season, seasonType, throughWeek, {
      metric: readMetric(params), split: readSplit(params), side: readSide(params),
      limit: readLimit(params), teamId,
    });
    return pub(JSON.stringify(envelope(league, { ...scope(season, seasonType, throughWeek), ...data })), { ttl: READ_TTL, origin });
  }

  if (resource === 'players' && rest.length <= 1) {
    const allowed = new Set(['season', 'seasonType', 'throughWeek', 'role', 'limit', 'minOpportunities']);
    const params = queryParams(request, allowed);
    const season = readSeason(params);
    const seasonType = readSeasonType(params);
    const throughWeek = readThroughWeek(params);
    const roleRaw = params.get('role');
    if (roleRaw != null && !T[league].roles.has(roleRaw)) {
      throw bad(`role must be one of: ${[...T[league].roles].join(', ')}`, { got: roleRaw });
    }
    const minRaw = params.get('minOpportunities');
    if (minRaw != null && !/^[0-9]{1,4}$/.test(minRaw)) throw bad('minOpportunities must be a non-negative integer', { got: minRaw });
    const playerId = rest.length === 1 ? rest[0] : null;
    if (playerId != null && !/^[A-Za-z0-9-]{1,24}$/.test(playerId)) throw bad('playerId is not valid', { got: String(playerId).slice(0, 24) });
    const data = await playerSeason(env, league, season, seasonType, throughWeek, {
      role: roleRaw, limit: readLimit(params),
      minOpportunities: minRaw == null ? (playerId ? 0 : 1) : Number(minRaw),
      playerId,
    });
    return pub(JSON.stringify(envelope(league, { ...scope(season, seasonType, throughWeek), ...data })), { ttl: READ_TTL, origin });
  }

  throw notFound('unknown epa route');
}

export const __testing = { rankDirection, rate, RESPONSE_VERSION };
