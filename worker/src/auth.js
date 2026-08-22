/**
 * The PRIVATE lane: identity.
 *
 * Google OAuth 2.0 authorization-code flow, then a bearer token of our own.
 * Google is only ever asked "who is this?" once, at sign-in; every request
 * after that is answered from the `sessions` table, so a page load costs one
 * indexed D1 lookup and no network hop.
 *
 * Nothing in here may return a `pub()` response. Every path is per-user.
 *
 * Setup, Zach-side, in the Google Cloud console:
 *   1. APIs & Services -> OAuth consent screen -> External, add yourself and
 *      anyone in the pool as test users (or publish it).
 *   2. Credentials -> Create OAuth client ID -> Web application.
 *   3. Authorized redirect URIs must list every host this worker answers on:
 *        https://fixtura-api.<subdomain>.workers.dev/auth/google/callback
 *        http://localhost:8787/auth/google/callback        (wrangler dev)
 *      The redirect_uri below is derived from the incoming request, so it
 *      matches whichever host was used — but Google still requires each to be
 *      registered exactly.
 *   4. Then, in worker/:
 *        npx wrangler secret put GOOGLE_CLIENT_SECRET
 *        npx wrangler secret put SESSION_SECRET      # any long random string
 *      and put the (non-secret) client id in wrangler.jsonc under [vars].
 */

import { priv, redirect, ApiError, bad, unauth, notFound, ALLOWED_ORIGINS } from './http.js';

const GOOGLE_AUTH  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISS   = ['https://accounts.google.com', 'accounts.google.com'];

const SESSION_TTL   = 30 * 24 * 3600;   // 30 days
const STATE_TTL     = 10 * 60;          // an unfinished sign-in expires fast
const TOKEN_BYTES   = 32;

const now = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time compare. Length is checked first because timingSafeEqual throws on a mismatch. */
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- oauth state */

/**
 * The `state` parameter, signed rather than stored. It has to survive a round
 * trip through Google and come back provably ours, which an HMAC does without
 * needing a KV namespace or a row to clean up later. It carries the return URL
 * so the callback knows where to send the browser.
 */
async function signState(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64url(await hmac(secret, body));
}

async function readState(secret, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw bad('malformed state');

  // Decoding is inside the guard because a tampered state is usually not valid
  // base64url at all, and `atob` throws rather than returning junk. Without
  // this the caller got an opaque 500 instead of "your state does not verify".
  let sigBytes;
  try {
    sigBytes = b64urlDecode(sig);
  } catch {
    throw bad('malformed state');
  }
  if (!sameBytes(sigBytes, await hmac(secret, body))) throw bad('state signature does not verify');

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    throw bad('unreadable state');
  }
  if (typeof payload.t !== 'number' || now() - payload.t > STATE_TTL) {
    throw bad('sign-in took too long, start again');
  }
  return payload;
}

/**
 * Where the browser is sent after sign-in. Only origins on the allow-list are
 * accepted — an open redirect here would hand the session token to whoever
 * asked for it.
 */
function safeReturnUrl(raw, fallback) {
  if (!raw) return fallback;
  let u;
  try { u = new URL(raw); } catch { return fallback; }
  return ALLOWED_ORIGINS.includes(u.origin) ? u.toString() : fallback;
}

/* --------------------------------------------------------------- sessions */

/**
 * Issue a session. Only the SHA-256 of the token is stored, so a dump of the
 * table cannot be replayed as a login — the same reasoning as a password hash,
 * and the reason `sessions.token_hash` is the primary key.
 */
async function createSession(env, userId, userAgent) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const expires = now() + SESSION_TTL;
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).bind(await sha256hex(token), userId, now(), expires, (userAgent || '').slice(0, 256)).run();
  return { token, expires };
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/**
 * Resolve the caller, or null. Expiry is enforced in the WHERE clause rather
 * than by a cleanup job, so an expired row can never authenticate even if it
 * is still sitting in the table.
 */
export async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  return await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.picture, u.role, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256hex(token), now()).first();
}

/** Same, but 401s instead of returning null. Every /me and /picks route starts here. */
export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw unauth();
  return user;
}

/* ----------------------------------------------------------------- routes */

export async function handleAuth(request, segments, env, ctx, origin) {
  const sub = segments.slice(1).join('/');

  if (sub === 'google/start'    && request.method === 'GET')  return startGoogle(request, env, origin);
  if (sub === 'google/callback' && request.method === 'GET')  return callbackGoogle(request, env, ctx, origin);
  if (sub === 'logout'          && request.method === 'POST') return logout(request, env, origin);

  throw notFound('unknown auth route');
}

