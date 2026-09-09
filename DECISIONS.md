# Fixtura — decisions and roadmap

Originally split out of `CLAUDE.md` on 2026-08-21. For Codex, operating
instructions now live in `AGENTS.md`; this file remains the decision history and
roadmap. Read later dated updates before relying on an older status statement.
Keep persistent operating rules in `AGENTS.md`, not in the history below.

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
   - **Nothing is watching for errors — half fixed 2026-08-25.** The
     cron-triggered half is **done**: `runHealthCheck()` in `worker/src/index.js`
     runs every 30 minutes (`triggers.crons` in `wrangler.jsonc`), checks D1
     and required secrets the same way `/health` does, and additionally pulls
     an NFL scoreboard and asserts `events[]` is still an array — the more
     likely real failure is picks quietly not saving behind a clean 200
     because ESPN's shape changed, not the Worker crashing outright. It
     throws on a problem so a scheduled-handler error actually exists for a
     dashboard alert to fire on. **Still not done:** the Cloudflare dashboard
     email alert itself (Notifications → Workers) — that half is a Zach-side
     dashboard click-through, same pattern as the OAuth consent screen.
   - **Alternate sign-in providers were evaluated and deliberately deferred.**
     Email magic links (via Cloudflare's email service) are the real fallback
     if Google-only proves too limiting; GitHub is low effort but low value
     for this audience; Apple needs a paid developer account plus a
     self-minted JWT secret. Linking accounts across providers by matching
     email is **not safe** unless the email is provider-verified — an
     unverified match is an account-takeover hole. Not adding before Week 1.

## The redesign + NFL dashboards track (opened 2026-09-07)

A visual overhaul plus NFL statistical dashboards, scoped in a planning session
on 2026-09-07. **Nothing visual is approved.** One piece shipped; everything
else is a draft awaiting Zach's review, and he is taking the design half to
another tool to try implementing the themes.

**Shipped and live:** the leaderboard snapshot cron (`worker/src/trends.js`,
`stat_snapshots`, `GET /trends/leaders`), deployed to production 2026-09-07 and
verified firing. It shipped first and alone because it is the only piece with a
real deadline: ESPN keeps no leaderboard history and snapshots cannot be
backfilled, so every week it does not run is a week lost permanently. See the
Worker section and hard-won details 28–29 in `CLAUDE.md`. **It is deployed from
the `redesign-nfl-dashboards` branch and is not on `main`** — read the deploy
hazard note in `CLAUDE.md` before running `npm run deploy`.

**Draft, nothing approved:** a prototype of the new design language covering all
twelve screens (the seven app views plus five NFL levels) at mobile and desktop,
in seven themes. Built entirely on live ESPN/Jolpica data. It exists only as a
published artifact, not in the repo — see `HANDOFF-REDESIGN.md` for everything
needed to pick the work up, including the palettes.

**Settled with Zach at the outset:**

- Adopt the card/hero editorial language from his reference images, rather than
  refining the current dense data-terminal look. **But** mobile and desktop must
  get genuinely different layouts, not one fluid layout squeezed at 700px.
- An editorial **serif** joins the type system — he specifically wanted the
  "Times New Roman-esque" face from the reference, on some things but not all.
  Numbers stay in Roboto Mono; the serif never touches tabular data.
- **NFL only** for the dashboards. Other sports will need their own splits and
  their own structure — do **not** build a generic multi-sport dashboard
  abstraction and try to make football fit it.

**His feedback on the first prototype, 2026-09-07 — not yet acted on:**

- **Drop the Division dashboard entirely.** Four teams did not earn a view.
- **Probably merge Conference and League** into one view rather than two
  drill levels. This collapses the original five levels toward three
  (league/conference · team · player).
- Approved as "a good draft" only; the content of each page is still open, and
  he wants to walk the remaining views before anything is built.

**Still open, and blocking a real build:**

1. **Which serif** — three candidates were shown live (Newsreader, Source
   Serif 4, Playfair Display); no pick made.
2. **Do `HOME` and `NFL` deserve top-level tabs?** The proposal takes the tab
   row from six views to eight. Both additions are arguable, and `HOME` in
   particular was invented wholesale — the app has never had a landing surface.
3. **Which four tabs are permanent** in a mobile bottom bar, given `VIEW_ORDER`
   is user-reorderable and will hold more views than a bar can show. The
   proposed rule is first four plus a More sheet.
4. **How far the Retro Card theme goes.** A Fixtura theme is a palette; the
   halftone and heavier card edges were added as two extra tokens (`--texture`,
   `--edge`), but the starbursts, ribbons and distressed display type in the
   reference are *illustration*, not colour — making the card language itself
   that loud is a separate decision, not a theme toggle.
5. Seven themes now means **every new colour must exist in all seven** or one
   theme silently breaks. This was already true at five; it is more expensive now.

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
- ~~**Onboarding.**~~ **Half done, 2026-08-25.** A first-visit welcome panel
  (`checkWelcome()` in `app.js`) now points explicitly at PICK'EM, and an
  invite is now a real `?join=CODE` link (`checkJoinLink` logic in
  `initSettings()`, `account.js`) rather than a bare code to retype — it
  routes straight to pick'em and joins automatically once signed in, surviving
  the OAuth redirect via `sb-pk-pendingjoin`. What's still missing: nothing
  tells an *existing* user pick'em now has more modes, or that a specific pool
  they're in switched anything — this only helps a brand-new visitor or a
  fresh invite.
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
   **`confidence` and `survivor` shipped 2026-08-25** — both server (schema,
   `pools.js`) and frontend (`pickem.js`), covered by 150/150 assertions in
   `worker/test.sh` including elimination, confidence-rank swaps, and the
   survivor week-lock (see hard-won detail 27 — the first cut let a losing
   Thursday pick be abandoned on Sunday), and
   the `confidence` column was added to the live D1 via `ALTER TABLE` (not a
   fresh `schema.sql` apply, which would have skipped it — `CREATE TABLE IF
   NOT EXISTS` is a no-op against a table that already exists). Survivor's
   "no team twice, one pick a week" rule has no DB constraint backing it —
   SQLite can't express a partial unique index keyed on another table's
   `pools.mode` — so it's enforced entirely in `pools.js`, the same way
   locking already was. `ats`, `golf6`, and `f1podium` remain deferred —
   `ats` needs the line snapshotted at pick time (the odds are already on the
   scoreboard payload); `golf6`/`f1podium` need "week" reshaped into
   "tournament"/"race", a bigger change than either of the two that shipped.
   **Testing incident, 2026-08-22:** a smoke-test click overwrote one of Zach's
   own real picks in the live "Moose Group" pool (unrecoverable) because the
   pool wasn't checked for real data before testing against it — see hard-won
   detail 24 in `CLAUDE.md`. Test writes only against a disposable pool now.
5. **Push notifications — someday, explicitly low priority.** iOS Web Push only
   works for a PWA **installed to the home screen**; it will never reach a Safari
   tab. Needs a real `manifest.json` (the current `apple-mobile-web-app-capable`
   meta is not sufficient on modern iOS), a service worker, a per-device
   subscription tied to a user, and a Worker-side send trigger.
   The old reasoning here — "breaks the single-file constraint" — is stale as of
   the 2026-08-23 module split; the frontend is already several files, so file
   *count* isn't the obstacle any more (see the hard constraint note in
   `CLAUDE.md`). What actually makes this a bigger lift is that a service worker
   isn't an ES module the page imports — it's a separate script the browser
   registers and runs in its own lifecycle (install/activate/fetch events),
   independent of any page being open, plus a real subscription/send pipeline
   through the Worker. That's genuine new scope, not a constraint violation.
   Still low priority; not started.

