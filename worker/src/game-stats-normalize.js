// Converts the small, deliberately bounded part of ESPN's NFL box score into
// rows suitable for storage.  This module does no I/O: callers decide where a
// summary came from and where the normalized rows go.

const def = (label, unit, aggregation = 'sum') => ({ label, unit, aggregation });

export const STAT_DEFINITIONS = {
  'passing.completions': def('Completions', 'count'),
  'passing.passingAttempts': def('Pass attempts', 'count'),
  'passing.passingYards': def('Passing yards', 'yards'),
  'passing.yardsPerPassAttempt': def('Yards per pass attempt', 'yards', 'recompute'),
  'passing.passingTouchdowns': def('Passing touchdowns', 'count'),
  'passing.interceptions': def('Interceptions thrown', 'count'),
  'passing.sacksTaken': def('Sacks taken', 'count'),
  'passing.sackYardsLost': def('Sack yards lost', 'yards'),
  'passing.adjQBR': def('Adjusted QBR', 'rating', 'provider_only'),
  'passing.QBRating': def('Passer rating', 'rating', 'provider_only'),
  'rushing.rushingAttempts': def('Rush attempts', 'count'),
  'rushing.rushingYards': def('Rushing yards', 'yards'),
  'rushing.yardsPerRushAttempt': def('Yards per rush attempt', 'yards', 'recompute'),
  'rushing.rushingTouchdowns': def('Rushing touchdowns', 'count'),
  'rushing.longRushing': def('Longest rush', 'yards', 'max'),
  'receiving.receptions': def('Receptions', 'count'),
  'receiving.receivingYards': def('Receiving yards', 'yards'),
  'receiving.yardsPerReception': def('Yards per reception', 'yards', 'recompute'),
  'receiving.receivingTouchdowns': def('Receiving touchdowns', 'count'),
  'receiving.longReception': def('Longest reception', 'yards', 'max'),
  'receiving.receivingTargets': def('Receiving targets', 'count'),
  'fumbles.fumbles': def('Fumbles', 'count'),
  'fumbles.fumblesLost': def('Fumbles lost', 'count'),
  'fumbles.fumblesRecovered': def('Fumbles recovered', 'count'),
  'defensive.totalTackles': def('Total tackles', 'count'),
  'defensive.soloTackles': def('Solo tackles', 'count'),
  'defensive.sacks': def('Sacks', 'count'),
  'defensive.tacklesForLoss': def('Tackles for loss', 'count'),
  'defensive.passesDefended': def('Passes defended', 'count'),
  'defensive.QBHits': def('Quarterback hits', 'count'),
  'defensive.defensiveTouchdowns': def('Defensive touchdowns', 'count'),
  'interceptions.interceptions': def('Interceptions', 'count'),
  'interceptions.interceptionYards': def('Interception return yards', 'yards'),
  'interceptions.interceptionTouchdowns': def('Interception return touchdowns', 'count'),
  'kickReturns.kickReturns': def('Kick returns', 'count'),
  'kickReturns.kickReturnYards': def('Kick return yards', 'yards'),
  'kickReturns.yardsPerKickReturn': def('Yards per kick return', 'yards', 'recompute'),
  'kickReturns.longKickReturn': def('Longest kick return', 'yards', 'max'),
  'kickReturns.kickReturnTouchdowns': def('Kick return touchdowns', 'count'),
  'puntReturns.puntReturns': def('Punt returns', 'count'),
  'puntReturns.puntReturnYards': def('Punt return yards', 'yards'),
  'puntReturns.yardsPerPuntReturn': def('Yards per punt return', 'yards', 'recompute'),
  'puntReturns.longPuntReturn': def('Longest punt return', 'yards', 'max'),
  'puntReturns.puntReturnTouchdowns': def('Punt return touchdowns', 'count'),
  'kicking.fieldGoalsMade': def('Field goals made', 'count'),
  'kicking.fieldGoalAttempts': def('Field goal attempts', 'count'),
  'kicking.fieldGoalPct': def('Field goal percentage', 'percent', 'recompute'),
  'kicking.longFieldGoalMade': def('Longest field goal', 'yards', 'max'),
  'kicking.extraPointsMade': def('Extra points made', 'count'),
  'kicking.extraPointAttempts': def('Extra point attempts', 'count'),
  'kicking.totalKickingPoints': def('Kicking points', 'points'),
  'punting.punts': def('Punts', 'count'),
  'punting.puntYards': def('Punt yards', 'yards'),
  'punting.grossAvgPuntYards': def('Gross punt average', 'yards', 'recompute'),
  'punting.touchbacks': def('Punt touchbacks', 'count'),
  'punting.puntsInside20': def('Punts inside 20', 'count'),
  'punting.longPunt': def('Longest punt', 'yards', 'max'),
};

