/**
 * Pure recomputed-rate aggregation for retained NFL player-game facts.
 *
 * Callers supply one row per player appearance with the two component cells
 * already joined onto it. Stored provider rate/percentage cells are never read.
 */

const QUALIFICATION_SOURCE = 'NFL Guide for Statisticians (2025), full-season minimum; live threshold prorated from 16-game pace';

const rate = (formula, numeratorCategory, numeratorKey, denominatorCategory, denominatorKey, unit, fullSeasonMinimum = null, scale = 1) => ({
  formula,
  numerator: { category: numeratorCategory, key: numeratorKey },
  denominator: { category: denominatorCategory, key: denominatorKey },
  unit,
  qualification_source: fullSeasonMinimum == null ? 'none_published' : QUALIFICATION_SOURCE,
  full_season_minimum: fullSeasonMinimum,
  scale,
});

export const RATE_DEFINITIONS = Object.freeze({
  'passing.yardsPerPassAttempt': rate('sum(passing.passingYards) / sum(passing.passingAttempts)', 'passing', 'passingYards', 'passing', 'passingAttempts', 'yards_per_attempt', 224),
  'rushing.yardsPerRushAttempt': rate('sum(rushing.rushingYards) / sum(rushing.rushingAttempts)', 'rushing', 'rushingYards', 'rushing', 'rushingAttempts', 'yards_per_carry', 100),
  'receiving.yardsPerReception': rate('sum(receiving.receivingYards) / sum(receiving.receptions)', 'receiving', 'receivingYards', 'receiving', 'receptions', 'yards_per_reception', 32),
  'kickReturns.yardsPerKickReturn': rate('sum(kickReturns.kickReturnYards) / sum(kickReturns.kickReturns)', 'kickReturns', 'kickReturnYards', 'kickReturns', 'kickReturns', 'yards_per_return', 20),
  'puntReturns.yardsPerPuntReturn': rate('sum(puntReturns.puntReturnYards) / sum(puntReturns.puntReturns)', 'puntReturns', 'puntReturnYards', 'puntReturns', 'puntReturns', 'yards_per_return', 20),
  'punting.grossAvgPuntYards': rate('sum(punting.puntYards) / sum(punting.punts)', 'punting', 'puntYards', 'punting', 'punts', 'yards_per_punt', 40),
  'kicking.fieldGoalPct': rate('100 * sum(kicking.fieldGoalsMade) / sum(kicking.fieldGoalAttempts)', 'kicking', 'fieldGoalsMade', 'kicking', 'fieldGoalAttempts', 'percent', null, 100),
});

