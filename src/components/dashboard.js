import { esc } from '../util.js';
import { fetchNFLLeaderDetail, formatNFLLeaderValue, nflLeaderDefinition } from '../nfl.js';

const dashText = value => esc(value == null ? '' : value);
const filters = ['Offense', 'Defense', 'All'];
const coverageText = coverage => {
  if (!coverage) return 'Coverage unavailable';
  const seen = coverage.discovered_final_games;
  const captured = coverage.captured_games;
  return seen == null ? 'Discovered finals coverage' : `${captured ?? 0} of ${seen} discovered finals captured`;
};

export function leaderRowHTML(row, definition, scope) {
  const team = row.team;
  const teamMark = scope === 'league' && team ? `<span class="dash-team"><img class="dash-team-logo" src="${dashText(team.logo)}" alt="" data-dash-img="team"><span>${dashText(team.abbreviation)}</span></span>` : '';
  const portrait = row.headshot ? `<img class="dash-headshot" src="${dashText(row.headshot)}" alt="" data-dash-img="headshot">` : '<span class="dash-headshot" aria-hidden="true"></span>';
  return `<button class="dash-player" type="button" data-dash-player="${dashText(row.athlete_id)}"><span class="dash-rank">${dashText(row.rank)}</span>${portrait}<span class="dash-player-copy"><span class="dash-player-name">${dashText(row.name || 'Unknown player')}</span><span class="dash-player-meta">${dashText(row.position || '')}${teamMark}</span></span><span class="dash-value">${dashText(formatNFLLeaderValue(row.value, definition))}</span></button>`;
}

function leaderCardHTML(entry, scope) {
  const { definition, data, error } = entry;
  const rows = data?.rows || [];
  const body = error ? '<p class="dash-state dash-error">Leaderboard unavailable</p>' : rows.length ? rows.slice(0, 3).map(row => leaderRowHTML(row, definition, scope)).join('') : '<p class="dash-state">No captured leaders yet</p>';
  return `<article class="dash-card"><button class="dash-card-title" type="button" data-dash-detail="${dashText(definition.id)}">${dashText(definition.label)}</button><div class="dash-card-rows">${body}</div><button class="dash-card-footer" type="button" data-dash-detail="${dashText(definition.id)}">${dashText(coverageText(data?.coverage))}</button></article>`;
}

export function leaderSectionHTML({ scope = 'league', label = 'NFL leaders', season, expanded = false, filter = 'Offense', categories = [], loading = false, error = null }) {
  const current = filters.includes(filter) ? filter : 'Offense';
  const controls = filters.map(name => `<button class="dash-filter${name === current ? ' dash-filter-active' : ''}" type="button" data-dash-filter="${name}" aria-pressed="${name === current}">${name}</button>`).join('');
  const content = !expanded ? '' : loading ? '<p class="dash-state">Loading leaders</p>' : error ? `<p class="dash-state dash-error">${dashText(error.message || error)}</p>` : `<div class="dash-cards">${categories.map(entry => leaderCardHTML(entry, scope)).join('') || '<p class="dash-state">No leader categories available</p>'}</div>`;
  return `<section class="dash-leaders" data-dash-section="leaders"><div class="dash-heading"><button class="dash-toggle" type="button" data-dash-toggle aria-expanded="${expanded}"><span>${dashText(label)}</span><span class="dash-season">${dashText(season || '')}</span><span aria-hidden="true">${expanded ? '−' : '+'}</span></button></div>${expanded ? `<div class="dash-controls" role="group" aria-label="Leaderboard category">${controls}</div>` : ''}${content}</section>`;
}

export function wireLeaderSection(root, { onToggle, onFilter, onDetail, onPlayer } = {}) {
  if (!root) return;
  root.querySelector('[data-dash-toggle]')?.addEventListener('click', event => { onToggle?.(); event.currentTarget.focus(); });
  root.querySelectorAll('[data-dash-filter]').forEach(button => button.addEventListener('click', event => { onFilter?.(event.currentTarget.dataset.dashFilter); event.currentTarget.focus(); }));
  root.querySelectorAll('[data-dash-detail]').forEach(button => button.addEventListener('click', event => onDetail?.(event.currentTarget.dataset.dashDetail)));
  root.querySelectorAll('[data-dash-player]').forEach(button => button.addEventListener('click', event => onPlayer?.(event.currentTarget.dataset.dashPlayer)));
  root.querySelectorAll('[data-dash-img]').forEach(image => image.addEventListener('error', () => { image.hidden = true; }));
}

