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


## NFL and college-football EPA become explicit planning goals — 2026-09-09

Zach wants Fixtura to track expected points added (EPA) for both NFL and college
football. The desired granularity and final UI placement are still open, so this
is a product-direction decision rather than authorization for a provider
integration, migration, backfill, deployment, or frontend release.

Current research recommends nflverse processed play-by-play for NFL and
SportsDataverse/cfbfastR's ESPN-derived college pipeline for CFB, both as postgame
sources. The preferred CFB compiled release currently lists seasons only through
2025, so a 2026 source/contract spike must select between a newly available season
asset, enriched per-game final JSON, or locally processed cfbfastR output; no
silent source fallback is approved. NFL and CFB retain separate model contracts,
storage, routes, coverage, and rankings.

For both leagues, the proposed storage is hybrid: slim play rows for
auditability/future analysis plus materialized team-game and selected player-game
summaries for bounded D1 reads. The first player scope should be quarterbacks and
designed rushers; receiver and individual defensive attribution remain unresolved.
ESPN win probability stays the live metric and must not be labeled EPA. The full
proposed architecture, definitions, phased delivery, release gates, and first
implementation-ready tasks are in `NFL-IMPLEMENTATION-PLAN.md`.


## First NFL leader surfaces — 2026-09-09

The initial league leaderboard lives inside the existing NFL Scores view. NFL team
leaderboards live in a Stats tab placed after Schedule and Roster. This is the
smallest integration that delivers the approved aggregation behavior without
settling the still-open main-navigation shape for a dedicated NFL hub. Both use one
shared component so they can be repositioned later.

Leader sections start collapsed and fetch only when opened. Offense is the default;
Defense and All are explicit filters. Cards show three players and open a list of
up to 32. The league list alone offers one player per team. Player selection always
opens Fixtura's existing player popup. Missing or not-yet-captured data is described
honestly with discovered-final coverage and is never rendered as a zero ranking.

Broadsheet and Retro Card join the existing five themes. Retro may use the approved
starburst, ribbon, texture, and bolder card geometry, but no motto is committed yet.
New display headings omit terminal periods. The current integration does not add
news, redesign standings or schedules, or establish a separate NFL navigation tab.


## NFL is a top-level dashboard — 2026-09-09

Zach explicitly decided the league leader dashboard does not belong in Scores.
The NFL view is now a top-level, user-configurable tab with Overview, Standings,
and News sections. Scores returns to games only. This supersedes the temporary
placement described in “First NFL leader surfaces” above and settles the earlier
open question about whether NFL deserves a top-level tab. It does not settle a
separate Home dashboard or the eventual mobile bottom-bar composition.

NFL standings show both full conference order and division groupings. A playoff
cutoff is drawn only from a complete set of ESPN-published seeds; Fixtura does not
simulate official seeds from record because it does not yet implement every NFL
tiebreaker. The active season is the default, and the completed prior season is
available so the official division-winner and wild-card boundaries remain useful
before current-year seeds are published.

## Broadsheet is the default theme; its type system now spans the whole app — 2026-09-09

Zach decided Broadsheet — not Paper — is the default theme for new/cleared
installs, and that the editorial serif treatment built for the NFL dashboard
should read consistently everywhere, not just on that one screen. Implemented
by Claude Code:

- `index.html`'s pre-JS `data-theme` and the `sb-theme` fallback in `src/app.js`
  changed from `paper` to `broadsheet`. This only affects installs with no
  stored `sb-theme` — anyone who already has a saved theme preference (including
  an explicit `paper`) keeps it; nothing overwrites an existing choice.
- Five headline elements that were hardcoded to `'Barlow Condensed',sans-serif`
  now read `var(--display)` instead: `header h1` (app title), `.daylabel`
  (Scores day/week header), `.teamhero h2` (team page name), `.mteam .n`
  (game-modal matchup team names), `.phero h2` (player-modal name). This is
  wiring, not new design — `--editorial`/`--display` already existed as theme
  tokens for exactly this, and the dashboard components already used them;
  these just hadn't been hooked up. Every non-Broadsheet theme's base rule
  still resolves `--display` to Barlow Condensed, so Paper/Midnight/Ice/
  Terminal/Crimson/Retro Card are visually unchanged — only Broadsheet's
  Newsreader serif now flows through the whole app instead of stopping at the
  NFL dashboard. Numbers/data stay in Roboto Mono throughout; none of these
  are tabular values.
