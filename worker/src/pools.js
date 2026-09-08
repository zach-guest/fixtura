/**
 * The PRIVATE lane: pick'em.
 *
 * A pool is a group of people picking games together. Everything here is
 * per-user and per-pool, so every response is `priv()` and every route starts
 * with `requireUser()`.
 *
 * Two rules carry this whole feature, and both are enforced here rather than in
 * the UI, because a rule enforced in the UI is not a rule:
 *
 *   1. KICKOFF TIMES COME FROM ESPN, NEVER FROM THE CLIENT. `picks.locks_at`
 *      exists so a late pick can be rejected without a network call — but if the
 *      client supplied it, anyone could send a far-future value and pick after
 *      the game started. The scoreboard is the authority; see `weekGames()`.
 *   2. A PICK IS INVISIBLE UNTIL ITS GAME STARTS. Other people's picks for
 *      unlocked games are omitted from the JSON entirely, not hidden at render
 *      time — anything sent to the browser can be read in devtools.
 *
 * Three modes are implemented: `su` (straight up), `confidence`, and
 * `survivor`. `pools.mode` is fixed at creation and never changes, so the
 * remaining modes in the schema (`ats`, `golf6`, `f1podium`) are additive
 * later: a new mode is a new pool, never a reinterpretation of existing picks.
 */

import { priv, bad, forbidden, notFound, ApiError } from './http.js';
import { requireUser } from './auth.js';
import { getJSON } from './proxy.js';

const now = () => Math.floor(Date.now() / 1000);

const MAX_WEEK = 22;              // 18 regular season + playoffs, generous
const MAX_PICKS_PER_REQUEST = 32; // a week is 16 games; leave room without being unbounded
const NAME_MAX = 60;
const SCOREBOARD_TTL = 30;        // seconds; matches the proxy lane's scores TTL

/* Leagues a pool can be run on. The value is ESPN's path, so adding one is a
   line here rather than a code change. */
const POOL_LEAGUES = {
  nfl: 'football/nfl',
  ncaaf: 'football/college-football',
};

/* Modes a pool can be CREATED with. `ats`/`golf6`/`f1podium` stay out of this
   set — accepting one at creation would make a pool nothing can ever score. */
const VALID_MODES = new Set(['su', 'confidence', 'survivor']);

/* Join codes are read aloud and typed by hand, so the alphabet leaves out the
   characters people confuse: O/0, I/1, S/5. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
function joinCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map(n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

/* ------------------------------------------------------------------ router */

export async function handlePools(request, segments, env, ctx, origin) {
  const user = await requireUser(request, env);
  const m = request.method;
  const rest = segments.slice(1);            // segments[0] === 'pools'

  if (rest.length === 0 && m === 'GET')  return listPools(env, user, origin);
  if (rest.length === 0 && m === 'POST') return createPool(request, env, user, origin);
  if (rest[0] === 'join' && m === 'POST') return joinPool(request, env, user, origin);

  const id = Number(rest[0]);
  if (!Number.isInteger(id) || id <= 0) throw notFound('unknown pools route');

  if (rest.length === 1 && m === 'GET')   return poolDetail(env, user, id, origin);
  if (rest.length === 1 && m === 'PATCH') return renamePool(request, env, user, id, origin);
  if (rest[1] === 'week' && rest.length === 3 && m === 'GET')
    return weekView(env, ctx, user, id, rest[2], origin);
  if (rest[1] === 'picks' && rest.length === 2 && m === 'PUT')
    return submitPicks(request, env, ctx, user, id, origin);
  if (rest[1] === 'standings' && rest.length === 2 && m === 'GET')
    return standings(env, ctx, user, id, origin);

  throw notFound('unknown pools route');
}

/* ----------------------------------------------------------------- helpers */

