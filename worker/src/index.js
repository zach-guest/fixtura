/**
 * Fixtura API — Cloudflare Worker.
 *
 * The worker has two lanes and the whole structure exists to keep them apart:
 *
 *   PUBLIC  (proxy.js)  — upstream sports data. Same answer for everyone, so it
 *                         is edge-cached and one call serves the whole pool.
 *   PRIVATE (auth.js,   — who you are, and your data. Different answer per
 *            me.js)       caller, so it is never stored anywhere, ever.
 *
 * The original worker had only the first lane and was GET-only with
 * `Cache-Control: public` on every route in its table. Bolting `/me` onto that
 * shape would have edge-cached one person's response and served it to the next
 * person who asked. Hence: the router below checks the private prefixes first,
 * a startup assertion makes the two route sets provably disjoint, and only
 * proxy.js can reach `caches.default`.
 *
 * Deploy:   npx wrangler deploy
 * Dev:      npx wrangler dev
 * Logs:     npx wrangler tail
 * Schema:   npm run db:schema
 */

import { corsHeaders, preflight, priv, ApiError, notFound } from './http.js';
import { ROUTES, isProxyRoute, handleProxy } from './proxy.js';
import { handleAuth } from './auth.js';
import { handleMe } from './me.js';
import { handlePools } from './pools.js';

/**
 * Path prefixes that are per-user. A request whose first segment is on this
 * list can never reach the proxy lane, whatever else is true.
 */
const PRIVATE_PREFIXES = new Set(['auth', 'me', 'pools', 'picks']);

// Provably disjoint. If a future proxy route is ever named `picks`, this throws
// on the first request after deploy rather than quietly caching private data.
for (const name of Object.keys(ROUTES)) {
  if (PRIVATE_PREFIXES.has(name)) {
    throw new Error(`route "${name}" is both a proxy route and a private prefix`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const requestId = crypto.randomUUID();

    if (request.method === 'OPTIONS') return preflight(origin);

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const head = segments[0] || '';

    try {
      if (head === 'health') return health(env, origin);

      if (PRIVATE_PREFIXES.has(head)) {
        if (head === 'auth')  return await handleAuth(request, segments, env, ctx, origin);
        if (head === 'me')    return await handleMe(request, segments, env, ctx, origin);
        if (head === 'pools') return await handlePools(request, segments, env, ctx, origin);
        // `picks` stays reserved so it can never be mistaken for a proxy route.
        // Everything pick'em-related lives under /pools, since a pick only means
        // anything inside a pool.
        throw notFound(`${head} is not built yet`);
      }

      if (isProxyRoute(head)) return await handleProxy(request, segments, env, ctx, origin);

      throw notFound('unknown route');
    } catch (err) {
      return errorResponse(err, { requestId, origin, method: request.method, path: url.pathname });
    }
  },
};

/**
 * Liveness plus a real D1 check, because "the worker is up" and "the worker can
 * reach its database" fail independently and the difference is the first thing
 * worth knowing. Private: a health probe is not something to serve from cache.
 */
async function health(env, origin) {
  let db = 'ok';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch (err) {
    db = `unreachable: ${String(err)}`;
  }
  const configured = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']
    .filter((k) => !env[k]);
  return priv({
    ok: db === 'ok' && configured.length === 0,
    db,
    // Names only — never the values.
    missing_config: configured,
    proxy_routes: Object.keys(ROUTES),
  }, { origin, status: db === 'ok' ? 200 : 503 });
}

/**
 * One error boundary for the whole worker.
 *
 * An `ApiError` is something the caller is meant to see — a 404, a 401, a bad
 * body — and goes back with its real status, message and detail. Anything else
 * is a bug: the client gets a generic 500 and the request id, and the actual
 * stack goes to `wrangler tail`. Guessing from a blank 500 is what this is
 * meant to prevent.
 */
function errorResponse(err, { requestId, origin, method, path }) {
  const known = err instanceof ApiError;
  const status = known ? err.status : 500;

  console[status >= 500 ? 'error' : 'warn'](JSON.stringify({
    requestId,
    method,
    path,
    status,
    message: err && err.message,
    detail: known ? err.detail : undefined,
    stack: known ? undefined : err && err.stack,
  }));

  return priv({
    error: known ? err.message : 'internal error',
    detail: known ? err.detail : undefined,
    requestId,
  }, { status, origin, extra: { 'X-Fixtura-Request-Id': requestId } });
}
