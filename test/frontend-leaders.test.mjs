import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const requests = [];
globalThis.fetch = async input => {
  const url = String(input);
  requests.push(url);
  if (url.includes('/stats/nfl/leaders?')) {
    if (url.includes('stat=soloTackles')) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 });
    return new Response(JSON.stringify({ coverage: { discovered_final_games: 1, captured_games: 1 }, rows: [{ athlete_id: '10', team_id: '34', latest_team_id: '34', rank: 1, name: 'A <Player>', position: 'QB', value: 12 }] }));
  }
  if (url.includes('/football/nfl/teams')) return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: [{ team: { id: '34', abbreviation: 'HOU', displayName: 'Houston Texans', logos: [{ href: 'https://image.test/team.png' }] } }] }] }] }));
  if (url.includes('/football/nfl/scoreboard')) return new Response(JSON.stringify({ season: { year: 2026 } }));
  throw new Error(`unexpected request ${url}`);
};

const nfl = await import('../src/nfl.js');
const dashboard = await import('../src/components/dashboard.js');

test('leader fetch validates inputs and builds encoded stats queries', async () => {
  const definition = nfl.NFL_LEADER_CATEGORIES[0];
  await nfl.fetchNFLLeaders({ season: 2026, definition, limit: 3 });
  const query = new URL(requests.find(url => url.includes('/stats/nfl/leaders?'))).searchParams;
  assert.deepEqual(Object.fromEntries(query), { season: '2026', category: 'passing', stat: 'passingYards', scope: 'league', limit: '3' });
  await assert.rejects(nfl.fetchNFLLeaders({ season: '2026', definition }), /numeric NFL season/);
  await assert.rejects(nfl.fetchNFLLeaders({ season: 2026, definition, scope: 'team' }), /numeric ESPN team ID/);
});

test('category group preserves order and one category failure stays local', async () => {
  const group = await nfl.fetchNFLLeaderGroup({ season: 2026, group: 'Defense' });
  assert.deepEqual(group.map(item => item.definition.id), nfl.NFL_LEADER_CATEGORIES.filter(item => item.group === 'Defense').map(item => item.id));
  assert.ok(group.find(item => item.definition.id === 'solo-tackles').error);
  assert.ok(group.find(item => item.definition.id === 'total-tackles').data);
});

test('formatting and section markup preserve missing values, collapse cards, and escape provider text', () => {
  assert.equal(nfl.formatNFLLeaderValue(null), '—');
  assert.equal(nfl.formatNFLLeaderValue(2.5, { format: 'sacks' }), '2.5');
  assert.equal(nfl.formatNFLLeaderValue(12.5, { unit: 'percent' }), '12.5%');
  const collapsed = dashboard.leaderSectionHTML({ label: '<NFL>', season: 2026, expanded: false, categories: [{ definition: nfl.NFL_LEADER_CATEGORIES[0], data: { rows: [{ name: 'hidden' }] } }] });
  assert.match(collapsed, /&lt;NFL&gt;/);
  assert.doesNotMatch(collapsed, /dash-card/);
  const expanded = dashboard.leaderSectionHTML({ scope: 'league', season: 2026, expanded: true, categories: [{ definition: nfl.NFL_LEADER_CATEGORIES[0], data: { coverage: { discovered_final_games: 1, captured_games: 1 }, rows: [{ athlete_id: '10', rank: 1, name: 'A <Player>', position: 'QB', value: 12, team: { abbreviation: 'HOU', logo: 'https://image.test/team.png' }, headshot: 'https://image.test/head.png' }] } }] });
  assert.match(expanded, /A &lt;Player&gt;/);
  assert.match(expanded, /data-dash-player="10"/);
  assert.doesNotMatch(expanded, /espn\.com\/.*href/i);
});

test('NFL dashboard is a reconciled top-level view and Scores has no leader mount', async () => {
  const [config, account, scores, app, nflView] = await Promise.all([
    readFile(new URL('../src/config.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/account.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/scores.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/nfl.js', import.meta.url), 'utf8'),
  ]);
  assert.match(config, /teams:'TEAMS',nfl:'NFL',f1:'F1'/);
  assert.match(config, /\['scores','teams','nfl','f1'/);
  assert.match(account, /VIEWS_KNOWN_BEFORE=\['scores','teams','f1','golf','calendar'\]/);
  assert.doesNotMatch(scores, /nflLeaders|fetchNFLLeaderGroup|leaderSectionHTML/);
  assert.match(app, /renderNFLShell\(\);loadNFLDashboard\(\)/);
  assert.match(nflView, /NFL Dashboard/);
});

const standingEntry = (id, seed) => ({
  team: { id: String(id), name: `Team ${id}`, shortDisplayName: `Team ${id}`, abbreviation: `T${id}`,
    logos: [{ href: `https://image.test/${id}.png` }] },
  stats: [
    { name: 'wins', value: 17 - seed, displayValue: String(17 - seed) },
    { name: 'losses', value: seed, displayValue: String(seed) },
    { name: 'ties', value: 0, displayValue: '0' },
    { name: 'winPercent', value: (17 - seed) / 17, displayValue: '.500' },
    { name: 'playoffSeed', value: seed, displayValue: String(seed) },
    { name: 'pointDifferential', value: 100 - seed, displayValue: `+${100 - seed}` },
    { name: 'vs. Conf.', displayValue: '8-4' },
  ],
});

function standingsFixture(withSeeds = true) {
  return { season: { year: 2025 }, children: [{ id: '8', name: 'American Football Conference', abbreviation: 'AFC',
    children: Array.from({ length: 4 }, (_, division) => ({ id: String(division), name: `AFC Division ${division + 1}`,
      abbreviation: `D${division + 1}`, standings: { entries: Array.from({ length: 4 }, (_, row) => {
        const seed = division * 4 + row + 1;
        return standingEntry(seed, withSeeds ? seed : 0);
      }) } })) }] };
}

test('conference standings use only complete official seeds for playoff cutoff labels', () => {
  const official = nfl.normalizeNFLStandings(standingsFixture(true));
  assert.equal(official.conferences[0].officialSeeds, true);
  const html = dashboard.standingsSectionHTML({ data: official, conference: 'AFC', view: 'conference' });
  assert.match(html, /Wild-card qualifiers/);
  assert.match(html, /Playoff cutoff/);

  const early = nfl.normalizeNFLStandings(standingsFixture(false));
  assert.equal(early.conferences[0].officialSeeds, false);
  const earlyHtml = dashboard.standingsSectionHTML({ data: early, conference: 'AFC', view: 'conference' });
  assert.match(earlyHtml, /has not published playoff seeds yet/);
  assert.doesNotMatch(earlyHtml, /Playoff cutoff/);
});
