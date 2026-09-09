// LOCAL TEST HARNESS ONLY. Not imported by the production Worker.
import { ingestNFLGame } from '../src/game-stats-store.js';
import migration from '../migrations/0001_nfl_game_stats.sql';
export default { async fetch(request, env) {
  const input = await request.json();
  try {
    if (input.action === 'setup') {
      const statements=migration.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
      await env.DB.batch(statements.map(s=>env.DB.prepare(s)));
      await env.DB.batch(['DELETE FROM nfl_player_game_stats','DELETE FROM nfl_player_games','DELETE FROM nfl_stat_games'].map(s=>env.DB.prepare(s)));
      return Response.json({ok:true});
    }
    if (input.action === 'inspect') {
      const games=await env.DB.prepare('SELECT * FROM nfl_stat_games ORDER BY event_id').all();
      const players=await env.DB.prepare('SELECT * FROM nfl_player_games ORDER BY event_id, athlete_id').all();
      const stats=await env.DB.prepare('SELECT * FROM nfl_player_game_stats ORDER BY event_id, athlete_id, category, stat_key').all();
      return Response.json({games:games.results,players:players.results,stats:stats.results});
    }
    if (input.action === 'fail-next') {
      // Force a late batch failure after deletes: prove D1 rolls back the batch.
      await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS reject_stat BEFORE INSERT ON nfl_player_game_stats
        WHEN NEW.value = 123456789 BEGIN SELECT RAISE(ABORT, 'test rollback'); END`).run();
      return Response.json({ok:true});
    }
    return Response.json(await ingestNFLGame(env.DB,input.summary,input.options));
  } catch(e) { return Response.json({error:e.message},{status:400}); }
}};