/** The pool, plus a hard check that this user is in it. Membership gates everything. */
async function memberPool(env, user, poolId) {
  const pool = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM pool_members WHERE pool_id = p.id AND user_id = ?) AS mine
       FROM pools p WHERE p.id = ?`
  ).bind(user.id, poolId).first();
  if (!pool) throw notFound('no such pool');
  if (!pool.mine) throw forbidden('you are not in that pool');
  return pool;
}

function cleanName(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) throw bad('a pool needs a name');
  if (s.length > NAME_MAX) throw bad(`pool name is too long (max ${NAME_MAX})`);
  // Control characters would be invisible in a leaderboard other people read.
  if (/[\x00-\x1f\x7f]/.test(s)) throw bad('pool name contains control characters');
  return s;
}

async function body(request) {
  try { return await request.json(); }
  catch { throw bad('body must be JSON'); }
}

/**
 * The week's games, straight from ESPN — the only source of truth for what is
 * playable, who is playing, when it starts, and who won.
 *
 * `week` may be the string 'current', in which case ESPN's own idea of the
 * current week is used. That keeps "what week is it" out of this codebase,
 * where it would rot every September.
 */
async function weekGames(ctx, pool, week) {
  const path = POOL_LEAGUES[pool.league];
  if (!path) throw new ApiError(500, 'pool is on a league this worker cannot read', { league: pool.league });

  const qs = new URLSearchParams({ dates: String(pool.season), seasontype: '2' });
  if (week !== 'current') qs.set('week', String(week));
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?${qs}`;

  const data = await getJSON(url, SCOREBOARD_TTL, ctx);
  const n = (data.week && data.week.number) || (week === 'current' ? 0 : Number(week));
  const t = now();

  const games = (data.events || []).map(e => {
    const c = (e.competitions && e.competitions[0]) || {};
    const cs = c.competitors || [];
    const side = h => {
      const x = cs.find(y => y.homeAway === h) || {};
      const team = x.team || {};
      return {
        id: String(team.id || ''),
        name: team.displayName || team.name || '',
        abbrev: team.abbreviation || '',
        logo: team.logo || '',
        score: x.score === undefined ? null : Number(x.score),
        winner: !!x.winner,
      };
    };
    const home = side('home'), away = side('away');
    const state = (c.status && c.status.type && c.status.type.state) || 'pre';
    const kickoff = Math.floor(new Date(e.date).getTime() / 1000);
    const winner = state === 'post' ? (home.winner ? home.id : away.winner ? away.id : null) : null;
    // A neutral-site game has no real home team, so the UI must not claim one.
    // ESPN says so explicitly; do not infer it from shortName containing "VS".
    const neutral = !!c.neutralSite;
    const o = (c.odds && c.odds[0]) || null;
    return {
      id: String(e.id),
      shortName: e.shortName || '',
      date: e.date,
      kickoff,
      neutral,
      // Passed through for display only. Nothing here is used for scoring — a
      // straight-up pool is decided by who won, and the line is just context.
      odds: o ? { details: o.details || '', overUnder: o.overUnder === undefined ? null : o.overUnder } : null,
      // A game is locked once it starts. ESPN's own state is checked too, because
      // a game can start early or a clock can be wrong, and the state is the fact.
      locked: state !== 'pre' || kickoff <= t,
      final: state === 'post',
      state,
      home, away,
      winner_id: winner,
    };
  });

  return { week: n, games };
}

/* ------------------------------------------------------------------- pools */