function detailRowsHTML(data, definition, scope) {
  const rows = data?.rows || [];
  if (!rows.length) return '<p class="dash-state">No qualified leaders in captured games</p>';
  return rows.map(row => {
    const rate = data.rate ? `<p class="dash-rate-row">${dashText(row.numerator)} / ${dashText(row.denominator)} · ${row.qualified ? 'Qualified' : 'Not qualified'}${row.required_minimum != null ? ` · Minimum ${dashText(row.required_minimum)}` : ''}</p>` : '';
    return leaderRowHTML(row, definition, scope) + rate;
  }).join('');
}
function detailCoverageHTML(data) {
  const coverage = data?.coverage;
  const scope = coverage?.scope ? `<p class="dash-coverage-note">${dashText(coverage.scope)}</p>` : '';
  return `<p class="dash-coverage">${dashText(coverageText(coverage))}</p>${scope}`;
}
function rateDetailHTML(data) {
  if (!data?.rate) return '';
  const row = data.rows?.[0];
  const qualification = data.rate.qualification_source === 'none_published' ? 'No official qualification minimum published' : data.rate.qualification_source;
  return `<p class="dash-rate">${dashText(data.rate.formula)}${row ? ` · ${dashText(row.numerator)} / ${dashText(row.denominator)} · ${row.qualified ? 'Qualified' : 'Not qualified'}${row.required_minimum != null ? ` at ${dashText(row.required_minimum)}` : ''}` : ''}</p><p class="dash-rate">${dashText(qualification)}</p>`;
}

export async function openLeaderDetail({ scope = 'league', label = 'NFL leaders', season, teamId, definitionId, onePerTeam = false, onPlayer, onClose } = {}) {
  const definition = nflLeaderDefinition(definitionId);
  if (!definition) throw new Error('Unknown NFL leader category');
  const backdrop = document.querySelector('#backdrop');
  const inner = document.querySelector('#modalInner');
  if (!backdrop || !inner) throw new Error('Leader detail modal is unavailable');
  const token = String(Date.now()) + Math.random();
  let generation = 0;
  const active = requestGeneration => backdrop.classList.contains('open') && inner.dataset.dashRequest === token && requestGeneration === generation;
  const close = () => { if (!active(generation)) return; delete inner.dataset.dashRequest; backdrop.classList.remove('open'); document.body.style.overflow = ''; onClose?.(); };
  const renderLoading = () => { inner.dataset.dashRequest = token; inner.innerHTML = `<div class="dash-modal"><div class="dash-modal-head"><button class="dash-close" type="button" data-dash-close aria-label="Close">×</button><h2>${dashText(definition.label)}</h2><p>${dashText(label)} ${dashText(season)}</p></div><p class="dash-state">Loading leaders</p></div>`; inner.querySelector('[data-dash-close]')?.addEventListener('click', close); backdrop.classList.add('open'); document.body.style.overflow = 'hidden'; };
  const render = async selectedOnePerTeam => {
    const requestGeneration = ++generation;
    renderLoading();
    try {
      const data = await fetchNFLLeaderDetail({ season, definition, scope, teamId, onePerTeam: selectedOnePerTeam });
      if (!active(requestGeneration)) return;
      const check = scope === 'league' ? `<label class="dash-checkbox"><input type="checkbox" data-dash-one-team ${selectedOnePerTeam ? 'checked' : ''}>One player per team</label>` : '';
      inner.innerHTML = `<div class="dash-modal"><div class="dash-modal-head"><button class="dash-close" type="button" data-dash-close aria-label="Close">×</button><h2>${dashText(definition.label)}</h2><p>${dashText(label)} ${dashText(season)}</p>${check}</div>${detailCoverageHTML(data)}${rateDetailHTML(data)}<div class="dash-detail-rows">${detailRowsHTML(data, definition, scope)}</div></div>`;
      inner.querySelector('[data-dash-close]')?.addEventListener('click', close);
      inner.querySelector('[data-dash-one-team]')?.addEventListener('change', event => render(event.currentTarget.checked));
      wireLeaderSection(inner, { onPlayer });
    } catch (error) {
      if (!active(requestGeneration)) return;
      inner.innerHTML = `<div class="dash-modal"><div class="dash-modal-head"><button class="dash-close" type="button" data-dash-close aria-label="Close">×</button><h2>${dashText(definition.label)}</h2></div><p class="dash-state dash-error">${dashText(error.message || 'Leaderboard unavailable')}</p></div>`;
      inner.querySelector('[data-dash-close]')?.addEventListener('click', close);
    }
  };
  await render(onePerTeam);
}