- **`nav.views button` (the top tab row — SCORES/TEAMS/NFL/…) deliberately did
  not get this treatment**, after Zach reviewed it live: the serif read wrong
  on tab labels specifically, and he wants those to match the plain sans-serif
  already used by the NFL dashboard's own Overview/Standings/News sub-tabs
  (`.dash-tab`, unstyled, inherits body `Inter`). Changed to explicit
  `Inter,-apple-system,sans-serif` rather than left on the old Barlow Condensed,
  so it now matches `.dash-tab` exactly rather than matching it by coincidence.
  The rule this establishes: the serif is for **headline/title text**
  (app name, page titles, names), not for **navigation/tab labels** — apply
  that distinction to any future element, don't default to serif everywhere.
- Retro Card's own look (starbursts, ribbons, texture, how loud it gets, its
  motto) was deliberately **not touched** — Zach wants that theme's design work
  done on the Codex/ChatGPT side, since it's still open per item 4 in "Open
  decisions" above and is closer to illustration than typography wiring.

Not done in this pass: a design review of whether any *other* elements (e.g.
settings-panel labels, ticker) should also move to `var(--display)` — the six
above were the clear, unambiguous headline candidates. Revisit if more of the
app still reads as mismatched once this is seen live.

**Follow-up fix, same day:** the `header h1` rule above had no visible effect —
Zach checked after a hard refresh and the FIXTURA logo was still sans-serif.
Not a caching issue (the first guess): `index.html`'s `<h1 class="cond">` was
also matched by `.cond{font-family:'Barlow Condensed',...}`, a single-class
selector, and CSS specificity ranks a lone class *above* the two-element
selector `header h1` regardless of source order — so `.cond` silently won.
Fixed by dropping `class="cond"` from that one `<h1>`, since `header h1`
already carries the theme-aware token and the class was now redundant-and-wrong
rather than redundant-and-harmless. The other five elements changed above were
checked against the same failure mode and don't have it — `.teamhero h2` and
`.phero h2` also render through elements that carry `class="cond"` in
`teams.js`/`f1.js`/`modal.js`, but a class-plus-element selector (`.teamhero
h2`) outranks a lone class, so those two were never actually broken by this.


## CFB EPA source selected; NFL source confirmed — 2026-09-09

