/**
 * PRIVATE EPA import routes. Machine-authenticated, never cached.
 *
 * These live under the `epa` prefix, which `index.js` lists in
 * PRIVATE_PREFIXES — so a request here can never fall through into the cached
 * proxy lane, and the module-scope disjointness assertion fails on deploy if a
 * proxy route is ever named `epa`.
 *
 * Auth is a dedicated bearer secret, `EPA_IMPORT_TOKEN`, and nothing else:
 *
 *  - It is NOT a user session. No user's token may import data, and this route
 *    never touches the sessions table or Google.
 *  - It authorizes these two routes and nothing more.
 *  - The token value is never logged, never echoed, and never included in a
 *    response — not even in an error detail.
 *  - Comparison is constant-time. A length-varying or short-circuiting compare
 *    on a secret is a timing oracle, and there is no reason to have one when
 *    the fix is this small.
 *
 * When the secret is unset the routes return 503 and say the name only, the
 * same way /health reports missing config. That is deliberately distinct from
 * 401: "the server cannot do this" and "you may not do this" are different
 * problems and cost different hours to diagnose.
 */

import { priv, bad, unauth, notFound, ApiError } from './http.js';
import { validateNflEpaPayload, validateCfbEpaPayload } from './epa-validate.js';
import { ingestEpaGame, recordImportState } from './epa-store.js';

/** One game's payload is a few hundred KB at most; a week of them is not. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_GAMES_PER_REQUEST = 40;

const VALIDATORS = { nfl: validateNflEpaPayload, cfb: validateCfbEpaPayload };

/** Constant-time string compare. Returns false for any length mismatch, but
 *  only after doing the same work, so length is not leaked by timing either. */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function requireMachineToken(request, env) {
  const expected = env.EPA_IMPORT_TOKEN;
  if (!expected) {
    // Name only, never the value — matching /health's missing_config.
    throw new ApiError(503, 'EPA import is not configured', { missing_config: ['EPA_IMPORT_TOKEN'] });
  }
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !timingSafeEqual(match[1], expected)) {
    throw unauth('invalid import credentials');
  }
}

async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) {
    throw bad('payload too large', { max_bytes: MAX_BODY_BYTES, declared });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw bad('payload too large', { max_bytes: MAX_BODY_BYTES });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw bad('body is not valid JSON', { reason: String(err.message).slice(0, 120) });
  }
}

/**
 * POST /epa/import/:league   (league = nfl | cfb)
 *
 * Body: a single game payload, or `{ "games": [ ... ] }`.
 * `?dryRun=1` validates and reports without writing anything.
 *
 * Each game is reported independently: one invalid game does not discard the
 * valid ones alongside it, and the response says exactly which failed and why.
 * A game that fails still gets an import-state row, because "we tried and it
 * did not validate" is the state most worth being able to see later.
 */
export async function handleEpaImport(request, segments, env, ctx, origin) {
  if (segments[1] !== 'import' || segments.length !== 3) throw notFound('unknown epa route');
  const league = segments[2];
  const validate = VALIDATORS[league];
  if (!validate) throw notFound(`unknown league: ${league}`);
  if (request.method !== 'POST') throw bad('epa import is POST only');

  requireMachineToken(request, env);

  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== 'dryRun') throw bad(`unknown query parameter: ${key}`);
  }
  const dryRun = url.searchParams.get('dryRun') === '1';

  const body = await readBody(request);
  const games = Array.isArray(body?.games) ? body.games : [body];
  if (!games.length) throw bad('no games in payload');
  if (games.length > MAX_GAMES_PER_REQUEST) {
    throw bad('too many games in one request', { max: MAX_GAMES_PER_REQUEST, got: games.length });
  }

  const importedAt = Math.floor(Date.now() / 1000);
  const results = [];

  for (const payload of games) {
    let normalized;
    try {
      normalized = validate(payload);
    } catch (err) {
      const eventId = typeof payload?.event_id === 'string' ? payload.event_id : null;
      results.push({
        status: 'rejected',
        league,
        event_id: eventId,
        error: err instanceof ApiError ? err.message : 'invalid payload',
        detail: err instanceof ApiError ? err.detail : undefined,
      });
      // Best-effort bookkeeping. A malformed payload may not carry enough to
      // key a row; failing to record that must not fail the whole request.
      if (!dryRun && eventId && Number.isInteger(payload?.season) && Number.isInteger(payload?.week)) {
        try {
          await recordImportState(env.DB, league, {
            event_id: eventId,
            season: payload.season,
            season_type: payload.season_type_espn ?? 2,
            week: payload.week,
          }, { importedAt, status: 'failed', error: err.message });
        } catch { /* bookkeeping is not worth failing the import over */ }
      }
      continue;
    }

    if (dryRun) {
      results.push({
        status: 'validated',
        league,
        event_id: normalized.game.event_id,
        plays: normalized.plays.length,
        team_games: normalized.team_games.length,
        player_games: normalized.player_games.length,
      });
      continue;
    }

    const outcome = await ingestEpaGame(env.DB, normalized, { importedAt });
    await recordImportState(env.DB, league, normalized.game, {
      importedAt,
      status: outcome.status === 'stale' || outcome.status === 'superseded' ? 'partial' : 'imported',
      sourceHash: outcome.content_hash ?? null,
    });
    results.push(outcome);
  }

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  // 207 when some games failed and some did not: a flat 200 would let a
  // workflow treat a half-failed import as success.
  const rejected = results.filter((r) => r.status === 'rejected').length;
  const status = rejected === 0 ? 200 : (rejected === results.length ? 400 : 207);

  return priv({ league, dry_run: dryRun, imported_at: importedAt, summary, results }, { status, origin });
}
