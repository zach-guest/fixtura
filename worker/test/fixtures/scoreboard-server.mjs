#!/usr/bin/env node
/**
 * Deterministic ESPN-shaped scoreboard fixtures for the Pick'em integration
 * tests.
 *
 * Why this exists: the Pick'em suite asserts exact lock states ("none locked
 * yet", "every game reads as locked"). Reading those from the live ESPN
 * scoreboard made them a function of the calendar — they passed only while the
 * chosen week had no started games, and began failing the moment NFL Week 1
 * 2026 kicked off. Picking a different "future" week only moves the expiry
 * date. Fixtures remove the date dependency entirely.
 *
 * Shapes match the fields `weekGames()` in src/pools.js actually reads:
 * competitions[0].competitors[].team{id,displayName,abbreviation,logo},
 * score, winner, status.type.state, neutralSite, odds[0], event.date/id,
 * and week.number.
 *
 *   node test/fixtures/scoreboard-server.mjs [port]
 *
 * Serves /<sport>/<league>/scoreboard?dates=SEASON&seasontype=2&week=N
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8788);

// Stable, obviously-synthetic ids and abbreviations. Nothing here should be
// mistaken for a real game result: ids are 9-prefixed and teams are FX**.
const TEAMS = Array.from({ length: 32 }, (_, i) => ({
  id: String(900000 + i),
  displayName: `Fixture Team ${i + 1}`,
  abbreviation: `FX${String(i + 1).padStart(2, '0')}`,
  logo: `https://example.invalid/logo/${i + 1}.png`,
}));

/** Far-future kickoffs so "unstarted" never expires. */
const FUTURE_START = Date.UTC(2099, 8, 13, 17, 0, 0);
const PAST_START = Date.UTC(2020, 8, 13, 17, 0, 0);

function game(season, week, index, { final }) {
  const home = TEAMS[(index * 2) % TEAMS.length];
  const away = TEAMS[(index * 2 + 1) % TEAMS.length];
  const base = final ? PAST_START : FUTURE_START;
  const date = new Date(base + index * 3 * 3600 * 1000 + week * 7 * 24 * 3600 * 1000);
  // Deterministic winner: the home team wins every even game, away every odd.
  const homeWins = index % 2 === 0;
  return {
    id: `9${season}${String(week).padStart(2, '0')}${String(index).padStart(2, '0')}`,
    date: date.toISOString(),
    competitions: [{
      // Exactly one neutral-site game per week, so the "a neutral-site game is
      // flagged" assertion has something deterministic to find.
      neutralSite: index === 3,
      status: { type: { state: final ? 'post' : 'pre', completed: final } },
      competitors: [
        { homeAway: 'home', team: home, score: final ? (homeWins ? '24' : '17') : undefined, winner: final ? homeWins : false },
        { homeAway: 'away', team: away, score: final ? (homeWins ? '17' : '24') : undefined, winner: final ? !homeWins : false },
      ],
      // Odds on most games but not all, matching how ESPN actually behaves.
      odds: index % 4 === 3 ? [] : [{ details: `${home.abbreviation} -3.5`, overUnder: 44.5 }],
    }],
  };
}

function scoreboard(season, week) {
  // Any season strictly before 2090 is treated as played out; the far-future
  // sentinel seasons are unplayed. The Pick'em suite uses 2025 for "finished"
  // and 2026 for "upcoming", and both stay correct forever under this rule
  // because the fixture, not the calendar, decides.
  const final = season < 2090 && season !== 2026;
  return {
    season: { year: season, type: 2 },
    week: { number: week },
    events: Array.from({ length: 16 }, (_, i) => game(season, week, i, { final })),
  };
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!url.pathname.endsWith('/scoreboard')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture server serves /scoreboard only', path: url.pathname }));
    return;
  }
  const season = Number(url.searchParams.get('dates') || 2026);
  const week = Number(url.searchParams.get('week') || 1);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(scoreboard(season, week)));
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`scoreboard fixtures on http://127.0.0.1:${PORT}\n`);
});