**Infrastructure ceiling:** Worker + KV + D1 covers everything above, including a
full betting suite. The only real breakpoint is training a custom EPA/WP model,
which needs Python/ML tooling Workers can't run — and that would be a periodic
offline job shipping its output into the Worker, not a live server. Don't
over-engineer infrastructure ahead of this.



## Codex transition and stats direction — 2026-09-08

Zach is moving active work from Claude Code to Codex, with GPT-5.6 Sol Medium as
the default lead model. `AGENTS.md` is the Codex operating guide, including the
requested Sol/Terra/Luna usage and delegation policy. `CLAUDE.md` is retained as
deleted. The older redesign status above describes the original Claude prototype;
it is superseded by the review progress documented in the handoff's dated update.

**Accepted direction:** expand beyond weekly top-10 snapshots into player-by-game
records and calculate rankings/season totals within Fixtura. Zach explicitly
accepted the stats plan on 2026-09-08. This is approval of the direction, not a
claim that ingestion, migrations, backfills, or production APIs are implemented.

Preserve the existing snapshot capture while extending Worker/D1 storage. Track
source, capture/revision timestamps, season/type, event, player, and team-at-game.
Use stable keys and correction-aware writes. League totals combine team stints;
team rankings use only the player's contribution to that team. Rate stats need
eligibility thresholds and underlying numerators/denominators. Missing coverage
must not appear as zero or a complete ranking. Stored data does not supply
unobserved tracking metrics; additional providers remain a separate evaluation.

**Reviewed UI direction:** collapsible league/team leaders; three-player card
previews opening larger lists of up to 32; an optional one-player-per-team league
view; player selection stays in Fixtura using the existing full player popup when
integrated. News belongs within NFL and Teams. League standings include conference
playoff order/cutoff as well as division grouping. Team schedules need the full
season detail. Retain the existing themes plus the two reviewed additions; Retro
can use more ribbons/starbursts. Header wording remains undecided.

The broader field inventory and staged storage proposal are saved alongside the
Codex preview in `STATS-PLAN.md` (location in the handoff). Next: verify provider
field coverage, then implement and validate a bounded archived-game ingestion
sample before broader capture. The current task changes documentation only.


## Player-by-game foundation — 2026-09-08