async function listPools(env, user, origin) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.league, p.season, p.mode, p.join_code, p.owner_id, p.created_at,
            (SELECT COUNT(*) FROM pool_members WHERE pool_id = p.id) AS members
       FROM pools p
       JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = ?
      ORDER BY p.created_at DESC`
  ).bind(user.id).all();
  return priv({ pools: results }, { origin });
}

async function createPool(request, env, user, origin) {
  const b = await body(request);
  const name = cleanName(b.name);
  const league = String(b.league || 'nfl');
  if (!POOL_LEAGUES[league]) throw bad(`league must be one of: ${Object.keys(POOL_LEAGUES).join(', ')}`);

  const season = Number(b.season) || new Date().getUTCFullYear();
  if (season < 2000 || season > 2100) throw bad('season looks wrong');

  // Mode is deliberately immutable once a pool exists — see the class comment.
  const mode = String(b.mode || 'su');
  if (!VALID_MODES.has(mode)) throw bad(`mode must be one of: ${[...VALID_MODES].join(', ')}`);

  const t = now();
  // A collision is vanishingly unlikely (30^6) but the column is UNIQUE, so retry
  // rather than hand the user a 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = joinCode();
    try {
      const pool = await env.DB.prepare(
        `INSERT INTO pools (name, league, season, mode, owner_id, join_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, name, league, season, mode, owner_id, join_code, created_at`
      ).bind(name, league, season, mode, user.id, code, t).first();
      await env.DB.prepare(
        'INSERT INTO pool_members (pool_id, user_id, joined_at) VALUES (?, ?, ?)'
      ).bind(pool.id, user.id, t).run();
      return priv({ pool }, { status: 201, origin });
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err;
    }
  }
  throw new ApiError(500, 'could not allocate a join code');
}

async function joinPool(request, env, user, origin) {
  const b = await body(request);
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) throw bad('a join code is required');

  const pool = await env.DB.prepare('SELECT * FROM pools WHERE join_code = ?').bind(code).first();
  if (!pool) throw notFound('no pool with that code');

  // Joining twice is not an error — someone will paste the link again.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO pool_members (pool_id, user_id, joined_at) VALUES (?, ?, ?)'
  ).bind(pool.id, user.id, now()).run();

  return priv({ pool: { id: pool.id, name: pool.name, league: pool.league, season: pool.season, mode: pool.mode } }, { origin });
}

async function poolDetail(env, user, poolId, origin) {
  const pool = await memberPool(env, user, poolId);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.picture, pm.joined_at, (u.id = ?) AS is_owner
       FROM pool_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.pool_id = ? ORDER BY pm.joined_at`
  ).bind(pool.owner_id, poolId).all();
  return priv({
    pool: {
      id: pool.id, name: pool.name, league: pool.league, season: pool.season,
      mode: pool.mode, owner_id: pool.owner_id, join_code: pool.join_code, created_at: pool.created_at,
    },
    members: results,
  }, { origin });
}

/**
 * Rename a pool. The name is the only thing about a pool that is safe to change:
 * league, season and mode would all reinterpret picks that already exist, which
 * is why they are absent here rather than merely undocumented.
 *
 * Owner only. Everyone in the pool sees this name, so it is not a per-member
 * preference and it is not something a member should be able to change under
 * everyone else.
 */
async function renamePool(request, env, user, poolId, origin) {
  const pool = await memberPool(env, user, poolId);
  if (pool.owner_id !== user.id) throw forbidden('only the person who made the pool can rename it');

  const b = await body(request);
  const name = cleanName(b.name);
  await env.DB.prepare('UPDATE pools SET name = ? WHERE id = ?').bind(name, poolId).run();
  return priv({ pool: { id: pool.id, name } }, { origin });
}

/* ------------------------------------------------------------------- picks */