export function getRateDefinition(category, stat) {
  return RATE_DEFINITIONS[`${category}.${stat}`] || null;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function newestThan(candidate, current) {
  if (!current) return true;
  if (candidate.kickoff !== current.kickoff) return candidate.kickoff > current.kickoff;
  if (candidate.event_id !== current.event_id) return candidate.event_id > current.event_id;
  return String(candidate.team_id) < String(current.team_id);
}
function teamGameCount(teamGames, teamId) {
  const value = teamGames instanceof Map ? teamGames.get(teamId) : teamGames && teamGames[teamId];
  return Number.isInteger(value) && value > 0 ? value : 0;
}
function requiredMinimum(definition, teamGames) {
  if (definition.full_season_minimum == null) return null;
  return Math.min(definition.full_season_minimum, Math.ceil(definition.full_season_minimum * teamGames / 16));
}
function rounded(value) { return Math.round((value + Number.EPSILON) * 1000) / 1000; }
function rankOrder(a, b) {
  return b.value - a.value || String(a.athlete_id).localeCompare(String(b.athlete_id)) || String(a.team_id || '').localeCompare(String(b.team_id || ''));
}

/**
 * Aggregate component rows for one supported recomputed rate.
 *
 * A row has athlete_id, team_id, event_id, kickoff, name, position, numerator,
 * and denominator. `numerator`/`denominator` must be null when their source cell
 * is absent; numeric zero is a real observation.
 */
export function aggregateNFLRateRows(sourceRows, {
  category,
  stat,
  scope = 'league',
  onePerTeam = false,
  teamGames = {},
} = {}) {
  const definition = getRateDefinition(category, stat);
  if (!definition) throw new Error(`Unsupported recomputed rate: ${category}.${stat}`);
  if (!['league', 'team'].includes(scope)) throw new Error('scope must be league or team');
  if (onePerTeam && scope !== 'league') throw new Error('onePerTeam is only available for league scope');

  const groups = new Map();
  for (const source of sourceRows || []) {
    if (!source || source.athlete_id == null || source.team_id == null || source.event_id == null) continue;
    const athleteId = String(source.athlete_id);
    const teamId = String(source.team_id);
    const key = scope === 'team' || onePerTeam ? `${athleteId}:${teamId}` : athleteId;
    let group = groups.get(key);
    if (!group) {
      group = {
        athlete_id: athleteId,
        team_id: scope === 'team' || onePerTeam ? teamId : null,
        team_ids: new Set(), games: new Set(), games_with_stat: 0,
        numerator: 0, denominator: 0, missing_numerator_games: 0,
        missing_denominator_games: 0, zero_denominator_games: 0, latest: null,
      };
      groups.set(key, group);
    }
    group.team_ids.add(teamId);
    group.games.add(String(source.event_id));
    if (newestThan(source, group.latest)) group.latest = source;

    const numerator = numeric(source.numerator);
    const denominator = numeric(source.denominator);
    if (denominator == null) {
      group.missing_denominator_games += 1;
      continue;
    }
    if (numerator == null) {
      group.missing_numerator_games += 1;
      continue;
    }
    group.games_with_stat += 1;
    if (denominator === 0) {
      group.zero_denominator_games += 1;
      continue;
    }
    group.numerator += numerator;
    group.denominator += denominator;
  }

  const candidates = [];
  const excluded = [];
  for (const group of groups.values()) {
    const latestTeamId = String(group.latest.team_id);
    const qualificationTeamId = group.team_id || latestTeamId;
    const gamesForTeam = teamGameCount(teamGames, qualificationTeamId);
    const minimum = requiredMinimum(definition, gamesForTeam);
    const invalid = group.missing_numerator_games > 0;
    const hasDenominator = group.denominator > 0;
    const qualified = definition.full_season_minimum == null
      ? !invalid && hasDenominator
      : !invalid && hasDenominator && gamesForTeam > 0 && group.denominator >= minimum;
    const base = {
      athlete_id: group.athlete_id,
      ...(group.team_id ? { team_id: group.team_id } : {}),
      team_ids: [...group.team_ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      latest_team_id: latestTeamId,
      name: group.latest.name,
      position: group.latest.position,
      numerator: group.numerator,
      denominator: group.denominator,
      games_with_stat: group.games_with_stat,
      games_played: group.games.size,
      team_games: gamesForTeam,
      required_minimum: minimum,
      qualified,
      diagnostics: {
        missing_numerator_games: group.missing_numerator_games,
        missing_denominator_games: group.missing_denominator_games,
        zero_denominator_games: group.zero_denominator_games,
      },
    };
    if (!qualified) {
      excluded.push({ ...base, reason: invalid ? 'missing_numerator' : !hasDenominator ? 'no_positive_denominator' : gamesForTeam === 0 ? 'missing_team_games' : 'below_required_minimum' });
      continue;
    }
    candidates.push({ ...base, value: rounded(definition.scale * group.numerator / group.denominator) });
  }

  let rows = candidates;
  if (onePerTeam) {
    const representatives = new Map();
    for (const candidate of candidates) {
      const prior = representatives.get(candidate.team_id);
      if (!prior || candidate.value > prior.value || (candidate.value === prior.value && candidate.athlete_id < prior.athlete_id)) representatives.set(candidate.team_id, candidate);
    }
    rows = [...representatives.values()];
  }
  rows.sort(rankOrder);
  let previous = null;
  rows.forEach((row, index) => {
    row.rank = previous !== null && row.value === previous ? rows[index - 1].rank : index + 1;
    previous = row.value;
  });
  return { definition, rows, excluded };
}