function standingTeamHTML(entry, showSeed) {
  const logo = entry.team.logo ? `<img src="${dashText(entry.team.logo)}" alt="" data-dash-img="team">` : '';
  return `<tr><td class="dash-standing-team">${showSeed ? `<b class="dash-standing-seed">${dashText(entry.playoffSeed)}</b>` : '<b class="dash-standing-seed">—</b>'}${logo}<span><strong>${dashText(entry.team.shortDisplayName)}</strong><small>${dashText(entry.division)}</small></span></td><td>${dashText(entry.wins || '0')}</td><td>${dashText(entry.losses || '0')}</td><td>${dashText(entry.ties || '0')}</td><td>${dashText(entry.pct || '—')}</td><td>${dashText(entry.conferenceRecord || '—')}</td><td>${dashText(entry.differential || '—')}</td></tr>`;
}

function conferenceStandingsHTML(conference) {
  const official = conference.officialSeeds;
  const rows = conference.entries.map((entry, index) => {
    const label = official && index === 4 ? '<tr class="dash-cut-label"><td colspan="7">Wild-card qualifiers</td></tr>' :
      official && index === 7 ? '<tr class="dash-cut-label dash-cutoff"><td colspan="7">Playoff cutoff · outside the field below</td></tr>' : '';
    return label + standingTeamHTML(entry, official);
  }).join('');
  const note = official ? 'Seeds 1–4 are division leaders and 5–7 are wild cards using ESPN’s published playoff order' : 'ESPN has not published playoff seeds yet. Teams are sorted by record; the official playoff cutoff will appear when seed data is available';
  return `<div class="dash-standing-scroll"><table class="dash-standing-table"><thead><tr><th>Seed / Team</th><th>W</th><th>L</th><th>T</th><th>PCT</th><th>CONF</th><th>DIFF</th></tr></thead><tbody>${rows}</tbody></table></div><p class="dash-standing-note">${dashText(note)}</p>`;
}

