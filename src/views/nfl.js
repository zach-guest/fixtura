import { S } from '../state.js';
import { openPlayer } from '../components/modal.js';
import { leaderSectionHTML, openLeaderDetail, standingsSectionHTML, wireLeaderSection, wireStandingsSection } from '../components/dashboard.js';
import { fetchNFLLeaderGroup, fetchNFLStandings, resolveNFLSeason } from '../nfl.js';
import { $, esc } from '../util.js';

let leaderRequest = 0;
let standingsRequest = 0;
const standingsBySeason = new Map();

function dashboardRoot() { return $('#nflDashboardLeaders'); }
function isCurrent(request) {
  return request === leaderRequest && S.view === 'nfl' && S.nflTab === 'overview' && !!dashboardRoot();
}

function seasonLabel() {
  return S.nflLeadersSeason ? `Season ${S.nflLeadersSeason}` : 'Current season';
}

function drawLeaders({ categories = [], loading = false, error = null } = {}) {
  const root = dashboardRoot();
  if (!root || S.view !== 'nfl' || S.nflTab !== 'overview') return;
  root.innerHTML = leaderSectionHTML({
    scope: 'league', label: 'League leaders', season: S.nflLeadersSeason || '', expanded: S.nflLeadersExpanded,
    filter: S.nflLeadersFilter, categories, loading, error,
  });
  wireLeaderSection(root, {
    onToggle: () => {
      S.nflLeadersExpanded = !S.nflLeadersExpanded;
      if (S.nflLeadersExpanded) loadNFLDashboard();
      else { leaderRequest++; drawLeaders(); }
    },
    onFilter: filter => { S.nflLeadersFilter = filter; loadNFLDashboard(); },
    onDetail: definitionId => openLeaderDetail({
      scope: 'league', label: 'NFL Dashboard', season: S.nflLeadersSeason,
      definitionId, onPlayer: id => openPlayer(id, 'football/nfl'),
    }),
    onPlayer: id => openPlayer(id, 'football/nfl'),
  });
}

function renderOverview() {
  return `<div class="dash-overview"><div id="nflDashboardLeaders"></div></div>`;
}

function renderComingSoon(tab) {
  return `<div class="dash-placeholder"><h2>${esc(tab)}</h2><p>Coming next</p></div>`;
}

function selectedStandingsSeason() { return S.nflStandingsSeason || S.nflLeadersSeason; }

function drawStandings({ data = standingsBySeason.get(selectedStandingsSeason()), loading = false, error = null } = {}) {
  const root = $('#nflStandings');
  if (!root || S.view !== 'nfl' || S.nflTab !== 'standings') return;
  root.innerHTML = standingsSectionHTML({ data, conference: S.nflStandingsConference,
    view: S.nflStandingsView, seasons: S.nflLeadersSeason ? [S.nflLeadersSeason, S.nflLeadersSeason - 1] : [],
    selectedSeason: selectedStandingsSeason(), loading, error });
  wireStandingsSection(root, {
    onConference: conference => { S.nflStandingsConference = conference; drawStandings(); },
    onView: view => { S.nflStandingsView = view; drawStandings(); },
    onSeason: season => { S.nflStandingsSeason = season; loadStandings(); },
  });
}

async function loadStandings() {
  const request = ++standingsRequest;
  const existing = standingsBySeason.get(selectedStandingsSeason());
  drawStandings({ data: existing, loading: !existing });
  try {
    const season = S.nflLeadersSeason || await resolveNFLSeason();
    if (request !== standingsRequest || S.view !== 'nfl' || S.nflTab !== 'standings' || !$('#nflStandings')) return;
    S.nflLeadersSeason = season;
    const label = $('#nflSeasonLabel'); if (label) label.textContent = seasonLabel();
    const standingsSeason = selectedStandingsSeason();
    const data = await fetchNFLStandings({ season: standingsSeason });
    if (request !== standingsRequest || S.view !== 'nfl' || S.nflTab !== 'standings' || !$('#nflStandings')) return;
    standingsBySeason.set(standingsSeason, data);
    drawStandings({ data });
  } catch (error) {
    if (request === standingsRequest) drawStandings({ error });
  }
}

export function renderNFLShell() {
  const tab = ['overview', 'standings', 'news'].includes(S.nflTab) ? S.nflTab : 'overview';
  S.nflTab = tab;
  const tabs = [['overview', 'Overview'], ['standings', 'Standings'], ['news', 'News']]
    .map(([id, label]) => `<button class="dash-tab${tab === id ? ' dash-tab-active' : ''}" type="button" data-dash-nfl-tab="${id}" aria-selected="${tab === id}">${label}</button>`).join('');
  const body = tab === 'overview' ? renderOverview() : tab === 'standings' ? '<div id="nflStandings"></div>' : renderComingSoon('News');
  $('#main').innerHTML = `<section class="dash-nfl"><header class="dash-nfl-head"><h1>NFL Dashboard</h1><p id="nflSeasonLabel">${esc(seasonLabel())}</p></header><div class="dash-tabs" role="tablist" aria-label="NFL dashboard">${tabs}</div>${body}</section>`;
  document.querySelectorAll('[data-dash-nfl-tab]').forEach(button => button.addEventListener('click', event => {
    S.nflTab = event.currentTarget.dataset.dashNflTab;
    leaderRequest++;
    renderNFLShell();
    loadNFLDashboard();
    event.currentTarget.focus();
  }));
  if (tab === 'overview') drawLeaders();
  else if (tab === 'standings') drawStandings();
}

export async function loadNFLDashboard() {
  if (S.view !== 'nfl') return;
  if (S.nflTab === 'standings') return loadStandings();
  if (S.nflTab !== 'overview') return;
  const request = ++leaderRequest;
  drawLeaders({ loading: S.nflLeadersExpanded });
  try {
    const season = S.nflLeadersSeason || await resolveNFLSeason();
    if (!isCurrent(request)) return;
    S.nflLeadersSeason = season;
    const label = $('#nflSeasonLabel'); if (label) label.textContent = seasonLabel();
    if (!S.nflLeadersExpanded) { drawLeaders(); return; }
    const categories = await fetchNFLLeaderGroup({ season, scope: 'league', group: S.nflLeadersFilter });
    if (!isCurrent(request)) return;
    drawLeaders({ categories });
  } catch (error) {
    if (isCurrent(request)) drawLeaders({ error });
  }
}
