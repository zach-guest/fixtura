/**
 * The PRIVATE lane: the signed-in user, and their synced settings.
 *
 * Settings are stored as key/value with the keys being exactly the existing
 * `sb-*` localStorage keys, so the frontend can push what it already has
 * without learning a second shape. The server is a store, not an authority on
 * meaning: it never parses the JSON inside a value.
 */

import { priv, bad, notFound } from './http.js';
import { requireUser } from './auth.js';

const now = () => Math.floor(Date.now() / 1000);

/** Only the app's own keys, and only as much as a dashboard could plausibly hold. */
const KEY_PATTERN   = /^sb-[a-z0-9-]{1,40}$/;
const MAX_VALUE     = 64 * 1024;   // per key
const MAX_KEYS      = 40;          // per request

export async function handleMe(request, segments, env, ctx, origin) {
  const user = await requireUser(request, env);
  const sub = segments.slice(1).join('/');

  if (sub === ''         && request.method === 'GET') return priv({ user }, { origin });
  if (sub === 'settings' && request.method === 'GET') return getSettings(env, user, origin);
  if (sub === 'settings' && request.method === 'PUT') return putSettings(request, env, user, origin);

  throw notFound('unknown /me route');
}

async function getSettings(env, user, origin) {
  const { results } = await env.DB.prepare(
    'SELECT key, value, updated_at FROM settings WHERE user_id = ?'
  ).bind(user.id).all();

  const settings = {};
  for (const row of results) settings[row.key] = { value: row.value, updated_at: row.updated_at };
  return priv({ settings }, { origin });
}

/**
 * Upsert whatever was sent. `updated_at` is stamped from the server's clock,
 * never the client's — a device with a wrong clock would otherwise be able to
 * make its copy permanently "newer" than everyone else's.
 *
 * This is last-write-wins, per key. That is the right call while one person
 * uses two devices; it is the wrong call the moment two people share a login,
 * which is not a thing Fixtura supports.
 */
async function putSettings(request, env, user, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw bad('body must be JSON');
  }

  const settings = body && body.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw bad('expected { "settings": { "sb-key": "value", ... } }');
  }

  const entries = Object.entries(settings);
  if (entries.length === 0) throw bad('no settings sent');
  if (entries.length > MAX_KEYS) throw bad(`too many keys at once (max ${MAX_KEYS})`);

  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key))   throw bad(`not a settings key: ${key}`);
    if (typeof value !== 'string') throw bad(`value for ${key} must be a string`);
    if (value.length > MAX_VALUE)  throw bad(`value for ${key} is too large (max ${MAX_VALUE} bytes)`);
  }

  const t = now();
  await env.DB.batch(
    entries.map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(user.id, key, value, t)
    )
  );

  return priv({ saved: entries.map(([k]) => k), updated_at: t }, { origin });
}