Phase C0 and Phase N0 of `NFL-IMPLEMENTATION-PLAN.md` ran as offline source and
contract spikes. This settles open item 8 ("select the canonical ongoing CFB
source after Phase C0") and confirms items 9 and 10. It authorizes no
migration, route, deploy, backfill, or frontend work.

**The canonical CFB source is the compiled `espn_cfb_pbp` season Parquet** from
SportsDataverse. The plan's central worry did not survive contact: the 2026
asset exists and is rebuilt daily (observed `play_by_play_2026.parquet`,
4.7 MB, updated 2026-09-09T15:11:59Z, with a machine-readable
`timestamp.json`). Its `game_id` is the ESPN event id and its player id columns
are ESPN athlete ids, so college needs no crosswalk and no name matching. Its
scope matches Fixtura's `groups=80` coverage rule exactly — all 97 of its
week-1 games are inside ESPN's 99 `groups=80` finals, with zero games outside.

Neither documented fallback was selected. The per-game enriched final JSON is
**not an independent source**: it is the same upstream capture, reconciles
exactly with the Parquet (identical EPA to four decimals on a complete game),
and shares its staleness. Running cfbfastR locally could not be evaluated at
all because R is not installed on this machine, so that path is unexecuted
rather than rejected. No automatic source switching is implemented.

**The gate is completeness, and it is part of the design rather than a
validation detail.** The current-season asset contains ESPN finals whose
capture was taken mid-game and never re-taken: 53 of 99 week-1 finals were
importable, 44 were present but truncated, and 2 were absent — measured three
to eleven days after the games. Truncated games carry real EPA for the plays
they hold, so they read as low-scoring games rather than as errors.
`status_type_completed` identifies them exactly and is the only safe gate; play
count is not a proxy, because one truncated game held 179 rows and a complete
game held 161. Complete, truncated, and missing are three distinct coverage
states and must stay distinct in storage and in every API response.

This is current-season lag, not a broken source: the 2025 season is 956 of 956
complete. Whether a truncated game heals in days or only at a season-end
rebuild is **not yet known**, so the scheduled job's recheck window is not
fixed at "the previous two weeks" until that is observed.

**NFL stays on nflverse processed play-by-play**, unchanged. Identity is exact
in both directions: all 272 2025 regular-season games carry a unique `espn` id,
and all 345 distinct 2025 passers and rushers crosswalk from GSIS to an ESPN
athlete id with no duplicates and no unmatched ids. The 2026 asset is correctly
a 404 before kickoff, which is the same "published later than the scoreboard
claims" shape as hard-won detail 28 and must be a quiet skip.

Two contract points that constrain the schema:

- **All ids are TEXT.** The largest observed CFB play id is
  401858212104999901, four orders of magnitude past JavaScript's
  `Number.MAX_SAFE_INTEGER`. As a JSON number it would round silently in both
  the Worker and the browser.
- **NFL and CFB keep separate payload shapes and separate predicates.** NFL QB
  rows aggregate nflverse `qb_epa`; college has no equivalent, so CFB passer
  rows aggregate play EPA and carry an explicit `epa_basis`. The two are not
  comparable even in principle. A team's dropback count is also not a
  quarterback's dropback count, and the payload keeps both.

Measured sizes for the storage decision: one CFB season is ~125,700 qualifying
plays (~85–95 MB of JSON), one NFL season ~36,100 (~20 MB). Play `description`
is about 20% of a row, which makes storing it a real schema choice. D1 row
storage still has to be measured against a local database in Phase 1.

Known untested: the **CFB overtime path**, because the source contains no
overtime game — the one known week-1 overtime final is among the two games
missing entirely. It must be verified against a real overtime game before the
college UI ships.

Full evidence, exact commands, source URLs, and proposed payload shapes are in
`worker/scripts/epa/README.md`.


## EPA spike accepted; storage contract settled — 2026-09-09

Zach reviewed the Phase C0/N0 diff and **accepted the spike**. The tooling in
`worker/scripts/epa/` stands as the source-and-contract record, and the
following are now settled rather than open. This authorizes Phase 1 design and
**local** schema work only — no remote migration, no deploy, no frontend.

1. **Store play `description` from the start.** The initial compact-JSON estimate
   put it near 20% of a serialized row; the Phase 1 `dbstat` measurement replaced
   that estimate with 41–47% of the plays table and 30% of total projected EPA
   storage, or 34.7 MB of the 116 MB 2025+2026 projection. Impact-play
   explanations in Game Center are a first-class surface rather than a maybe.
   Dropping it later is a cheap column drop; adding it later means re-downloading
   and reprocessing a season, which is exactly the re-work the hybrid storage
   model exists to avoid.
2. **Backfill 2025 and 2026 only.** Not older history. This bounds the database
   to roughly two CFB seasons plus two NFL seasons at first import and keeps
   the free-tier 500 MB ceiling comfortable while real numbers are observed.
   Older seasons stay available upstream and can be added deliberately later;
   they are not lost by waiting.
3. **Keep the 11 source-qualified penalty-no-play records, with their audit
   flag.** The source assigned them EPA and classified them as scrimmage plays,
   and the values are consistent with the penalty being enforced (a nullified
   63-yard touchdown carries EPA −1.10). Fixtura does not overrule the model it
   is importing. `is_penalty_no_play` is retained per play so the decision is
   auditable and reversible from stored data rather than requiring a re-import.
4. **Retain the documented CFB spike behavior.** Three spikes in week 1 qualify
   because the college schema has no spike flag, where the NFL predicate
   excludes spikes explicitly. At 0.03% of plays this changes nothing
   measurable, and the only available "fix" would be pattern-matching
   description text. It stays a recorded league divergence, not a guess. If it
   ever needs fixing, the source is asked for a flag.
5. **NFL and CFB keep separate payload shapes, tables, routes and predicates.**
   Confirmed, not merged later as a tidy-up. The leagues have different models,
   different identity spaces and different taxonomies — NFL QB rows aggregate
   nflverse `qb_epa` while CFB passer rows can only aggregate play EPA, so the
   numbers are not comparable even in principle.

**Public CFB release stays gated on attribution and data-term review.** The
SportsDataverse code licences are permissive but the data derives from ESPN;
the applicable data terms and the exact attribution wording are unresolved.
Local storage, local routes and local testing may proceed; shipping CFB EPA to
the live site may not until that review is done. NFL is not blocked by this —
nflverse data is CC BY 4.0 and the attribution requirement is understood.

**Coverage re-measured the same evening** (~13.5 hours after the first
measurement): the 2026 asset was byte-identical, same sha256, so week-1
coverage is unchanged at 53 of 99. The source had not republished in between,
so this is **not** evidence about whether truncated games heal — that question
stays open and still needs a measurement taken after an actual upstream
rebuild.


## EPA contract-correction decisions — 2026-09-10

Made while bringing Phase 2 into line with the accepted contract in
`NFL-IMPLEMENTATION-PLAN.md`. Each is a choice that could reasonably have gone
another way, so each is recorded rather than left in a diff.

1. **The EPA routes use the contract's camelCase keys**, unlike the older
   `/stats/nfl/...` routes, which are snake_case. The contract specifies an
   exact response shape (`eventId`, `homeAway`, `epaPerPlay`, `coverage
   .eligiblePlays`, `provenance.responseVersion`) and the frontend slice was
   designed against it. The inconsistency is real but confined to the EPA tree,
   and matching the spec beats matching the neighbours.

2. **NFL drive yards are null, permanently, not "pending".** nflverse
   publishes no drive net-yards field; it has `drive_start_yard_line` /
   `drive_end_yard_line` as text (`"MIN 25"`). Subtracting those is a
   field-position inference the contract forbids, and it would be wrong on any
   drive containing a penalty or a change of possession. The API returns null
   and the response carries a warning explaining why. CFB has a real
   `drive.yards` and uses it.

3. **Defensive success rate ranks ascending; every other EPA metric ranks
   descending.** Defensive EPA is stored already negated, so higher is better
   and descending is right. Defensive success rate is *not* negated — it is the
   share of opponent plays that succeeded — so lower is better. Sorting it
   descending would rank the worst defence first, which is the kind of error
   nobody notices for a season. The chosen `direction` and `better` are
   returned in the response rather than left implicit.

4. **A team with no value for the chosen metric gets `rank: null` and sorts
   last**, in both directions. Treating a missing rate as zero would make an
   unplayed team either the best defence or the worst offence.

5. **`schema.sql` is the repeat-safe canonical schema; `0005` is the one-time
   migration. These are different artifacts with different properties, and
   conflating them is what made the first version of this wrong.**

   - **`schema.sql`** describes the final state of a database created from
     nothing. Every statement is `CREATE ... IF NOT EXISTS`, including the
     drive tables, and the columns `0005` adds are written inline at the end of
     their tables. Applying it twice is a no-op, so `npm run db:schema:local`
     stays safe to re-run.
   - **`migrations/0005_epa_drives_and_coverage.sql`** exists only for a
     database that already carries `0003`/`0004`. It uses
     `ALTER TABLE ... ADD COLUMN`, which SQLite cannot express conditionally,
     so it is **not** repeat-safe and must be applied exactly once per
     database. **Migration tracking is what prevents a second application** —
     the failure on a re-run is a backstop, not the mechanism.

   The inline columns sit after the last column and before any table
   constraint, which is where `ALTER TABLE` places them, so both routes produce
   byte-identical table definitions. A test proves all four properties:
   `schema.sql` applies twice; `0003`+`0004`+`0005`-once matches fresh
   `schema.sql` at pragma level across all 24 tables; account, pool, pick,
   snapshot and EPA rows survive `0005` with the new columns NULL; and `0005`
   run twice still fails on a duplicate column.

   This matters because of hard-won detail 26: `CREATE TABLE IF NOT EXISTS`
   silently does *not* add a column to a table that already exists, so a
   canonical schema alone can never migrate an existing database, and a
   migration alone is a poor description of the final state. Both are needed.

6. **New columns are nullable with no default.** A `DEFAULT 0` on
   `def_pass_success_allowed` would assert that pre-existing rows had zero
   split successes, which is a claim about data nobody measured. Null means
   unknown; the import path always writes a real value.

7. **The Pick'em integration tests read deterministic fixtures, not the live
   scoreboard.** `ESPN_SCOREBOARD_BASE` overrides the scoreboard host and is
   unset in production and in `npm run dev`; `npm run dev:test` points it at
   `test/fixtures/scoreboard-server.mjs`. The suite asserts exact lock states
   ("none locked yet", "every game reads as locked"), which made it a function
   of the calendar: it passed only while the chosen NFL week had no started
   games and began failing the moment Week 1 2026 kicked off. Choosing a later
   "future" week only moves the expiry date, so the date dependency was removed
   instead. `/health` reports `scoreboard_override` as a boolean so a test can
   refuse to run against live data by accident. **The Worker remains the
   authority on kickoff, eligibility and results — only the address it reads
   changes.**

8. **Storage projection updated.** Drive rows add about 9 MB across the
   approved 2025+2026 backfill: **125.5 MB** total, up from 116.1 MB, still
   about 25% of the 500 MB free tier. Measured, not estimated.


## EPA Phase 3 ingestion decisions — 2026-09-10

Made while building the scheduled pipeline. The first two are data findings
that changed the contract; the rest are operating choices.

1. **Drive coverage is measured against what the model was in scope to score,
   not against the provider's play count.** Measured on nflverse 2025:
   `drive_play_count` **excludes accepted-penalty plays**, while the qualifying
   predicate deliberately keeps them, so our modeled count exceeds the
   provider's on **18.1% of drives** (1,041 of 5,745). The first version
   rejected exactly that shape and refused every real NFL week; a
   "complete means modeled == provider" rule would have marked a fifth of the
   league partial for no real reason. The two counts measure different things,
   both are stored, and neither substitutes for the other. A drive is
   `complete` when every play in scope for the model actually scored.

2. **Provider sentinel values become null, because that is what they mean.**
   The college source writes `0` where a field does not apply — 5 qualifying
   plays carry `down = 0` and 20 drives carry `end period = 0` — and uses
   **negative athlete ids** for unidentified participants (5 qualifying plays
   in 2026 week 1). Zero is not a real down, and a negative id is not an ESPN
   athlete id and can never link to a player. Both become null. The play and
   its EPA are kept; only the attribution is absent, which is the honest
   reading. Storing `0` would render as "0th down"; storing a negative id would
   create a player row that can never resolve.

3. **The CFB truncated-game recheck window stays unresolved and configurable.**
   `--recheck-weeks` is unset by default, which means a season run revisits
   *every* week that still has an incomplete game — bounded by the season, and
   the conservative choice while the upstream healing behaviour is unmeasured
   (handoff §26). A fixed "previous two weeks" would silently stop retrying a
   game that heals on day twelve. Every report records which policy was used.

4. **The import token is read from the environment, never a flag**, so it
   cannot land in a shell history or a process listing. With it unset the
   runner refuses to upload and exits 2, rather than silently doing nothing.

5. **A 4xx is never retried; 429 and 5xx and network failures are, four times
   with exponential backoff.** A rejected payload is a contract failure and
   repeating it helps nobody. A 207 is a partial success: reported per game,
   not retried.

6. **Batches are bounded by count *and* bytes** (8 games / 2 MB against the
   Worker's 40 / 4 MB limits). A college game is roughly 100 KB, so 40 would
   sit on the body limit and one unusually long game could tip a batch over it.

7. **Exit code 3 means "nothing to ingest" and the workflow treats it as
   success.** An unpublished season asset before kickoff is the normal state of
   the world and must not page anyone — the same reasoning as hard-won detail
   28.

8. **The workflow is gated off by a repository variable
   (`EPA_INGEST_ENABLED`).** The file can exist in the repository without
   starting to write to production the moment it is pushed. Manual runs default
   to `dry_run: true`. NFL and CFB are independent jobs with no `needs:`
   between them: different upstreams, different publication windows, different
   failure modes, and a stale college source must not stop the NFL import.

## Fantasy integration decisions — 2026-09-10

1. **ESPN uses a manual roster-and-rules import unless ESPN later provides an
   approved integration path.** Fixtura will not request or store `espn_s2`,
   `SWID`, or other ESPN browser-session credentials, and will not ship against
   undocumented ESPN fantasy endpoints. The manual import is a versioned CSV
   roster plus a guided rules form. It is always labeled `Manual import` with an
   as-of date. Fixtura may keep live NFL game, player-stat and EPA enrichment
   current, but it must not represent ESPN lineups, transactions, matchup scores
   or official fantasy points as current between imports. A replacement import
   is validated and applied atomically; missing fantasy values remain absent,
   never zero. The implementation sequence and contract are in
   `FANTASY-INTEGRATION-PLAN.md`.
