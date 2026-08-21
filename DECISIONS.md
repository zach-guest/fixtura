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

2. **Proxy or not — still not needed, and the live-data argument for it is gone.**
   `worker/` is ready but undeployed, and nothing on the live-data path requires
   it: ESPN is keyless and CORS-open. It becomes necessary the moment a **keyed**
   provider is added — EPA or odds — since a key in a public static file is a
   public key. It also solves rate limits via edge caching (30s scores, 15min F1,
   24h team lists). The frontend change is three constants. Deploy when odds work
   starts, not before.
   Two cleanups to do *before* it ever ships: `ALLOWED_ORIGINS` still contains the
   placeholder `YOURUSERNAME`, and there's a `score` route pointed at
   `api.thescore.com` that was never CORS-verified — cut it unless it's validated.

3. **localStorage vs accounts.** Stay on localStorage. Optionally add a "sync
   code" (Cloudflare KV, ~30 lines, no login) for cross-device. Build real
   accounts only when a feature genuinely requires identity — social betting
   would. Do not build auth preemptively.

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

1. **Cloudflare D1** (serverless SQLite) as the database. Free tier is far beyond
   Fixtura's realistic scale (5M row reads/day, 100K writes/day, 5 GB).
2. **OAuth login** (Google/GitHub) rather than storing password hashes — an
   explicit preference, since these are people he knows personally. Then auth
   roles (admin vs regular) and per-user rate limiting.
3. **Cross-device sync** of favourites/settings — the original motivating use
   case, and what replaces `localStorage`-only persistence.
4. **Saved dashboard views**, then **pick'em** (per-user predictions scored over a
   season — high interest), then **personal stats** over a season.
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