function divisionStandingsHTML(conference) {
  return `<div class="dash-division-grid">${conference.divisions.map(division => `<section class="dash-division"><h2>${dashText(division.name)}</h2><div class="dash-standing-scroll"><table class="dash-standing-table dash-standing-division"><thead><tr><th>Team</th><th>W</th><th>L</th><th>T</th><th>PCT</th></tr></thead><tbody>${division.entries.map(entry => `<tr><td class="dash-standing-team">${entry.team.logo ? `<img src="${dashText(entry.team.logo)}" alt="" data-dash-img="team">` : ''}<span><strong>${dashText(entry.team.shortDisplayName)}</strong></span></td><td>${dashText(entry.wins || '0')}</td><td>${dashText(entry.losses || '0')}</td><td>${dashText(entry.ties || '0')}</td><td>${dashText(entry.pct || '—')}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}</div>`;
}

export function standingsSectionHTML({ data, conference = 'AFC', view = 'conference', seasons = [], selectedSeason, loading = false, error = null } = {}) {
  if (loading) return '<div class="dash-standing-state">Loading standings</div>';
  if (error) return `<div class="dash-standing-state dash-error">${dashText(error.message || error)}</div>`;
  const selected = data?.conferences?.find(item => item.abbreviation === conference) || data?.conferences?.[0];
  if (!selected) return '<div class="dash-standing-state">Standings are not published yet</div>';
  const conferenceButtons = data.conferences.map(item => `<button type="button" class="dash-filter${item.abbreviation === selected.abbreviation ? ' dash-filter-active' : ''}" data-dash-conference="${dashText(item.abbreviation)}" aria-pressed="${item.abbreviation === selected.abbreviation}">${dashText(item.abbreviation)}</button>`).join('');
  const viewButtons = ['conference', 'division'].map(id => `<button type="button" class="dash-filter${view === id ? ' dash-filter-active' : ''}" data-dash-standings-view="${id}" aria-pressed="${view === id}">${id === 'conference' ? 'Conference' : 'Division'}</button>`).join('');
  const seasonButtons = seasons.map((year, index) => `<button type="button" class="dash-filter${year === selectedSeason ? ' dash-filter-active' : ''}" data-dash-standing-season="${dashText(year)}" aria-pressed="${year === selectedSeason}">${dashText(year)}${index === 0 ? ' current' : ' final'}</button>`).join('');
  return `<section class="dash-standings"><div class="dash-standing-title"><div><span>Playoff picture</span><h2>${dashText(selected.name)}</h2></div><b>${dashText(data.season)}</b></div><div class="dash-standing-controls">${seasonButtons ? `<div role="group" aria-label="Season">${seasonButtons}</div>` : ''}<div role="group" aria-label="Conference">${conferenceButtons}</div><div role="group" aria-label="Standings view">${viewButtons}</div></div>${view === 'division' ? divisionStandingsHTML(selected) : conferenceStandingsHTML(selected)}</section>`;
}

export function wireStandingsSection(root, { onConference, onView, onSeason } = {}) {
  if (!root) return;
  root.querySelectorAll('[data-dash-conference]').forEach(button => button.addEventListener('click', event => onConference?.(event.currentTarget.dataset.dashConference)));
  root.querySelectorAll('[data-dash-standings-view]').forEach(button => button.addEventListener('click', event => onView?.(event.currentTarget.dataset.dashStandingsView)));
  root.querySelectorAll('[data-dash-standing-season]').forEach(button => button.addEventListener('click', event => onSeason?.(Number(event.currentTarget.dataset.dashStandingSeason))));
  root.querySelectorAll('[data-dash-img]').forEach(image => image.addEventListener('error', () => { image.hidden = true; }));
}

function newsTimeAgo(iso) {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'Just now' : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1d ago' : `${days}d ago`;
}

function newsCardHTML(article) {
  const teamTags = article.teams.slice(0, 2).map(team => `<span class="dash-news-team">${team.logo ? `<img src="${dashText(team.logo)}" alt="" data-dash-img="team">` : ''}${dashText(team.abbreviation || team.name)}</span>`).join('');
  return `<a class="dash-news-card" href="${dashText(article.link)}" target="_blank" rel="noopener noreferrer">` +
    (article.image ? `<img class="dash-news-image" src="${dashText(article.image)}" alt="" loading="lazy" data-dash-img="news">` : '') +
    `<div class="dash-news-body">` +
    `<h3 class="dash-news-headline">${dashText(article.headline)}</h3>` +
    (article.description ? `<p class="dash-news-desc">${dashText(article.description)}</p>` : '') +
    `<div class="dash-news-meta">${teamTags}<span class="dash-news-time">${dashText(newsTimeAgo(article.published))}</span></div>` +
    `</div></a>`;
}

export function newsSectionHTML({ articles = null, loading = false, error = null, emptyText = 'No news available right now.' } = {}) {
  if (error && !articles) return `<div class="dash-standings"><div class="dash-standing-state dash-error">Couldn't load news (${dashText(error.message || error)}).</div></div>`;
  if (loading && !articles) return '<div class="dash-standings"><div class="dash-standing-state">Loading news…</div></div>';
  if (!articles || !articles.length) return `<div class="dash-standings"><div class="dash-standing-state">${dashText(emptyText)}</div></div>`;
  return `<div class="dash-news-list">${articles.map(newsCardHTML).join('')}</div>`;
}

export function wireNewsSection(root) {
  if (!root) return;
  root.querySelectorAll('[data-dash-img]').forEach(image => image.addEventListener('error', () => image.remove()));
}
