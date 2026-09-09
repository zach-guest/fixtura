#!/usr/bin/env node
// Read-only, offline inspection. Does not execute SQL, fetch, or write to D1.
import { readFile } from 'node:fs/promises';
import { normalizeNFLGame, STAT_DEFINITIONS } from '../src/game-stats-normalize.js';
const [file, eventId] = process.argv.slice(2);
if (!file || !/^\d+$/.test(eventId || '') || process.argv.length !== 4) {
  console.error('Usage: node scripts/inspect-game-stats.mjs SUMMARY.json EVENT_ID');
  process.exitCode = 1;
} else {
  try {
    const result = normalizeNFLGame(JSON.parse(await readFile(file, 'utf8')), {
      expectedEventId: eventId, capturedAt: Math.floor(Date.now()/1000),
    });
    const fields = [...new Set(result.stats.map(s => s.category + '.' + s.key))].sort();
    console.log(JSON.stringify({ event: result.event, players: result.players.length,
      statValues: result.stats.length, fields, definitions: STAT_DEFINITIONS,
      warnings: result.warnings }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
