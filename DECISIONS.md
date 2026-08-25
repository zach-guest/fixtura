# Fixtura — decisions and roadmap

Split out of `CLAUDE.md` on 2026-08-21. That file is loaded into every session and
should hold what governs how code gets written; this one holds what was decided and
what is planned, which is read occasionally rather than every turn. Keep it that way
— if something here starts constraining day-to-day edits, it belongs back there.

## Open decisions

1. **Data provider — ESPN stays, and covers more than was assumed.** A 2026-08
   evaluation went looking for EPA and win probability elsewhere, then found ESPN
   already serves live per-play **win probability** for free (see Data sources).
   The Drive view is built on it. Two conclusions worth keeping:

   - **ESPN has win probability but NOT EPA.** These are two different things and
     the planning docs conflated them. Live WP: already have it. EPA: post-game
     only, nflverse-derived, needs a second provider.
   - **Big Balls Sports Data** (`bigballsdata.com`) was the evaluated candidate.
     Real service, but its NFL play-by-play with EPA is **written after the game
     ends** ("not a live in-game feed", refreshed weekly after MNF) — it cannot
     power anything live. Free tier is 1,000 req/day (2,000 via GitHub) and
     current + most-recent season only; its own NFL page and pricing page
     **contradict each other** on whether play-by-play is free or gated to the
     $149/mo Edge plan — resolve that with a real key before writing integration
     code. Live WebSocket push is $299/mo (Pro), not $49. Its free "live" is a
     15-second REST cache, i.e. no better than ESPN, which is free and unmetered.
   - **Leverage:** its NFL data is nflverse under CC BY 4.0 — not gatekept. The
     raw play-by-play is a ~98 MB CSV on `nflverse/nflverse-data` GitHub releases
     (too big to fetch in-browser, fine to slim down once with a script and ship
     as static JSON). Don't pay for convenience you can pre-bake.
   - Still unverified: `api.thescore.com` (a collaborator's preference) — **check
     its CORS headers before committing to it**; permissive CORS is the only
     reason the no-backend architecture works. Other paid options previously
     evaluated: API-Sports, The Odds API (500 req/mo free, no sharp books),
     SportsGameOdds ($99+/mo), SportsDataIO ($25/mo), Sportradar (enterprise).
   - Also surveyed and rejected for live PBP: Tank01 via RapidAPI (real live
     PBP, but 1,000 req/**month** free and no EPA), API-American-Football
     (100/day, no EPA), Highlightly (PBP paywalled), BallDontLie (PBP paid).
     Free + live + EPA together does not exist below enterprise pricing.

2. **Proxy or not — settled by the accounts track, not by the data question.**
   The original argument still holds on its own terms: nothing on the *live-data*
   path needs a proxy, because ESPN is keyless and CORS-open, and the proxy only
   becomes necessary for a **keyed** provider (EPA or odds), since a key in a
   public static file is a public key. It also solves rate limits via edge caching
   (30s scores, 15min F1, 24h team lists), and the frontend change is three
   constants.
   What changed on 2026-08-21 is that accounts need a server regardless, so the
   worker is deployed for auth whether or not a keyed provider ever lands — it
   went live 2026-08-22 at `https://fixtura-api.fixturaapp.workers.dev`.
   The proxy lane rides along and is verified working end to end, but the
   frontend still calls ESPN directly and there is no reason to change that yet.
   Both pre-ship cleanups are **done**: `ALLOWED_ORIGINS` now names the real
   origins, and the unverified `api.thescore.com` route is cut. Re-add `score`
   only with a real CORS check.
   Also found while testing: ESPN 403s the worker based on its User-Agent, which
   the browser never sees. The worker would have failed every ESPN call on day
   one. See hard-won detail 18 in `CLAUDE.md`.

3. ~~**localStorage vs accounts.**~~ **Superseded.** This said to stay on
   localStorage, consider a login-free "sync code", and not build auth
   preemptively. Pick'em requires identity, which is the condition it named, so
   the accounts track below settled it the other way on 2026-08-21. Kept because
   the reasoning still applies to any *future* feature: don't add identity to
   something that doesn't need it. localStorage is still the store of record for
   a signed-out device, but a signed-in one now syncs through `/me/settings` (see
   item 3 below) — this is no longer a gap, just the historical reasoning.

4. **Operational gaps found while testing pick'em, flagged but not yet acted
   on:**
   - **D1's backup window is thin for a season-long pool.** D1's Time Travel
     point-in-time restore is 7 days on the free Workers plan, 30 days on the
     $5/mo plan. Over an 18-week season, a mangled week-3 pick not noticed
     until week 5 would be unrecoverable on the free tier. Upgrade to the
     $5/mo plan before real picks exist — i.e. before 2026-09-09.
   - **Nothing is watching for errors.** Failures currently only reach
     `console.error`/`wrangler tail`, which nobody is watching live. Two cheap
     fixes, neither built: Cloudflare's built-in Worker error-rate email
     alert, and a cron-triggered Worker that hits `/health` and asserts
     ESPN's response shape hasn't silently changed — the more likely real
     failure is picks quietly not saving behind a clean 200, not a crash.
   - **Alternate sign-in providers were evaluated and deliberately deferred.**
     Email magic links (via Cloudflare's email service) are the real fallback
     if Google-only proves too limiting; GitHub is low effort but low value
     for this audience; Apple needs a paid developer account plus a
     self-minted JWT secret. Linking accounts across providers by matching
     email is **not safe** unless the email is provider-verified — an
     unverified match is an account-takeover hole. Not adding before Week 1.

## Requested but not yet built

- Team social media links. ESPN carries some; recent *posts* are not feasible —
  X and Instagram killed free API access and embeds don't work reliably from a
  local file.
- Richer betting features generally — the collaborator's area.
- **NBA shot chart.** Per-shot court coordinates (x/y) were the other
  visualization worth building. Confirm ESPN exposes them before reaching for a
  paid provider — the Drive view is a reminder that ESPN carries more than the
  planning docs assumed. A shot chart doesn't need live data to be good.
- **Post-game EPA analysis.** Drive charts and season-long team/player EPA, framed
  as analysis rather than live. This is the one thing a second provider would
  genuinely add (see Open decisions 1).
- **A custom domain.** Also required for Google's OAuth brand-verification step,
  which currently isn't needed only because the requested scopes are the
  non-sensitive tier (see the Worker section in `CLAUDE.md`).
- **Onboarding.** A new user lands on SCORES with no way to discover pick'em
  exists at all.
- **A privacy policy / ToS.** Needed once usage extends past friends Zach
  personally invited, given the app already handles Google OAuth data.

### Planned, in dependency order — do NOT build all at once

An accounts track was scoped in an 2026-08 planning session. It is **independent
of the data question** and unblocked. Explicitly a learning project for Zach as
much as a product decision, so prefer the real thing over a shortcut:

> **Settled 2026-08-21: OAuth stays, even though it risks the Week 1 date.** Pick'em
> needs to be usable before NFL Week 1 kickoff on 2026-09-09, which means locking
> picks around 09-08 — and as of this date the track is a schema file, with no
> deployed Worker, no auth routes and no frontend. Dropping OAuth for a join code
> plus a display name was offered as the shorter path and **declined**: the learning
> value of doing auth properly is the point, and these are people Zach knows.
> Don't re-propose the shortcut. Do flag slippage early, and note that the Google
> Cloud project and consent screen are Zach-side clicking on the critical path.

1. ~~**Cloudflare D1** (serverless SQLite) as the database.~~ **Done** — the
   `fixtura` database exists and `schema.sql` is applied to it. Free tier is far
   beyond Fixtura's realistic scale (5M row reads/day, 100K writes/day, 5 GB).
2. **OAuth login** — **fully built and live.** Google authorization-code flow,
   sessions in D1, `admin` granted to the first account to sign in, the Google
   Cloud console setup done, secrets set, and the frontend sign-in UI shipped
   in the same session pick'em's UI did (item 4). The consent screen is
   published (not a Testing-mode allow-list), so any Google account can sign
   in — see the Worker section of `CLAUDE.md` for the scope/verification detail.
   Per-user rate limiting is still not built.
3. **Cross-device sync** of favourites/settings — **done, both sides.**
   `GET|PUT /me/settings` on the worker, `pullSettings()`/`pushSettings()` in
   `src/account.js` on the frontend, allow-listed to `SYNC_KEYS`: the account
   wins on load, the device pushes on change, last-write-wins per key on the
   server's clock.
4. **Pick'em** — **fully shipped**, server side (2026-08-22) and the frontend UI
   (`views/pickem.js` — My picks / Everyone / Standings) landed in the same
   session, verified live against real ESPN data and a real second user in a
   real pool. Settled with Zach: **picks lock per game at its own kickoff**,
   and **a pick is hidden from everyone else until that game locks**. Still
   open: **saved dashboard views** and **personal stats** over a season,
   neither started.
   Other modes (`confidence`, `survivor`, `ats`, `golf6`, `f1podium`) are
   deliberately deferred until after Week 1 — `mode` is fixed per pool, so each
   is a new pool and nothing existing changes. `ats` additionally needs the line
   snapshotted at pick time; the odds are already on the scoreboard payload.
   **Testing incident, 2026-08-22:** a smoke-test click overwrote one of Zach's
   own real picks in the live "Moose Group" pool (unrecoverable) because the
   pool wasn't checked for real data before testing against it — see hard-won
   detail 24 in `CLAUDE.md`. Test writes only against a disposable pool now.
5. **Push notifications — someday, explicitly low priority.** iOS Web Push only
   works for a PWA **installed to the home screen**; it will never reach a Safari
   tab. Needs a real `manifest.json` (the current `apple-mobile-web-app-capable`
   meta is not sufficient on modern iOS), a service worker, a per-device
   subscription tied to a user, and a Worker-side send trigger. **This is the one
   roadmap item that breaks the single-file constraint** — a service worker must
   be a separate same-origin file, so it's three files minimum. Make that a
   deliberate decision, not a drift.

**Infrastructure ceiling:** Worker + KV + D1 covers everything above, including a
full betting suite. The only real breakpoint is training a custom EPA/WP model,
which needs Python/ML tooling Workers can't run — and that would be a periodic
offline job shipping its output into the Worker, not a live server. Don't
over-engineer infrastructure ahead of this.