async function weekView(env, ctx, user, poolId, weekArg, origin) {
  const pool = await memberPool(env, user, poolId);
  const week = weekArg === 'current' ? 'current' : Number(weekArg);
  if (week !== 'current' && (!Number.isInteger(week) || week < 1 || week > MAX_WEEK)) throw bad('bad week');

  const { week: weekNo, games } = await weekGames(ctx, pool, week);
  const locked = new Set(games.filter(g => g.locked).map(g => g.id));

  const { results } = await env.DB.prepare(
    `SELECT p.user_id, p.event_id, p.selection_id, p.confidence, u.name
       FROM picks p JOIN users u ON u.id = p.user_id
      WHERE p.pool_id = ? AND p.week = ?`
  ).bind(poolId, weekNo).all();

  const mine = {}, others = {}, myConfidence = {};
  for (const r of results) {
    if (r.user_id === user.id) {
      mine[r.event_id] = r.selection_id;
      if (r.confidence != null) myConfidence[r.event_id] = r.confidence;
      continue;
    }
    // THE RULE: another person's pick does not exist until their game has started.
    // Filtered here, in the query result, so it never reaches the network.
    if (!locked.has(r.event_id)) continue;
    (others[r.user_id] = others[r.user_id] || {})[r.event_id] = r.selection_id;
  }

  const { results: members } = await env.DB.prepare(
    `SELECT u.id, u.name FROM pool_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.pool_id = ? ORDER BY u.name`
  ).bind(poolId).all();

  // Survivor needs two things a plain pick list doesn't carry: which teams this
  // user has already burned this season, and whether a prior loss already ended
  // their run — both computed fresh, never trusted from anything the client sent.
  let survivor = null;
  if (pool.mode === 'survivor') {
    const { results: used } = await env.DB.prepare(
      'SELECT selection_id FROM picks WHERE pool_id = ? AND user_id = ? AND week <> ?'
    ).bind(pool.id, user.id, weekNo).all();
    survivor = {
      usedTeams: used.map(r => r.selection_id),
      eliminated: await survivorEliminated(env, ctx, pool, user.id, weekNo),
    };
  }

  return priv({
    pool: { id: pool.id, name: pool.name, league: pool.league, season: pool.season, mode: pool.mode },
    week: weekNo, games, members,
    myPicks: mine,
    myConfidence,
    survivor,
    picks: others,
  }, { origin });
}