const EXPECTED_CATEGORIES = ['passing', 'rushing', 'receiving', 'fumbles', 'defensive', 'interceptions', 'kickReturns', 'puntReturns', 'kicking', 'punting'];
const REQUIRED_CATEGORIES = new Set(['passing', 'rushing', 'receiving', 'defensive']);
// ESPN's source keys, as observed in the retained NFL fixtures.  This is kept
// separate from normalized definitions because several source cells split into
// two stored statistics.
const EXPECTED_SOURCE_KEYS = {
  passing: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions', 'sacks-sackYardsLost', 'adjQBR', 'QBRating'],
  rushing: ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt', 'rushingTouchdowns', 'longRushing'],
  receiving: ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'],
  fumbles: ['fumbles', 'fumblesLost', 'fumblesRecovered'],
  defensive: ['totalTackles', 'soloTackles', 'sacks', 'tacklesForLoss', 'passesDefended', 'QBHits', 'defensiveTouchdowns'],
  interceptions: ['interceptions', 'interceptionYards', 'interceptionTouchdowns'],
  kickReturns: ['kickReturns', 'kickReturnYards', 'yardsPerKickReturn', 'longKickReturn', 'kickReturnTouchdowns'],
  puntReturns: ['puntReturns', 'puntReturnYards', 'yardsPerPuntReturn', 'longPuntReturn', 'puntReturnTouchdowns'],
  kicking: ['fieldGoalsMade/fieldGoalAttempts', 'fieldGoalPct', 'longFieldGoalMade', 'extraPointsMade/extraPointAttempts', 'totalKickingPoints'],
  punting: ['punts', 'puntYards', 'grossAvgPuntYards', 'touchbacks', 'puntsInside20', 'longPunt'],
};
const MISSING = new Set(['-', '--', '']);

function reject(message) { throw new Error(`Invalid NFL game summary: ${message}`); }
function id(value, name) {
  if (typeof value !== 'string' && typeof value !== 'number') reject(`missing ${name}`);
  const result = String(value);
  if (!/^\d+$/.test(result)) reject(`malformed ${name}`);
  return result;
}
function number(value, name) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject(`nonfinite ${name}`);
    return value;
  }
  if (typeof value !== 'string' || !/^-?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?$|^-?\.\d+$/.test(value)) reject(`malformed numeric ${name}`);
  const parsed = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(parsed)) reject(`nonfinite ${name}`);
  return parsed;
}
function isMissing(value) { return value == null || (typeof value === 'string' && MISSING.has(value.trim())); }
function split(value, separator, name) {
  if (typeof value !== 'string') reject(`malformed composite ${name}`);
  const parts = value.split(separator);
  if (parts.length !== 2 || parts.some(part => part.trim() === '')) reject(`malformed composite ${name}`);
  return parts.map(part => number(part.trim(), name));
}