function requireConfig(env) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (missing.length) {
    throw new ApiError(500, 'auth is not configured on this worker', { missing });
  }
}

/** The redirect_uri, derived from the host actually being used. See the note up top. */
function redirectUri(request) {
  return new URL('/auth/google/callback', request.url).toString();
}

async function startGoogle(request, env, origin) {
  requireConfig(env);
  const url = new URL(request.url);
  const back = safeReturnUrl(url.searchParams.get('return'), ALLOWED_ORIGINS[0] + '/fixtura/');

  const state = await signState(env.SESSION_SECRET, {
    n: crypto.randomUUID(),
    t: now(),
    r: back,
  });

  const auth = new URL(GOOGLE_AUTH);
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri(request));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('access_type', 'online');   // no refresh token: we never call Google again
  auth.searchParams.set('prompt', 'select_account');
  return redirect(auth.toString(), origin);
}

async function callbackGoogle(request, env, ctx, origin) {
  requireConfig(env);
  const url = new URL(request.url);

  // Google reports a declined consent screen here rather than by failing.
  const denied = url.searchParams.get('error');
  if (denied) throw bad('google declined the sign-in', { error: denied });

  const code = url.searchParams.get('code');
  if (!code) throw bad('no code on the callback');

  const state = await readState(env.SESSION_SECRET, url.searchParams.get('state'));

  const form = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(request),
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.id_token) {
    // Google's error body is the only thing that says *why* — surface it rather
    // than guessing at a fallback.
    throw new ApiError(502, 'google token exchange failed', {
      status: res.status,
      error: payload.error,
      description: payload.error_description,
    });
  }

  const claims = readIdToken(payload.id_token, env.GOOGLE_CLIENT_ID);
  const user = await upsertUser(env, claims);
  const { token, expires } = await createSession(env, user.id, request.headers.get('User-Agent'));

  // Sweep this user's expired sessions on the way through. Cheap, bounded, and
  // it means no scheduled job exists purely to delete rows.
  ctx.waitUntil(
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, now()).run()
  );

  // The token goes back in the URL *fragment*, not the query string: a fragment
  // is never sent to a server, so it stays out of access logs and out of the
  // Referer header of whatever the page loads next.
  const back = new URL(state.r);
  back.hash = `fixtura_token=${encodeURIComponent(token)}&fixtura_expires=${expires}`;
  return redirect(back.toString(), origin);
}

/**
 * Read the id_token's claims.
 *
 * The signature is deliberately not verified. This token came back on our own
 * TLS connection to Google's token endpoint, in response to a request carrying
 * the client secret — OpenID Connect Core 3.1.3.7 allows skipping signature
 * validation in exactly this case. Verifying would mean fetching and caching
 * Google's JWKS on every cold start for no added assurance. `iss`/`aud`/`exp`
 * are still checked, because they are free.
 */
function readIdToken(idToken, clientId) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new ApiError(502, 'google returned a malformed id_token');

  let c;
  try {
    c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new ApiError(502, 'google id_token claims are unreadable');
  }

  if (!GOOGLE_ISS.includes(c.iss)) throw new ApiError(502, 'id_token issuer is not google', { iss: c.iss });
  if (c.aud !== clientId)          throw new ApiError(502, 'id_token was issued for a different client');
  if (typeof c.exp === 'number' && c.exp < now()) throw new ApiError(502, 'id_token has already expired');
  if (!c.sub)                      throw new ApiError(502, 'id_token has no subject');
  return c;
}

/**
 * Create or refresh the user row. Keyed on (provider, sub) because `sub` is the
 * only Google field guaranteed stable — an email can be reassigned inside a
 * Workspace, so it is stored for display and never used to identify anyone.
 *
 * The first person to sign in becomes admin. There is no other way to get the
 * role, and someone has to be able to administer the thing.
 */
async function upsertUser(env, claims) {
  const t = now();
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const role = existing && existing.n === 0 ? 'admin' : 'user';

  return await env.DB.prepare(
    `INSERT INTO users (provider, sub, email, name, picture, role, created_at, last_seen)
     VALUES ('google', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, sub) DO UPDATE SET
       email     = excluded.email,
       name      = excluded.name,
       picture   = excluded.picture,
       last_seen = excluded.last_seen
     RETURNING id, name, email, picture, role, created_at`
  ).bind(claims.sub, claims.email || null, claims.name || null, claims.picture || null, role, t, t).first();
}

async function logout(request, env, origin) {
  const token = bearer(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
  }
  // Always 200: signing out of a session that is already gone is not an error.
  return priv({ ok: true }, { origin });
}
