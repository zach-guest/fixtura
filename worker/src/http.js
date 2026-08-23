/**
 * Response construction and CORS.
 *
 * This file exists to enforce one rule, because getting it wrong is the failure
 * mode that made the old single-lane worker unsafe to extend:
 *
 *   Every response is either PUBLIC or PRIVATE.
 *   PUBLIC  — identical for everyone, safe in a shared edge cache.
 *   PRIVATE — depends on who asked, must never be stored by anything.
 *
 * Nothing outside this file builds a `Response` by hand. `pub()` and `priv()`
 * are the only two constructors, so a new route cannot forget to say which it
 * is: it has to pick one to return anything at all.
 */

// Origins allowed to call this worker from a browser. An origin that is not on
// this list gets NO CORS headers back — the browser then blocks the read. It is
// deliberately not a wildcard and deliberately does not fall back to entry [0],
// which the old version did: silently answering an unknown origin with someone
// else's Allow-Origin is confusing to debug and buys nothing.
export const ALLOWED_ORIGINS = [
  'https://zach-guest.github.io',   // the deployed app
  'http://localhost:8123',          // the local server recipe in CLAUDE.md
  'http://127.0.0.1:8123',
];

/** Methods a browser may preflight. The private lane needs more than GET. */
const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type,Authorization';

/**
 * CORS headers for an origin, or `{}` if the origin is not allowed.
 * `Vary: Origin` is always set so a cached response can never be replayed to a
 * different origin with the wrong Allow-Origin stamped on it.
 */
export function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Preflight. Cheap, and never reaches a route handler. */
export function preflight(origin) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/**
 * A PUBLIC response: the same bytes for every caller, cacheable for `ttl`
 * seconds. Only the proxy lane may use this.
 */
export function pub(body, { status = 200, ttl, contentType = 'application/json', origin, extra = {} } = {}) {
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${ttl}`,
    ...extra,
    ...corsHeaders(origin),
  });
  return new Response(body, { status, headers });
}

/**
 * A PRIVATE response: tied to one caller, never stored anywhere. `no-store` is
 * what keeps it out of Cloudflare's cache, the browser's cache, and any proxy
 * in between. `Vary` names the two inputs that change the answer.
 */
export function priv(obj, { status = 200, origin, extra = {} } = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, private',
    ...extra,
    ...corsHeaders(origin),
    Vary: 'Origin, Authorization',
  });
  return new Response(obj === null ? null : JSON.stringify(obj), { status, headers });
}

/**
 * A redirect out of the private lane (the OAuth hops). Still `no-store`: the
 * callback's Location carries a session token in its fragment.
 */
export function redirect(location, origin) {
  return new Response(null, {
    status: 302,
    headers: new Headers({
      Location: location,
      'Cache-Control': 'no-store, private',
      ...corsHeaders(origin),
    }),
  });
}

/**
 * An error the caller is allowed to see. Everything thrown as an `ApiError`
 * reaches the client with its real status and message; anything else becomes a
 * generic 500 with the detail in the logs only.
 */
export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const bad        = (msg, detail) => new ApiError(400, msg, detail);
export const unauth     = (msg = 'not signed in') => new ApiError(401, msg);
export const forbidden  = (msg = 'not allowed') => new ApiError(403, msg);
export const notFound   = (msg = 'not found') => new ApiError(404, msg);