Implemented the first bounded archived-data milestone in Worker modules: a 57-field
NFL game-stat catalog, strict final-summary normalization, an additive D1 schema,
and atomic correction-aware event imports. Targets, TFL, QB hits, passes defended,
fumbles and special-teams fields are present in the observed box scores.

Keep game facts separate from weekly leaderboard snapshots and all account/Pick’em
records. Source category namespaces distinguish thrown and defensive interceptions;
raw values and aggregation rules are retained. Missing data stays missing. Coverage
refers to the supplied game box-score structure, not all players or season coverage.

Validated two archived games, parser edge cases, preservation of existing records,
idempotent imports, corrections, concurrent freshness, and D1 rollback. The existing
Worker suite passed 165/165 locally. No remote migration, scheduled capture, public
write endpoint, read API, or frontend connection was enabled. `worker/GAME-STATS.md`
contains the implementation contract, validation commands, and next integration slice.


## Scheduled player-game capture and safe reads — 2026-09-08

The next local slice is implemented. The existing scheduled handler now runs a
separate bounded NFL game capture task alongside health and weekly leaderboard
snapshots. It scans current/previous regular- or postseason weeks, imports at most
eight completed games per run, tracks discovery/retries, and revisits captures for
corrections. A second additive migration stores operational capture state.

Public D1 endpoints now expose discovered-final coverage and retained player game
logs. Coverage wording is deliberately narrow; league/team rankings remain deferred
until an audited backfill proves the requested period is complete. No public write
endpoint or frontend connection was added.

This remains local only. Both D1 migrations must be applied in order before a
Worker deployment, and the documented trends-route branch hazard must be checked.
The next accepted implementation step is a disposable archived-week backfill and
reconciliation audit, then aggregation/ranking APIs if coverage passes.


## Archived-week audit clears total-stat aggregation — 2026-09-08

The 2025 regular-season Week 1 local audit imported all 16 scoreboard finals into
the disposable stats database with no failures, partial captures, or event-ID
differences. It retained 1,006 player-game rows and 7,979 numeric cells across all
57 normalized fields. All 247 available comparisons against semantically matching
team totals agreed exactly.

Nine fumbles-lost comparisons were unavailable because the team box score reported
zero while ESPN omitted individual fumble rows. This confirms the existing rule:
do not invent per-player zero cells. Interception-return, fumble, and punt-return
rows are event-driven and legitimately sparse.

Decision: proceed with league/team aggregation for additive total statistics, but
include audited coverage in responses. Rate statistics remain blocked on explicit
qualification and numerator/denominator formulas. This audit was local only and
does not authorize or imply a remote migration, backfill, or deployment.


## Total-stat rankings may proceed; rate rankings remain gated — 2026-09-09

The local stats API now ranks fields defined as additive totals or season maxima.
League rankings combine a player's team stints; team rankings use only that team's
contribution. Competition ties retain shared ranks. The optional one-player-per-team
view chooses each team's best contribution before ranking the representatives.

Every response carries discovered-final coverage and explicitly avoids claiming
that discovered games equal a complete schedule. Recomputed rates and provider-only
ratings are rejected until qualification and numerator/denominator rules are
defined. Real Week 1 data and local D1 route tests passed. No remote migration or
deployment was performed.


## Qualified recomputed rate rankings — 2026-09-09

Rate rankings must be calculated from summed player-game numerators and
denominators, never from an average of provider game-level rates. The first
supported set is passing yards per attempt, rushing yards per carry, receiving
yards per reception, kickoff-return average, punt-return average, gross punting
average, and field-goal percentage.

Use the NFL's 2025 Guide for Statisticians full-season minimums for pass attempts,
carries, receptions, punts, and returns. For an in-season Fixtura view, prorate the
published minimum from its 16-game pace based on the represented team's captured
game count and cap it at the published full-season minimum. Expose that derivation
and all qualification inputs in the response. This is a Fixtura live-view rule
derived from the published season standard, not a claim that the NFL guide defines
weekly qualification.

For a combined league row after a trade, use the player's latest represented team
to determine the live threshold. Team and one-player-per-team rows use that team's
game count. Exclude unqualified candidates before selecting each team's
representative. The NFL guide does not publish a field-goal-percentage minimum, so
label that qualification source `none_published` and require only a positive
attempt denominator. Adjusted QBR and provider passer rating stay unavailable.

This behavior is implemented and verified locally. It does not authorize a remote
migration, archived production backfill, Worker deployment, or frontend release.


## Player-game stats production release — 2026-09-09

Zach explicitly authorized applying both additive stats migrations and deploying
the reviewed Worker commit. Migrations `0001` and `0002` were applied in order,
then commit `7ae8141` was deployed as Worker version
`0fed0268-a8b5-409c-9136-f297ffc2c697`. Production smoke checks passed while the
existing trends route, account privacy, Pick'em records, CORS, and caching behavior
remained intact.

The release authorizes the bounded scheduled capture and public read APIs already
described. It does not authorize an archived production backfill, schema expansion,
provider change, QBR derivation, or frontend release.