async function submitPicks(request, env, ctx, user, poolId, origin) {
  const pool = await memberPool(env, user, poolId);
  const b = await body(request);

  const week = Number(b.week);
  if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) throw bad('bad week');
  if (!Array.isArray(b.picks)) throw bad('expected { week, picks: [ { event_id, selection_id } ] }');
  if (!b.picks.length) throw bad('no picks sent');
  if (b.picks.length > MAX_PICKS_PER_REQUEST) throw bad(`too many picks at once (max ${MAX_PICKS_PER_REQUEST})`);
  if (pool.mode === 'survivor' && b.picks.length > 1) throw bad('a survivor pool takes one pick a week');

  // The authority. Note what is NOT read from the request: kickoff times, which
  // teams are playing, and whether a game has started.
  const { week: weekNo, games } = await weekGames(ctx, pool, week);
  if (weekNo !== week) throw bad('that week is not available for this season', { asked: week, got: weekNo });
  const byId = new Map(games.map(g => [g.id, g]));

  // Confidence: a rank is only valid against the OTHER ranks this user has
  // standing this week. Seed the taken set from existing rows this request
  // isn't touching — a locked pick's rank can't move, and an unlocked one not
  // resubmitted here keeps whatever it already had.
  let takenConfidence = null;
  if (pool.mode === 'confidence') {
    const { results: existing } = await env.DB.prepare(
      'SELECT event_id, confidence FROM picks WHERE pool_id = ? AND user_id = ? AND week = ?'
    ).bind(pool.id, user.id, week).all();
    const submittedIds = new Set(b.picks.map(p => String((p && p.event_id) || '')));
    takenConfidence = new Map();
    for (const r of existing) {
      if (r.confidence == null || submittedIds.has(r.event_id)) continue;
      takenConfidence.set(r.confidence, r.event_id);
    }
  }

  // Survivor: an already-eliminated user gets no picks at all, and a team used
  // in any OTHER week of this pool can't be used again.
  let usedTeams = null;
  if (pool.mode === 'survivor') {
    if (await survivorEliminated(env, ctx, pool, user.id, week)) throw bad('you were eliminated from this survivor pool');

    /* THE WEEK IS SPENT ONCE ITS PICK KICKS OFF. Survivor is one pick a week,
       and that pick lives on a DIFFERENT event from the one being submitted —
       so the per-game `game.locked` check below cannot see it. Without this,
       a Thursday-night pick that is losing could be abandoned on Sunday by
       picking a later game, and the delete-then-insert further down would
       erase the losing pick entirely. Verified as a real escape before this
       guard existed. ESPN's live state is preferred over the stored kickoff,
       for the same reason weekGames() trusts it. */
    const prior = await env.DB.prepare(
      'SELECT event_id, locks_at FROM picks WHERE pool_id = ? AND user_id = ? AND week = ?'
    ).bind(pool.id, user.id, week).first();
    if (prior) {
      /* Locked if EITHER signal says so, deliberately. The delete below is
         guarded on the stored `locks_at`, so trusting only ESPN here let the
         two disagree — and a disagreement left the old row undeleted AND the
         new row inserted, i.e. two picks in a one-pick-a-week pool, which is
         worse than the escape this guard exists to stop. Same reading on both
         sides means the delete can only ever run on a row already accepted
         here as unlocked. A postponed game keeps its pick, which is also right. */
      const priorGame = byId.get(prior.event_id);
      const priorLocked = (priorGame ? priorGame.locked : false) || prior.locks_at <= now();
      if (priorLocked) throw bad('your pick for this week has already kicked off');
    }

    const { results: used } = await env.DB.prepare(
      'SELECT selection_id FROM picks WHERE pool_id = ? AND user_id = ? AND week <> ?'
    ).bind(pool.id, user.id, week).all();
    usedTeams = new Set(used.map(r => r.selection_id));
  }

  const t = now();
  const rows = [], rejected = [];
  const seen = new Set();

  for (const p of b.picks) {
    const eventId = String((p && p.event_id) || '');
    const selection = String((p && p.selection_id) || '');
    const game = byId.get(eventId);

    if (!game)                              { rejected.push({ event_id: eventId, why: 'not a game in this week' }); continue; }
    if (seen.has(eventId))                  { rejected.push({ event_id: eventId, why: 'picked twice in one request' }); continue; }
    if (selection !== game.home.id && selection !== game.away.id) {
      rejected.push({ event_id: eventId, why: 'that team is not in this game' }); continue;
    }
    if (game.locked)                        { rejected.push({ event_id: eventId, why: 'that game has already started' }); continue; }

    let confidence = null;
    if (pool.mode === 'confidence') {
      confidence = Number(p && p.confidence);
      if (!Number.isInteger(confidence) || confidence < 1 || confidence > games.length) {
        rejected.push({ event_id: eventId, why: `confidence must be 1..${games.length}` }); continue;
      }
      if (takenConfidence.has(confidence) && takenConfidence.get(confidence) !== eventId) {
        rejected.push({ event_id: eventId, why: 'that confidence rank is already used this week' }); continue;
      }
      takenConfidence.set(confidence, eventId);
    }

    if (pool.mode === 'survivor' && usedTeams.has(selection)) {
      rejected.push({ event_id: eventId, why: 'you already used that team this season' }); continue;
    }

    seen.add(eventId);
    rows.push({ eventId, selection, kickoff: game.kickoff, confidence });
  }

  if (rows.length) {
    const stmts = [];
    // Survivor is one pick a WEEK, not one pick a game — if the user is
    // switching teams mid-week, drop whatever row they already had for this
    // week before inserting the new one, or both would exist side by side.
    if (pool.mode === 'survivor') {
      // `locks_at > ?` is belt-and-braces behind the "week is spent" check
      // above: even reached by some other path, a pick whose game has started
      // must never be deletable.
      stmts.push(env.DB.prepare(
        'DELETE FROM picks WHERE pool_id = ? AND user_id = ? AND week = ? AND event_id <> ? AND locks_at > ?'
      ).bind(pool.id, user.id, week, rows[0].eventId, t));
    }
    stmts.push(...rows.map(r => env.DB.prepare(
      `INSERT INTO picks (pool_id, user_id, event_id, week, selection_id, confidence, locks_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pool_id, user_id, event_id) DO UPDATE SET
         selection_id = excluded.selection_id,
         confidence   = excluded.confidence,
         locks_at     = excluded.locks_at,
         updated_at   = excluded.updated_at
       WHERE picks.locks_at > ?`
    ).bind(pool.id, user.id, r.eventId, week, r.selection, r.confidence, r.kickoff, t, t, t)));
    await env.DB.batch(stmts);
  }

  // Partial success is the honest answer: saving twelve picks and rejecting one
  // late one should not throw away the twelve.
  return priv({ saved: rows.map(r => r.eventId), rejected, week }, { origin });
}

