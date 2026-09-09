import test from 'node:test';
import assert from 'node:assert/strict';

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
