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