/* --------------------------------------------------------------- standings */

/**
 * Score any finished games that have not been scored yet, then tally.
 *
 * Lazily, on read: no cron trigger, nothing running when nobody is looking.
 * `results` is separate from `picks` on purpose, so re-scoring a week is a
 * delete-and-reinsert here that never touches what anyone actually picked.
 */
async function scoreWeek(env, ctx, pool, week) {
  const picked = await env.DB.prepare(
    'SELECT COUNT(DISTINCT event_id) AS n FROM picks WHERE pool_id = ? AND week = ?'
  ).bind(pool.id, week).first();
  if (!picked || !picked.n) return;

  const scored = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM results WHERE pool_id = ? AND week = ?'
  ).bind(pool.id, week).first();
  if (scored && scored.n >= picked.n) return;      // nothing new could have finished

  const { games } = await weekGames(ctx, pool, week);
  const done = games.filter(g => g.final);
  if (!done.length) return;

  await env.DB.batch(done.map(g => env.DB.prepare(
    `INSERT INTO results (pool_id, event_id, week, winner_id, scored_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pool_id, event_id) DO UPDATE SET winner_id = excluded.winner_id, scored_at = excluded.scored_at`
  ).bind(pool.id, g.id, week, g.winner_id, now())));
}

/**
 * Has a prior week's loss already ended this user's survivor run? Scores
 * whatever earlier weeks haven't been scored yet first — this gets called from
 * `submitPicks`, which has no other reason to have triggered scoring, and an
 * elimination check against stale results is worse than useless.
 */
async function survivorEliminated(env, ctx, pool, userId, week) {
  const { results: priorWeeks } = await env.DB.prepare(
    'SELECT DISTINCT week FROM picks WHERE pool_id = ? AND user_id = ? AND week < ?'
  ).bind(pool.id, userId, week).all();
  for (const w of priorWeeks) await scoreWeek(env, ctx, pool, w.week);

  const row = await env.DB.prepare(
    `SELECT 1 FROM picks p JOIN results r
       ON r.pool_id = p.pool_id AND r.event_id = p.event_id
      WHERE p.pool_id = ? AND p.user_id = ? AND p.week < ?
        AND r.winner_id IS NOT NULL AND p.selection_id <> r.winner_id
      LIMIT 1`
  ).bind(pool.id, userId, week).first();
  return !!row;
}

