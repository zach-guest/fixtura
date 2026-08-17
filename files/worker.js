/**
 * Pressbox API proxy — Cloudflare Worker
 *
 * Why this exists:
 *   1. Keeps API keys server-side. A key in a public GitHub Pages file is a public key.
 *   2. Caches upstream responses at Cloudflare's edge, so ten friends checking scores
 *      costs one call upstream instead of ten. This is what keeps you under rate limits.
 *   3. Gives the frontend one origin to talk to, so swapping data providers later is a
 *      change in this file rather than a change in the app.
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 *   wrangler secret put ODDS_API_KEY        # only if/when you add a keyed provider
 *
 * Routes:
 *   /espn/<path>      -> site.api.espn.com/apis/site/v2/sports/<path>
 *   /espnweb/<path>   -> site.web.api.espn.com/apis/common/v3/sports/<path>
 *   /espncore/<path>  -> sports.core.api.espn.com/v2/<path>
 *   /score/<path>     -> api.thescore.com/<path>
 *   /f1/<path>        -> api.jolpi.ca/ergast/f1/<path>
 *   /wx/<path>        -> api.open-meteo.com/v1/<path>
 *   /geo/<path>       -> geocoding-api.open-meteo.com/v1/<path>
 *   /wiki             -> en.wikipedia.org/w/api.php
 *   /odds/<path>      -> api.the-odds-api.com/v4/<path>   (key injected from secret)
 */

const ROUTES = {
  espn:     { host: 'site.api.espn.com',        prefix: '/apis/site/v2/sports',   ttl: 30  },
  espnweb:  { host: 'site.web.api.espn.com',    prefix: '/apis/common/v3/sports', ttl: 3600 },
  espncore: { host: 'sports.core.api.espn.com', prefix: '/v2',                    ttl: 86400 },
  score:    { host: 'api.thescore.com',         prefix: '',                       ttl: 30  },
  f1:       { host: 'api.jolpi.ca',             prefix: '/ergast/f1',             ttl: 900 },
  wx:       { host: 'api.open-meteo.com',       prefix: '/v1',                    ttl: 600 },
  geo:      { host: 'geocoding-api.open-meteo.com', prefix: '/v1',                ttl: 86400 },
  wiki:     { host: 'en.wikipedia.org',         prefix: '/w/api.php',             ttl: 86400, exact: true },
  odds:     { host: 'api.the-odds-api.com',     prefix: '/v4',                    ttl: 120, key: 'ODDS_API_KEY', keyParam: 'apiKey' },
};

// Lock this down to your own site once you know the URL. '*' is fine while developing.
const ALLOWED_ORIGINS = [
  'https://YOURUSERNAME.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, 405, cors);
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const routeName = segments[0];
    const route = ROUTES[routeName];

    if (!route) {
      return json({
        error: 'unknown route',
        available: Object.keys(ROUTES),
      }, 404, cors);
    }

    // Build the upstream URL
    const rest = '/' + segments.slice(1).join('/');
    const upstream = new URL('https://' + route.host + route.prefix + (route.exact ? '' : rest));

    // Pass the caller's query string through untouched
    url.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

    // Inject the secret key if this route needs one. The browser never sees it.
    if (route.key) {
      const secret = env[route.key];
      if (!secret) return json({ error: route.key + ' not configured on the worker' }, 500, cors);
      upstream.searchParams.set(route.keyParam, secret);
    }

    // Edge cache: key on the upstream URL *without* the secret, so the cache is shareable
    const cacheKeyUrl = new URL(upstream);
    if (route.keyParam) cacheKeyUrl.searchParams.delete(route.keyParam);
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
    const cache = caches.default;

    let hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      h.set('X-Pressbox-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream.toString(), {
        headers: {
          // Be a good citizen: identify the app rather than pretending to be a browser.
          'User-Agent': 'Pressbox/1.0 (personal sports dashboard)',
          'Accept': 'application/json',
        },
        cf: { cacheTtl: route.ttl, cacheEverything: true },
      });
    } catch (err) {
      return json({ error: 'upstream fetch failed', detail: String(err) }, 502, cors);
    }

    const body = await upstreamRes.text();
    const headers = new Headers({
      'Content-Type': upstreamRes.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'public, max-age=' + route.ttl,
      'X-Pressbox-Cache': 'MISS',
      ...cors,
    });

    const response = new Response(body, { status: upstreamRes.status, headers });

    // Only cache successful responses, and do it without blocking the reply
    if (upstreamRes.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
