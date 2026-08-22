/**
 * The PUBLIC lane: a read-only proxy in front of the upstream sports APIs.
 *
 * Everything here is shared. Two people asking for the same scoreboard get the
 * same bytes, so the response is edge-cached and one upstream call serves the
 * whole pool. Nothing in this file may read the session — if a route needs to
 * know who is asking, it belongs in the private lane instead.
 *
 * Why the explicit Cache API rather than Workers Caching (`[cache] enabled`):
 * Workers Caching is read-through and decides from the `Cache-Control` a
 * response happens to carry, which means a route that forgets a header can be
 * cached by heuristic. The Cache API caches only what this file explicitly
 * `put`s, which is the property worth having once authenticated routes share
 * the same worker. If that trade is ever revisited, note that the private lane
 * would then be relying on `no-store` alone.
 */

import { pub, ApiError, notFound } from './http.js';

/**
 * host    — upstream origin
 * prefix  — path prepended to whatever the caller asked for
 * ttl     — edge cache lifetime in seconds
 * exact   — ignore the caller's path entirely (wiki takes only a query string)
 * key     — name of the secret to inject, if the upstream needs one
 */
export const ROUTES = {
  espn:     { host: 'site.api.espn.com',            prefix: '/apis/site/v2/sports',   ttl: 30 },
  espnweb:  { host: 'site.web.api.espn.com',        prefix: '/apis/common/v3/sports', ttl: 3600 },
  espncore: { host: 'sports.core.api.espn.com',     prefix: '/v2',                    ttl: 86400 },
  f1:       { host: 'api.jolpi.ca',                 prefix: '/ergast/f1',             ttl: 900 },
  wx:       { host: 'api.open-meteo.com',           prefix: '/v1',                    ttl: 600 },
  geo:      { host: 'geocoding-api.open-meteo.com', prefix: '/v1',                    ttl: 86400 },
  wiki:     { host: 'en.wikipedia.org',             prefix: '/w/api.php',             ttl: 86400, exact: true },
  odds:     { host: 'api.the-odds-api.com',         prefix: '/v4',                    ttl: 120, key: 'ODDS_API_KEY', keyParam: 'apiKey' },
};
// `score` (api.thescore.com) was removed here: it was never CORS-verified and
// nothing calls it. See DECISIONS.md — re-add it only with a real check.

/** Upstream calls that hang should fail fast rather than burn the worker's time. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** See the note on the fetch below — the URL in this string is load-bearing. */
const UPSTREAM_UA = 'Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)';

export function isProxyRoute(name) {
  return Object.prototype.hasOwnProperty.call(ROUTES, name);
}

/**
 * Fetch and parse JSON from an upstream, edge-cached, for code running *inside*
 * the worker rather than proxying a caller's request.
 *
 * This exists so the private lane can read ESPN without duplicating the two
 * things that are easy to get wrong: the User-Agent (see the note below — a bare
 * token gets a 403) and the cache handling. Pick'em needs kickoff times, and it
 * must read them itself rather than believe a client.
 *
 * The cache makes it nearly free: a pool submitting picks all evening shares one
 * upstream call per 30 seconds.
 */
export async function getJSON(url, ttl, ctx) {
  const cache = caches.default;
  const key = new Request(url, { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return await hit.json();

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UPSTREAM_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(502, 'upstream fetch failed', { upstream: url, cause: String(err) });
  }
  if (!res.ok) throw new ApiError(502, 'upstream returned an error', { upstream: url, status: res.status });

  const body = await res.text();
  if (ctx) {
    ctx.waitUntil(cache.put(key, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
    })));
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(502, 'upstream did not return JSON', { upstream: url });
  }
}

/**
 * @param {Request} request
 * @param {string[]} segments  path split on '/', segments[0] is the route name
 */
export async function handleProxy(request, segments, env, ctx, origin) {
  const route = ROUTES[segments[0]];
  if (!route) throw notFound('unknown proxy route');

  // The proxy is a read path. Anything else is a mistake worth naming.
  if (request.method !== 'GET') {
    throw new ApiError(405, 'the proxy lane is GET only', { route: segments[0] });
  }

  const url = new URL(request.url);
  const rest = '/' + segments.slice(1).join('/');
  const upstream = new URL('https://' + route.host + route.prefix + (route.exact ? '' : rest));
  url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

  if (route.key) {
    const secret = env[route.key];
    if (!secret) throw new ApiError(500, `${route.key} is not configured on the worker`);
    upstream.searchParams.set(route.keyParam, secret);
  }

  // The cache key drops the injected secret, so the entry is shareable and the
  // secret never becomes part of a cache identity.
  const cacheKeyUrl = new URL(upstream);
  if (route.keyParam) cacheKeyUrl.searchParams.delete(route.keyParam);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    // What is stored carries no CORS headers (see below), so they are stamped
    // on here for the origin that actually asked.
    return pub(hit.body, {
      status: hit.status,
      ttl: route.ttl,
      contentType: hit.headers.get('Content-Type') || 'application/json',
      origin,
      extra: { 'X-Fixtura-Cache': 'HIT' },
    });
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.toString(), {
      headers: {
        // This exact string matters. ESPN sits behind Akamai, which 403s a
        // server-side request whose User-Agent is a bare token — measured
        // 2026-08-21, `Fixtura/1.0` and `Fixtura/1.0 (personal sports
        // dashboard)` were refused 3/3, as was a short spoofed `Mozilla/5.0`.
        // What passes is the conventional crawler form: product/version plus a
        // contact URL. Verified 200 3/3 against all five upstreams. The old
        // worker sent the blocked string, which would have failed every ESPN
        // call the moment it was deployed. Do not "tidy" this into a shorter
        // one without re-measuring.
        'User-Agent': UPSTREAM_UA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtl: route.ttl, cacheEverything: true },
    });
  } catch (err) {
    // Real diagnostics: which upstream, and what it actually did.
    throw new ApiError(502, 'upstream fetch failed', {
      upstream: cacheKeyUrl.toString(),
      cause: String(err),
    });
  }

  const contentType = upstreamRes.headers.get('Content-Type') || 'application/json';

  // Only successful responses are stored. An upstream 404 or 500 is passed
  // through but not cached, so a blip does not stick for the full TTL.
  if (!upstreamRes.ok) {
    return pub(upstreamRes.body, { status: upstreamRes.status, ttl: 0, contentType, origin, extra: { 'X-Fixtura-Cache': 'BYPASS' } });
  }

  // Two bodies from one: one to store, one to return, so nothing is buffered
  // into memory. ESPN's summary payloads run to ~520 KB.
  const [toStore, toReturn] = upstreamRes.body.tee();

  // Stored WITHOUT CORS headers, so one origin's entry can never be handed to
  // another with the wrong Allow-Origin on it.
  const stored = new Response(toStore, {
    status: upstreamRes.status,
    headers: new Headers({
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${route.ttl}`,
    }),
  });
  ctx.waitUntil(cache.put(cacheKey, stored));

  return pub(toReturn, {
    status: upstreamRes.status,
    ttl: route.ttl,
    contentType,
    origin,
    extra: { 'X-Fixtura-Cache': 'MISS' },
  });
}