async function standings(env, ctx, user, poolId, origin) {
  const pool = await memberPool(env, user, poolId);

  const { results: weeks } = await env.DB.prepare(
    'SELECT DISTINCT week FROM picks WHERE pool_id = ? ORDER BY week'
  ).bind(poolId).all();

  // Sequential on purpose: the scoreboard fetches are edge-cached, and a pool has
  // one or two live weeks, not eighteen.
  for (const w of weeks) await scoreWeek(env, ctx, pool, w.week);

  if (pool.mode === 'confidence') return standingsConfidence(env, pool, weeks, origin);
  if (pool.mode === 'survivor')   return standingsSurvivor(env, pool, weeks, origin);

  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.picture,
            COUNT(r.event_id)                                            AS decided,
            SUM(CASE WHEN r.winner_id IS NOT NULL
                     AND p.selection_id = r.winner_id THEN 1 ELSE 0 END)  AS wins,
            SUM(CASE WHEN r.winner_id IS NOT NULL
                     AND p.selection_id <> r.winner_id THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN r.winner_id IS NULL THEN 1 ELSE 0 END)          AS pushes
       FROM pool_members pm
       JOIN users u  ON u.id = pm.user_id
       LEFT JOIN picks   p ON p.pool_id = pm.pool_id AND p.user_id = pm.user_id
       LEFT JOIN results r ON r.pool_id = p.pool_id  AND r.event_id = p.event_id
      WHERE pm.pool_id = ?
      GROUP BY u.id, u.name, u.picture
      ORDER BY wins DESC, losses ASC, u.name`
  ).bind(poolId).all();

  const rows = results.map(r => ({
    ...r,
    // Ties are excluded from the denominator, the way a win percentage normally works.
    pct: (r.wins + r.losses) ? Math.round((r.wins / (r.wins + r.losses)) * 1000) / 10 : null,
  }));

  return priv({
    pool: { id: pool.id, name: pool.name, mode: pool.mode },
    weeks: weeks.map(w => w.week),
    standings: rows,
  }, { origin });
}

/** Points = sum of confidence on correct picks. A miss scores zero, never negative. */
async function standingsConfidence(env, pool, weeks, origin) {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.picture,
            SUM(CASE WHEN r.winner_id IS NOT NULL AND p.selection_id = r.winner_id
                     THEN p.confidence ELSE 0 END)                        AS points,
            SUM(CASE WHEN r.winner_id IS NOT NULL
                     AND p.selection_id = r.winner_id THEN 1 ELSE 0 END)  AS correct,
            SUM(CASE WHEN r.winner_id IS NOT NULL
                     AND p.selection_id <> r.winner_id THEN 1 ELSE 0 END) AS wrong
       FROM pool_members pm
       JOIN users u  ON u.id = pm.user_id
       LEFT JOIN picks   p ON p.pool_id = pm.pool_id AND p.user_id = pm.user_id
       LEFT JOIN results r ON r.pool_id = p.pool_id  AND r.event_id = p.event_id
      WHERE pm.pool_id = ?
      GROUP BY u.id, u.name, u.picture
      ORDER BY points DESC, correct DESC, u.name`
  ).bind(pool.id).all();
  return priv({ pool: { id: pool.id, name: pool.name, mode: pool.mode }, weeks: weeks.map(w => w.week), standings: results }, { origin });
}

/** Alive first, then by how long survived — last one out (or still standing) ranks top. */
async function standingsSurvivor(env, pool, weeks, origin) {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.picture,
            MIN(CASE WHEN r.winner_id IS NOT NULL AND p.selection_id <> r.winner_id
                     THEN p.week END)                                            AS eliminated_week,
            COUNT(DISTINCT CASE WHEN r.winner_id IS NOT NULL THEN p.week END)    AS weeks_scored
       FROM pool_members pm
       JOIN users u  ON u.id = pm.user_id
       LEFT JOIN picks   p ON p.pool_id = pm.pool_id AND p.user_id = pm.user_id
       LEFT JOIN results r ON r.pool_id = p.pool_id  AND r.event_id = p.event_id
      WHERE pm.pool_id = ?
      GROUP BY u.id, u.name, u.picture`
  ).bind(pool.id).all();

  const rows = results.map(r => ({ ...r, alive: r.eliminated_week == null })).sort((a, b) =>
    Number(b.alive) - Number(a.alive) ||
    (b.eliminated_week || 0) - (a.eliminated_week || 0) ||
    b.weeks_scored - a.weeks_scored ||
    (a.name || '').localeCompare(b.name || ''));

  return priv({ pool: { id: pool.id, name: pool.name, mode: pool.mode }, weeks: weeks.map(w => w.week), standings: rows }, { origin });
}