/** Normalize a completed ESPN NFL summary, or throw when it is unsafe to ingest. */
export function normalizeNFLGame(summary, {
  expectedEventId,
  expectedSeason,
  expectedSeasonType,
  expectedWeek,
  expectedKickoff,
  capturedAt,
} = {}) {
  if (!summary || typeof summary !== 'object') reject('summary');
  const expected = id(expectedEventId, 'expectedEventId');
  if (!Number.isInteger(capturedAt) || capturedAt < 0) reject('capturedAt');
  const header = summary.header;
  if (!header || header.league?.slug !== 'nfl') reject('NFL league header');
  if (id(header.id, 'event id') !== expected) reject('event id does not match expectedEventId');
  const season = header.season;
  if (!Number.isInteger(season?.year) || season.year < 2000 || season.year > 2100 || ![1, 2, 3].includes(season?.type) || !Number.isInteger(header.week) || header.week < 1 || header.week > 30) reject('season, season type, or week');
  if (expectedSeason != null && season.year !== expectedSeason) reject('season does not match discovered event');
  if (expectedSeasonType != null && season.type !== expectedSeasonType) reject('season type does not match discovered event');
  if (expectedWeek != null && header.week !== expectedWeek) reject('week does not match discovered event');
  const competition = Array.isArray(header.competitions) && header.competitions.length === 1 ? header.competitions[0] : null;
  if (!competition || id(competition.id, 'competition id') !== expected) reject('competition');
  if (competition.status?.type?.completed !== true || competition.status?.type?.state !== 'post') reject('game is not completed post-game');
  if (typeof competition.date !== 'string' || !Number.isFinite(Date.parse(competition.date))) reject('kickoff date');
  const kickoff = new Date(competition.date).toISOString();
  if (expectedKickoff != null && Date.parse(kickoff) !== Date.parse(expectedKickoff)) reject('kickoff does not match discovered event');
  const sourceUpdatedAt = summary.meta?.lastUpdatedAt ?? null;
  if (sourceUpdatedAt !== null && (typeof sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sourceUpdatedAt)))) reject('source updated date');
  if (!Array.isArray(competition.competitors) || competition.competitors.length !== 2) reject('two competitors');
  const teamIds = competition.competitors.map(c => {
    const competitorId = id(c?.id, 'competitor team id');
    if (c?.team?.id != null && id(c.team.id, 'nested competitor team id') !== competitorId) reject('competitor team id mismatch');
    return competitorId;
  });
  if (new Set(teamIds).size !== 2) reject('distinct competitors');
  if (!Array.isArray(summary.boxscore?.players) || summary.boxscore.players.length !== 2) reject('boxscore player teams');

  const boxTeams = new Map();
  for (const boxTeam of summary.boxscore.players) {
    const teamId = id(boxTeam?.team?.id, 'boxscore team id');
    if (!teamIds.includes(teamId) || boxTeams.has(teamId)) reject('boxscore teams must match competitors exactly');
    boxTeams.set(teamId, boxTeam);
  }
  if (boxTeams.size !== 2) reject('boxscore teams must match competitors exactly');

  const warnings = [];
  const players = [];
  const stats = [];
  const playerTeams = new Map();
  const seenPlayers = new Set();
  const seenOutputCells = new Set();
  let partial = false;
  const warn = message => { partial = true; warnings.push(message); };

  for (const [teamId, boxTeam] of boxTeams) {
    if (!Array.isArray(boxTeam.statistics)) reject(`statistics for team ${teamId}`);
    const categories = new Set();
    for (const category of boxTeam.statistics) {
      const categoryName = category?.name;
      if (typeof categoryName !== 'string' || !categoryName) reject(`category name for team ${teamId}`);
      if (categories.has(categoryName)) reject(`duplicate category ${categoryName} for team ${teamId}`);
      categories.add(categoryName);
      if (!Array.isArray(category.keys) || !Array.isArray(category.labels) || !Array.isArray(category.athletes) || category.keys.length !== category.labels.length) reject(`unaligned category ${categoryName}`);
      if (new Set(category.keys).size !== category.keys.length || category.keys.some(key => typeof key !== 'string' || !key)) reject(`duplicate or malformed stat keys in ${categoryName}`);
      if (!EXPECTED_CATEGORIES.includes(categoryName)) { warn(`unknown category ${categoryName} for team ${teamId}`); continue; }
      if (REQUIRED_CATEGORIES.has(categoryName) && category.athletes.length === 0) reject(`empty required ${categoryName} category for team ${teamId}`);
      for (const expectedKey of EXPECTED_SOURCE_KEYS[categoryName]) if (!category.keys.includes(expectedKey)) warn(`missing expected ${categoryName}.${expectedKey} for team ${teamId}`);
      for (const key of category.keys) if (!EXPECTED_SOURCE_KEYS[categoryName].includes(key) && !STAT_DEFINITIONS[`${categoryName}.${key}`]) warn(`unknown stat ${categoryName}.${key} for team ${teamId}`);
      const seenCells = new Set();
      for (const entry of category.athletes) {
        const athleteId = id(entry?.athlete?.id, `athlete id in ${categoryName}`);
        const name = entry.athlete.displayName;
        if (typeof name !== 'string' || !name) reject(`athlete name ${athleteId}`);
        if (!Array.isArray(entry.stats) || entry.stats.length !== category.keys.length) reject(`unaligned athlete stats ${athleteId} in ${categoryName}`);
        const cellKey = `${categoryName}:${athleteId}`;
        if (seenCells.has(cellKey)) reject(`duplicate athlete stat cells ${athleteId} in ${categoryName}`);
        seenCells.add(cellKey);
        if (playerTeams.has(athleteId) && playerTeams.get(athleteId) !== teamId) reject(`athlete ${athleteId} appears for two teams`);
        playerTeams.set(athleteId, teamId);
        if (!seenPlayers.has(athleteId)) {
          seenPlayers.add(athleteId);
          const position = entry.athlete.position;
          const positionValue = position?.abbreviation ?? position?.displayName ?? null;
          if (positionValue !== null && (typeof positionValue !== 'string' || !positionValue)) reject(`athlete position ${athleteId}`);
          players.push({ athlete_id: athleteId, team_id: teamId, name, position: positionValue });
        }
        category.keys.forEach((key, index) => {
          const raw = entry.stats[index];
          const namespace = `${categoryName}.${key}`;
          if (!EXPECTED_SOURCE_KEYS[categoryName].includes(key) && !STAT_DEFINITIONS[namespace]) return;
          if (isMissing(raw)) { warn(`missing ${namespace} for athlete ${athleteId}`); return; }
          const emit = (statKey, value, statRaw) => {
            const definition = STAT_DEFINITIONS[`${categoryName}.${statKey}`];
            if (!definition) reject(`missing normalized definition ${categoryName}.${statKey}`);
            const outputCell = `${athleteId}:${teamId}:${categoryName}:${statKey}`;
            if (seenOutputCells.has(outputCell)) reject(`duplicate normalized stat cell ${outputCell}`);
            seenOutputCells.add(outputCell);
            stats.push({ athlete_id: athleteId, team_id: teamId, category: categoryName, key: statKey, value, raw: statRaw, aggregation: definition.aggregation });
          };
          if (categoryName === 'passing' && key === 'completions/passingAttempts') {
            const [completions, attempts] = split(raw, '/', namespace);
            emit('completions', completions, raw); emit('passingAttempts', attempts, raw); return;
          }
          if (categoryName === 'passing' && key === 'sacks-sackYardsLost') {
            const [sacks, yards] = split(raw, '-', namespace);
            emit('sacksTaken', sacks, raw); emit('sackYardsLost', yards, raw); return;
          }
          if (categoryName === 'kicking' && key === 'fieldGoalsMade/fieldGoalAttempts') {
            const [made, attempts] = split(raw, '/', namespace);
            emit('fieldGoalsMade', made, raw); emit('fieldGoalAttempts', attempts, raw); return;
          }
          if (categoryName === 'kicking' && key === 'extraPointsMade/extraPointAttempts') {
            const [made, attempts] = split(raw, '/', namespace);
            emit('extraPointsMade', made, raw); emit('extraPointAttempts', attempts, raw); return;
          }
          emit(key, number(raw, namespace), raw);
        });
      }
    }
    for (const required of REQUIRED_CATEGORIES) if (!categories.has(required)) reject(`missing required ${required} category for team ${teamId}`);
    for (const expectedCategory of EXPECTED_CATEGORIES) if (!categories.has(expectedCategory)) warn(`missing expected ${expectedCategory} category for team ${teamId}`);
  }

  return {
    event: { event_id: expected, season: season.year, season_type: season.type, week: header.week, kickoff, source_updated_at: sourceUpdatedAt, coverage: partial ? 'partial' : 'complete' },
    players,
    stats,
    warnings,
  };
}
