# Handoff — redesign + NFL dashboards

**Current status — 2026-09-22:** see §32 first: the EPA work and a Pick'em
hotfix that was deployed before being committed are now committed and merged to
`main` (pushed 2026-09-22). What follows is the
2026-09-09 status.

**Status — 2026-09-09:** Zach reviewed the batch in §20–22 locally
(Broadsheet default, the app-wide type-system change with two live-reviewed
corrections, the NFL News tab, the detailed NFL team Schedule tab, and
per-team news) and asked to deploy it. Pushed to `main`/`origin/main` as commit
`b89714c` and confirmed live on GitHub Pages (polled until the served ETag and
`data-theme` changed; the deploy took about 40 seconds to propagate).
Production spot-checks after the deploy: default theme is `broadsheet`, the
FIXTURA `<h1>` no longer carries the stray `.cond` class, `nav.views button`
serves the corrected sans-serif rule, and both the News tab and team Schedule
code are present in the served JS. The Worker (untouched by this deploy) is
still healthy. §23 records a direct production check of the capture systems
made ahead of tonight's real Week 1 kickoff, plus four open items found while
checking (one pool-membership note, two operational TODOs, and confirmation
that the historical branch-deploy hazard does not currently apply) — read it
before assuming those are resolved. **Zach is taking the next planning round
— the still-open redesign decisions listed at the end of §23 — to Codex/
ChatGPT rather than deciding them in this session; nothing past this point was
decided here.** §24 records the EPA planning round and §25 the EPA
source-and-contract spike that ran against it: the college source is now
selected on measured evidence, and the constraint turned out to be current-season
coverage rather than asset availability. §26 records the accepted
spike and Phase 1; §27 records Phase 2 — Worker validation, storage and routes,
all local, with the 12 remaining `test.sh` failures proven pre-existing against
a pristine worktree. §28 is the Phase 2 contract-correction pass, which brings the EPA routes onto
the accepted contract, adds provider drive data, fixes the split-denominator
bug, and rebuilds the Pick'em harness on deterministic fixtures so the suite is
fully green (244/244). §29 separates the repeat-safe canonical `schema.sql` from the
one-time `0005` migration and proves both routes agree. §30 is Phase 3 — the scheduled ingestion
pipeline, built and proven locally with a byte-reproducible archived-season dry
run, and gated off until someone enables it. §30 carries the current tree state
and the exact next task, which is the production release and needs explicit
authorization. §31 records the separate fantasy integration plan and the accepted
manual-import path for ESPN; it does not change §30's next task. Sections 17–19
contain the prior implementation and release record. Older sections preserve the
original Claude handoff and historical status.

The original sections were written 2026-09-07 at the end of the planning/prototype
session that opened this track. Their facts and decisions reflect that date; the
prototype had not yet been approved. Later dated sections record the visual work
that has since shipped.

Read `AGENTS.md` first for current operating instructions, including the shared
Codex/Claude continuity protocol; this document does not repeat them. The short
version of the rules that bite hardest:
**no build step, no bundler, no framework, no npm at runtime**, ES modules loaded
as static files, one flat stylesheet, `esc()` on every string rendered into HTML,
and **no invented data** — if ESPN doesn't publish it, don't model it.

---

## 1. Where the work actually stands

| Piece | State |
|---|---|
| Leaderboard snapshot cron | **Shipped, deployed, verified in production** |
| Player-by-game capture and reads | **Shipped, deployed, verified in production** |
| NFL dashboard and two new themes | **Shipped to GitHub Pages from `main`** |
| Next product slice | Contextual NFL/team news, then detailed team schedule |
| Repo branch | `main`, aligned with `origin/main` |

### Historical Worker branch hazard — resolved, still verify before deployment

`wrangler deploy` ships the working directory and knows nothing about branches.
On 2026-09-07, `worker/src/trends.js` was running in production but existed only
on `redesign-nfl-dashboards`. That branch was fast-forwarded into `main` on
2026-09-09, so the immediate mismatch is resolved. Before any future Worker
deployment, still verify that the outgoing tree contains the trends route,
player-game capture, schema, and scheduled wiring.

This matters more than a normal revert because **snapshots cannot be
backfilled** (see §3). Weeks missed are gone permanently.

---

## 2. What shipped, and why it shipped first

`worker/src/trends.js` + the `stat_snapshots` table + `GET /trends/leaders`,
captured weekly by the existing 30-minute cron in `worker/src/index.js`.

It jumped the queue because it is the only piece with a real deadline. NFL Week 1
was 2026-09-09, two days after this was written, and leaderboard history can only
be recorded as it happens.

It is a **third response shape** in a worker whose whole file layout exists to
keep two lanes apart: public and cacheable like the proxy lane, but served from
D1 rather than an upstream. `LOCAL_PUBLIC_PREFIXES` in `index.js` keeps it
provably disjoint from both the proxy routes and the private prefixes. Don't
collapse it into `proxy.js` — there is nothing upstream to proxy.

`worker/test.sh` covers it: 165 assertions, all passing as of the commit.

---

## 3. ESPN reality — verified 2026-09-07, don't re-derive

### What works

| Need | Endpoint |
|---|---|
| Standings, 3 levels | `site.api.espn.com/apis/v2/sports/football/nfl/standings?level=3` |
| League leaders | `sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/types/2/leaders` |
| Team season stats | `.../seasons/{yr}/types/2/teams/{id}/statistics` — **carries league rank** (`rankDisplayValue`: "3rd", "Tied-22nd") |
| Player season stats | `.../seasons/{yr}/types/2/athletes/{id}/statistics/0` |
| Player per-game | `site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{id}/gamelog` |
| News + real photos | `site.api.espn.com/apis/site/v2/sports/football/nfl/news` — 600×400 images, CORS `*` |
| Headshots | `a.espncdn.com/i/headshots/nfl/players/full/{id}.png` |
| A past week's games | `scoreboard?seasontype=2&week=N&dates=YYYY` |

`?level=3` on standings is **required** — without it you get conferences only,
no divisions.

### What does not work, and one trap

- `.../seasons/{y}/types/2/weeks/{n}/leaders` → **404**. No week-scoped leaders.
- `standings?season=2025&week=N` → **the `week` param is accepted and ignored.**
  Weeks 3, 8 and 15 return byte-identical *final* records. It returns 200 with
  plausible data, so anything built on it looks correct and is wrong all season.
- **A season reports as live before its stat endpoints exist.** On 2026-09-07 the
  scoreboard already said season 2026 / type 2 / week 1 while the 2026 leaders
  endpoint was a 404. Treat a 4xx from a season-scoped stat endpoint as "not
  published yet" and skip quietly; only 5xx deserves to throw.

### The consequence for "trends"

- **Standings/seed movement needs no storage** — accumulate
  `scoreboard?seasontype=2&week=N` across weeks and compute it.
- **Leaderboard movement needs storage** — hence the cron. There is no other way.
- For a *finished* season you can back-compute leader movement from per-player
  game logs (this is what the prototype does). That trick does not work live.

---

## 4. Decisions Zach actually made

- **Adopt the card/hero editorial language** from his reference images, not a
  refinement of the current dense data-terminal look.
- **Mobile and desktop get genuinely different layouts** — not one fluid layout
  squeezed at a breakpoint. He was explicit: "ensure that mobile has a view that
  fits them and desktop has a view that fits it."
- **An editorial serif joins the type system.** He liked the "Times New
  Roman-esque" face in the reference, "doesn't need to all be that but definitely
  some." Numbers stay Roboto Mono; the serif must never touch tabular data.
- **NFL only.** Other sports get their own splits and their own structure. Do
  **not** build a generic multi-sport dashboard abstraction — this is why
  `trends.js` is deliberately NFL-specific rather than parameterised.
- **Drop the Division dashboard.** Four teams didn't earn a view.
- **Probably merge Conference and League** into one view. That takes the original
  five levels down toward three: league/conference · team · player.

## 5. Still open — do not guess these

1. **Which serif.** Newsreader, Source Serif 4, and Playfair Display were shown
   live; no pick made.
2. **Do `HOME` and `NFL` deserve top-level tabs?** Takes the row from six views
   to eight. `HOME` was invented wholesale — the app has never had a landing
   surface, it opens into Scores.
3. **Which four tabs are permanent** in a mobile bottom bar. `VIEW_ORDER` is
   user-reorderable and holds more views than a bar fits; proposed rule is first
   four plus a More sheet.
4. **How loud Retro Card gets** — see §6.
5. **The content of every page.** Zach's words: "idk if I am good with what is on
   each page yet." Treat the prototype's page contents as a starting proposal.

---

## 6. The two new themes

Both are drawn from Zach's reference images. A Fixtura theme is a set of CSS
custom properties on `html[data-theme=...]` at the top of `styles.css`; adding
these takes the set from five to seven, and **every colour must then exist in all
seven or one theme silently breaks.**

**Broadsheet** — white ground, one strong blue, black serif headlines, lots of air.

```
--bg:#f6f8fa; --panel:#ffffff; --panel-2:#eef2f7; --line:#dce3eb; --line-soft:#eaeff5;
--accent:#1d4ed8; --accent-dim:#1e3a8a; --accent-2:#0f172a; --on-accent:#ffffff;
--text:#0b1220; --dim:#4b5768; --dim-2:#7d8899;
--live:#dc2626; --win:#15803d; --loss:#dc2626;
```

**Retro Card** — aged newsprint, navy and red with a gold highlight.

```
--bg:#ece2cd; --panel:#f8f2e2; --panel-2:#e2d5b8; --line:#c0ae8b; --line-soft:#d8caa9;
--accent:#c8322b; --accent-dim:#16386b; --accent-2:#f2b829; --on-accent:#fff7e9;
--text:#17130f; --dim:#5c5140; --dim-2:#877a5c;
--live:#c8322b; --win:#1c6b3f; --loss:#c8322b;
--texture:radial-gradient(circle at 1px 1px, rgba(23,19,15,.10) 1px, transparent 0);
--texture-size:6px 6px; --edge:2px;
```

Two new tokens make Retro work without touching the other themes: `--texture`
(a halftone applied as a background image) and `--edge` (heavier card borders).
Every other theme sets `--texture:none` and `--edge:1px`.

**The honest limit:** a palette is all a theme can carry. The starbursts, ribbon
banners and distressed outlined display type in the reference are *illustration*,
not colour. Making the card language itself that loud is a separate design
decision affecting every component in every theme — not something a theme toggle
delivers. **This is open decision #4 and should be settled before anyone builds
toward it.**

---

## 7. The prototype

Published artifact — twelve screens (seven app views plus five NFL levels) at
390px and 1180px, in all seven themes, with a live serif switcher. Every value in
it is real ESPN/Jolpica data, including week-over-week leader movement
back-computed from game logs.

It is a **communication artifact, not source to lift**. It renders screens as
attribute-driven variants (`data-w="m"` / `data-w="d"`) so both layouts can sit
side by side on one page; the real app would use media queries. Its data is a
frozen JSON blob with base64 images, because the artifact sandbox blocks external
images — the real app loads logos straight from `a.espncdn.com`.

What is worth carrying over is the *component vocabulary* it settles: editorial
photo hero, brand-colour hero for teams/players, stat tile with a league-rank
chip, leader row with a movement column, standings table with a drawn playoff cut
line, form pips, and a small SVG trend chart.

---

## 8. If you are implementing in the real app

Proposed file layout, consistent with the existing module conventions in
`CLAUDE.md` (leaf-to-root, no reverse dependencies, side-effect imports declared
explicitly, function declarations not arrow consts where cycles exist):

- **`src/nfl.js`** — new leaf, imports only `config.js`/`util.js`. Fetchers for
  standings, leaders, team stats, player gamelog, news, past-week results, plus a
  `$ref` dereferencer. Model it on `coreTeams()` in `src/views/teams.js`.
- **`src/components/dashboard.js`** — the shared pieces above. Prefix new classes
  (`dash-`) and **check every name against the existing ~175 first**; the app has
  one flat global stylesheet and a silent collision has already happened once
  (hard-won detail 12).
- **`styles.css`** — the two new theme blocks, the new tokens across all seven,
  and the mobile/desktop layout rules.
- **`src/state.js`** — new fields on the shared `S` object, never bare `let`.

Things that will bite:

- Adding a view to `VIEW_LABELS` does **not** make it appear for anyone who has
  ever reordered their tabs — `reconcileViews()` and `VIEWS_KNOWN_BEFORE` handle
  this and are load-bearing (hard-won detail 19). Any new view is exactly the
  case that regression was found on.
- A mobile bottom bar must respect `env(safe-area-inset-bottom)`. `index.html`
  already sets `viewport-fit=cover`, and the real target is Zach's Safari
  "Add to Dock" web app, where a bar without the inset sits under the home
  indicator.
- Don't rename any `sb-*` localStorage key — favourites and tab layouts live
  there, and the prefix is deliberately kept from the app's old name.
- `file://` does not work at all since the module split. Serve the folder.
- Syntax-check every edit: `cp src/foo.js /tmp/check.mjs && node --check /tmp/check.mjs`.
  That proves syntax, not that an imported name exists — load the page in a real
  browser and check the console after any structural change.


## 9. Codex update — 2026-09-08

Active work has moved to Codex with GPT-5.6 Sol Medium as the default lead. Read
`AGENTS.md` for operating rules and delegation policy; `DECISIONS.md` remains
decision history. `CLAUDE.md` stays
available for detailed historical bug notes. No application code, Worker code,
database, branch merge, or production deployment was changed by the documentation
transition.

The original Claude prototype described above is no longer the only design
artifact. Codex has an isolated working review preview at:

- Folder: `/Users/zguest/Documents/Codex/2026-09-07/hel/outputs/fixtura-preview/`
- Local review URL: `http://localhost:8123/?design=11` while its server runs.
- `REVIEW.md`: page map, review history, validation, and preview limitations.
- `STATS-PLAN.md`: broader stat catalog and proposed player-by-game storage plan.

These files are outside the Fixtura repository and are not deployed application
code. If the folder is unavailable in a future environment, obtain the artifact
before relying on it; the local URL alone is not portable. Do not mistake its
simplified player popup or saved data for the existing app's full behavior.

Zach reviewed the preview positively and accepted expanding storage to
player-by-game records with locally calculated rankings. The UI now demonstrates
collapsible leaders, category detail up to 32 players, one player per team,
internal player popups, a detailed team season schedule, conference playoff seeds
and cutoff, and contextual news. It preserves five original themes and explores
Broadsheet and a more decorative Retro Card. Mobile includes simulated safe areas;
real iPhone validation is still needed. Header text remains provisional.

The full production player popup must be retained at integration. Additional stats
and storage remain planned: no new ingestion or database migration is implemented.
Ten preview categories have larger lists; tackles for loss still has only a small
verified sample. Complete coverage, eligibility for rate stats, traded-player
attribution, ties, and correction handling must be validated before production
rankings. Do not promote the frozen preview dataset into a live data service.

The branch/deploy hazard in section 1 still needs verification before any Worker
release. The documentation review found the checkout on
`redesign-nfl-dashboards`; this is not a fresh audit of production state. Preserve
the current weekly snapshot job while building the accepted storage expansion.


## 10. Player-by-game implementation milestone — 2026-09-08

The first local storage foundation is now in the repository. See
`worker/GAME-STATS.md`, `worker/src/game-stats-normalize.js`, and
`worker/src/game-stats-store.js`. An additive migration lives in
`worker/migrations/0001_nfl_game_stats.sql`; fresh `schema.sql` includes the same
three tables. It has NOT been applied remotely. At this milestone the production
router and cron were unchanged. Section 11 supersedes that status with the next
local integration.

Two real September 7, 2025 games validate 119 player-game rows and 959 numeric stat
cells across the 57-field catalog. Tests use reduced public fixtures and disposable
local databases only. Parser tests (8), migration preservation, actual D1 ingestion/
rollback/concurrency checks, and the existing Worker suite (165/165) passed.

Next: expand field verification and reconciliation, add bounded game discovery and
capture with coverage/retry tracking, then read-only rankings/player APIs. Test a
small week backfill before release. The visual preview is unchanged by this backend
milestone; full player-popup integration and the production redesign remain ahead.

## 11. Scheduled capture and read APIs — 2026-09-08

The next local Worker slice is complete. `worker/src/game-stats-capture.js` now
discovers completed NFL games from the current and previous week, caps each run at
eight imports, retries partial/failed captures, revisits recent games for provider
corrections, and records discovery/attempt state using additive migration `0002`.
It runs as a third independent task from the existing 30-minute scheduled handler;
the health check and weekly as-observed leaderboard snapshot remain unchanged.

`worker/src/game-stats-read.js` adds public D1 reads for discovered-final coverage
and a player's retained game logs. Responses explicitly avoid claiming complete
season coverage. No leaderboard endpoint was added yet because a partial backfill
could otherwise look like a valid rank. There is still no public write route and
no frontend change.

Local verification: 20 focused capture/parser/read tests passed; both additive
migration checks passed; the isolated D1 correction/rollback test passed; and the
full Worker suite passed 176/176 assertions. A local scheduled-event smoke test ran
health, weekly snapshots, and game capture successfully, with no completed current
games due at that moment. No remote migration or deployment was performed.

Before deploying this Worker tree, apply migrations `0001` then `0002` to the
intended remote D1 database and verify the branch/deploy hazard in section 1. The
next product slice is a small archived-week backfill with reconciliation and
coverage audit, followed by trustworthy league/team aggregation and UI wiring.

## 12. Archived Week 1 audit — 2026-09-08

A local-only audit tool now imports an exact archived NFL week through the real
normalizer/store into the isolated stats-test D1 database. It rejects non-loopback
targets and fails on missing games, import errors, partial coverage, or available
team-total mismatches.

The 2025 regular-season Week 1 audit passed: 16/16 finals imported, zero partial or
failed games, 1,006 player-game rows, 7,979 numeric stat cells, and all 57 catalog
fields observed. The database event IDs exactly matched the scoreboard. All 247
available semantic team-total comparisons matched. Nine fumbles-lost comparisons
were unavailable because ESPN omitted individual fumble rows for team totals of
zero; the audit correctly left these missing rather than fabricating player zeroes.

Forty-six fields appeared in every game. The 11 sparse fields were interception
returns (present in 9 games), fumbles (13), and punt returns (14). This clears the
foundation for total-stat aggregation with explicit coverage. Rate-stat rankings
still require qualification and recomputation rules. The run wrote only to the
disposable local database; no remote migration, backfill, or deployment occurred.

Next: implement league/team total-stat ranking APIs with ties, traded-player
attribution, top-32 results, one-player-per-team filtering, and audited coverage.

## 13. Total-stat ranking API — 2026-09-09

The local Worker now exposes `/stats/nfl/leaders` for catalog fields whose season
aggregation is safely `sum` or `max`. It supports league and team scopes, optional
through-week cutoffs, top-32/default bounded results, competition ties, combined
traded-player league totals, team-only contributions, and one representative per
team. Every result includes discovered-final coverage and never claims full-season
completeness from the capture state alone.

Recomputed rates and provider-only ratings return a validation error until their
formulas and qualification rules are defined. This prevents QBR, passer rating,
yards-per-attempt, and percentage fields from being summed or averaged incorrectly.

The archived Week 1 dataset was also run through real ranking aggregation. Sample
leaders were Josh Allen in passing yards, Derrick Henry in rushing yards, Zay
Flowers in receiving yards, and Harold Landry III in sacks; competition ties were
retained. Focused stats tests pass 29/29 and the complete Worker suite passes
182/182 with real local-D1 route checks. Nothing was remotely migrated or deployed.

Next: define qualified rate-stat formulas, then perform the migration/deployment
audit before enabling capture and connecting the leader cards to the application.

## 14. Qualified rate-stat ranking API — 2026-09-09

The same local `/stats/nfl/leaders` route now supports all seven catalog fields
marked for recomputation: passing, rushing, receiving, kickoff-return, punt-return,
and gross-punting averages plus field-goal percentage. It sums the stored
numerators and denominators first; it never averages provider weekly rates.

The NFL's 2025 Guide for Statisticians publishes full-season minimums of 224 pass
attempts, 100 carries, 32 receptions, 40 punts, and 20 kickoff or punt returns.
For live views, Fixtura prorates those minimums from their original 16-game pace
using the represented team's captured games and caps the result at the published
full-season value. League totals for a traded player use the latest represented
team for qualification; team and one-per-team rows use that team. Qualification
happens before choosing one representative per team. Field-goal percentage is
labeled as having no published minimum and only requires a positive denominator.

Every returned rate row includes its numerator, denominator, team-game count,
required minimum, and qualification status. The response also includes the exact
formula, component keys, unit, qualification source, excluded-candidate count,
and the same discovered-final coverage used by total rankings. Missing numerators
fail closed, stored zeroes remain real values, and zero denominators never divide.
Adjusted QBR and provider passer rating remain unavailable because this slice does
not have legitimate season recomputation rules for them.

Focused stats and migration checks pass 38/38. The full local Worker suite passes
187/187, including a real D1-backed HTTP check for the recomputed passing average,
its live threshold, and exclusion of an under-volume player. No remote migration,
backfill, Worker deployment, or frontend wiring occurred.

Next: perform the documented branch and remote-migration readiness audit, prepare
the exact migration/deployment sequence for review, then connect the collapsible
league/team leader cards and existing in-app player popup after the data service is
available in the intended environment.

## 15. Production-readiness audit — 2026-09-09

The live Worker and remote D1 were inspected read-only. Production health and
`/trends` return 200, `stat_snapshots` exists remotely, and `/stats` correctly
returns 404 before release. None of the four new NFL player-game tables exists
remotely. This confirms the documented branch hazard: production is running the
trends work from `redesign-nfl-dashboards`, while `main` still lacks `trends.js`.

The production D1 database supports Time Travel and yielded a recovery bookmark.
A local Wrangler deployment dry run succeeded at 107.70 KiB (26.36 KiB gzip),
with both scheduled capture jobs, stats routes, and rate definitions present in
the bundle. `worker/STATS-ROLLOUT.md` now contains the reviewed source gate,
ordered migrations, schema checks, smoke tests, and Worker-first rollback plan.

No remote write or deployment was performed. The next release action must apply
migrations `0001` and `0002` before deploying this exact reviewed Worker tree.
After release validation, the next product slice is frontend wiring for the
collapsible league/team cards, top-32 detail view, one-player-per-team option, and
existing in-app player popup.

## 16. Player-game stats production release — 2026-09-09

Zach authorized the reviewed release. Production D1 Time Travel recovery was
confirmed and a fresh bookmark recorded before writes. Additive migrations `0001`
and `0002` both succeeded, creating all four player-game tables without removing
the existing trends table. A preservation check still found 2 users, 3 pools, and
22 picks; the new stats tables were empty before their first capture.

Commit `7ae8141` was deployed as Worker version
`0fed0268-a8b5-409c-9136-f297ffc2c697`. Production smoke checks passed for health,
the existing trends route, stats coverage, total leaders, qualified-rate leaders,
provider-only rejection, private-route authentication, CORS/cache headers, and the
existing ESPN proxy. The empty 2026 stats responses are expected before completed
games are captured.

The prior Worker version is `8a86338b-460a-45a1-a3e2-1665ffc2e900` if code rollback
is needed. The additive stats tables should remain in place during a Worker
rollback. `worker/STATS-ROLLOUT.md` contains the full recovery procedure.

Next product work: connect the production reads to the collapsible NFL/team stat
leader sections, top-32 detail view, optional one-player-per-team filter, and the
existing in-app player popup.

## 17. NFL leader frontend integration — 2026-09-09

The first production-data frontend slice is implemented locally on
`redesign-nfl-dashboards`. The existing NFL Scores surface now has a collapsed
league-leaders section, and NFL team pages have a Stats tab after Schedule and
Roster. This does not create a new main-navigation NFL hub; the shared dashboard
component can move there later if that navigation decision is made.

Opening a section fetches the selected Offense, Defense, or All group. Seventeen
verified categories are included, with top-three card previews and a full list of
up to 32 players. League details offer the optional one-player-per-team filter.
Every player action opens Fixtura's existing player popup. Empty production data
is labeled as uncaptured rather than zero, and each card/detail includes the
Worker's discovered-final coverage language.

Broadsheet and Retro Card are now selectable alongside the five existing themes.
Retro adds the reviewed navy/yellow/red card language, ribbon, texture, and an
optically centered season starburst without committing to the undecided motto.
Broadsheet uses the cleaner editorial treatment. The layout includes responsive
one-column leader cards and safe-area padding for iPhone camera/home-indicator and
landscape edges. Headings introduced by this slice do not use terminal periods.

Focused frontend tests pass 3/3, all changed JavaScript files pass syntax checks,
and real-browser checks passed for league and team expansion, live empty states,
detail modal behavior, both new themes, and a 390x844 responsive viewport. The
deployed Worker correctly returns zero discovered finals for the current season,
so live player rows and player-popup handoff could not yet be exercised with real
production leader data; their rendering, escaping, query construction, and popup
callback are covered by fixtures and review. No frontend deployment was performed.

Next redesign work: build conference-wide standings with a visible playoff/wild-
card cutoff, then expand the team Schedule tab into the agreed full-season detail.
NFL/team news placement, the pregame next-game duplication, and the remaining
prototype copy cleanup are still open.

## 18. Dedicated NFL dashboard and standings — 2026-09-09

Zach reviewed the first integration and decided the league dashboard must not live
inside Scores. That decision is now implemented locally: NFL is its own top-level
tab, Scores is games-only again, and the dashboard has Overview, Standings, and
News tabs. Overview owns the collapsible league leader cards. The NFL team Stats
tab remains in place.

New installations place NFL after Teams. Existing saved/customized layouts gain
NFL through the established `reconcileViews()` and `sb-viewsseen` path, preserving
their chosen order and hidden tabs. The historical `VIEWS_KNOWN_BEFORE` marker was
left unchanged so the new view is recognized as new rather than silently hidden.

Standings now provides AFC/NFC and Conference/Division controls using ESPN's live
three-level standings. Conference tables show all 16 teams. When ESPN publishes a
complete official 1–16 seed set, Fixtura draws division-winner, wild-card, and
outside-the-field cutoff boundaries. It does not infer playoff seeds from record
because that would omit NFL tiebreakers. Before current seed data exists, the view
states that the table is record-sorted and withholds the cutoff. A current/previous
season switch lets the completed 2025 table show the full official playoff picture
while the pre-kickoff 2026 table remains honest.

The News tab is reserved for the agreed contextual NFL news slice and currently
says “Coming next.” No frontend deployment was performed. Focused tests pass 5/5,
changed JavaScript passes syntax checks, and real-browser review covered the new
top-level reconciliation, Retro Overview, live 2026 standings, 2025 official
cutoff, AFC/NFC, and Conference/Division controls.

Next: implement contextual NFL News in this dashboard, then expand the NFL team
Schedule tab into the detailed full-season presentation.

## 19. Game-night frontend release — 2026-09-09

The reviewed redesign branch was fast-forwarded into `main` and published through
the repository's GitHub Pages deployment. Production now includes the dedicated
NFL dashboard, conference/division standings, league and team leader surfaces,
Broadsheet and Retro Card themes, and the retained player-stat frontend.

The reported pregame “next game” duplication was confirmed to exist only in the
earlier standalone design prototype. Fixtura's production Game Center does not
render a next-game card. Testing the real Patriots–Seahawks event `401872656`
did expose blank team labels in the Info tab standings because ESPN supplies
`entry.team` as a string for that response. Commit `8f2389a` accepts both string
and object team shapes, retains provider-derived fallbacks, and escapes the label.

Production verification covered tonight's pregame time, broadcast, venue, odds,
Box Score and Info states; a 390×844 mobile viewport; and completed event
`401772723` for score tables, the drive view, and the in-app player popup.
Frontend tests passed 5/5, retained stats tests passed 38/38 plus both schema
checks, and the production Worker health endpoint reported an OK database.

## 20. NFL News tab, and Broadsheet default/type-system change — 2026-09-09

Implemented locally by Claude Code, on `main`, not yet deployed to GitHub Pages.
Two changes, both scoped narrowly:

**NFL dashboard News tab.** The tab that said "Coming next" now shows a live
feed of the 20 most recent articles from ESPN's keyless
`site.api.espn.com/.../nfl/news` endpoint, fetched directly (no Worker
involvement — this is public data, same as everything else on the ESPN path).
`fetchNFLNews()` in `src/nfl.js` normalizes each article (headline,
description, image, published date, external link, and up to two tagged teams
pulled from `categories[].type === 'team'`) and drops anything missing an id,
headline, or link; `src/views/nfl.js` renders them as cards
(`.dash-news-card`) that open the ESPN article in a new tab
(`rel="noopener noreferrer"`, matching the existing Wikipedia-link convention
in `modal.js`). Cards follow the same stale-while-revalidate pattern already
used by Standings (`lastNews` holds the last successful fetch so the existing
list stays up during the 60s background refresh instead of flashing back to a
loading state) — the first cut of this didn't do that and would have re-shown
"Loading NFL news…" over live content every 60 seconds; caught before commit,
not after. New CSS is under `.dash-news-*` in `styles.css`, styled from
existing theme tokens only (`--panel`, `--line`, `--editorial`, `--dim`, …) so
it does not need a Retro Card-specific pass.

This is scoped to the league-wide feed only. **"Team news" (per-team, shown on
a team's own page) is still open** — `src/views/teams.js` has no news tab yet,
and the 2026-09-08 planning note "News belongs within NFL and Teams" is only
half addressed by this slice.

**Broadsheet is now the default theme, and its type system now spans the
whole app.** Zach asked for this directly: Broadsheet (not Paper) should be
what a new visit sees, and the editorial-serif language already built for the
NFL dashboard should read consistently on every tab, not stop at that one
screen. He was explicit that Retro Card's own visual design (starbursts,
ribbons, texture, how loud it gets, its motto — still open per item 4 in
`DECISIONS.md`'s "Open decisions") stays on the Codex/ChatGPT side; nothing in
this slice touches Retro's overrides.

Implementation, recorded in full in `DECISIONS.md` under "Broadsheet is the
default theme; its type system now spans the whole app": the `sb-theme`
fallback (`src/app.js`) and the pre-JS `data-theme` (`index.html`) both changed
from `paper` to `broadsheet` — this only affects installs with no stored
preference, so anyone who already picked a theme keeps it. Six elements that
were hardcoded to `'Barlow Condensed',sans-serif` now read the existing
`var(--display)` token instead: the app header, the nav tab labels, the Scores
day/week label, the team-page name, the game-modal matchup team names, and the
player-modal name. Every theme besides Broadsheet still resolves `--display` to
Barlow Condensed, so this is invisible on Paper/Midnight/Ice/Terminal/
Crimson/Retro Card — only Broadsheet's Newsreader serif now flows through the
whole app.

**Validation:** `fetchNFLNews()` was run end-to-end against live production
ESPN data via a throwaway Node script (not just a curl shape-check) and
returned 5/5 well-formed articles with images, links, and team tags. Both
changed JavaScript files pass `node --check`. No dangling references to the
removed `renderComingSoon()` helper remain. **Not done: real-browser
verification** — no browser-automation tool was available in this session, so
the News tab's actual rendering, the theme default on a fresh load, and the
font change across all six elements were only verified by static review and
the Node-level data check, not by opening the page and looking at it or
clicking through. A local server was left running at `localhost:8123` for
Zach to check visually before this ships. Load `?v=2` or similar to bypass any
cached module.

Not deployed. Zach reviewed locally and confirmed the type-system change looks
right after two follow-up corrections, both applied and re-verified live:
`nav.views button` was pulled back off the serif to match `.dash-tab`'s plain
sans-serif per his request, and the FIXTURA logo needed `class="cond"` removed
from `index.html`'s `<h1>` — a CSS-specificity bug (a lone class outranks the
two-element `header h1` selector regardless of source order), not the caching
issue it first looked like. See `DECISIONS.md` for the full account. Still not
deployed to GitHub Pages.

Zach chose to hold everything above and batch it with more work rather than
deploy immediately — see §21.

## 21. Detailed NFL team schedule — 2026-09-09

Implemented locally by Claude Code, on `main`, not deployed. The NFL team
Schedule tab (`src/views/teams.js`) no longer reuses the generic
Upcoming/Results flat list shared by every league — it now renders a real
week-by-week season grid, NFL-only, via a new `loadNFLTeamSchedule()` that
`loadTeam()` dispatches to instead of the shared `loadTeamSchedule()` when
`t.league === 'nfl'`. Every other league (NBA, MLB, soccer, etc.) is untouched
and still gets the original flat list — this follows the standing "NFL only,
don't build a generic abstraction" rule.

**Why a separate function instead of extending the shared one:** ESPN's team
schedule response carries fields the generic path never used —
`week.number`/`week.text` per event and a top-level `byeWeek` integer — and
these only exist in a form worth building UI around for the NFL, where a
season is 18 numbered weeks with exactly one bye. Verified live via a
throwaway Node script against real production data before writing any
rendering code, not assumed from documentation:
- Houston Texans, 2026 (current, in-progress season): 17 games + `byeWeek: 8`
  fill all 18 weeks with zero gaps.
- Houston Texans, 2025 (season complete, made the playoffs): the base call
  returns only the 17 regular-season games; `?seasontype=3` on the same
  endpoint returns the postseason games separately (`week.text`: "Wild Card",
  "Divisional Round", …) with **no event-ID overlap** with the regular-season
  set, confirming they're safe to concatenate rather than needing dedup logic.
- A team with no playoff appearance (Ravens, 2025) correctly returns zero
  events from the `seasontype=3` call — no error, no fabricated bracket.

The new function fetches both calls in parallel, builds one row per week 1
through the last known week number (falling back to `byeWeek` if no game
exists for that slot — the empty slot is rendered as a dashed "Bye week" card,
not left blank or silently dropped), then appends any postseason rows in order
using `week.text` as the label so round names never need hardcoding. Each
game row reuses the existing `teamRow()` renderer unchanged (same W/L badge,
score, venue, broadcast, odds line, click-through to the real game modal) —
only the surrounding per-week layout is new. New CSS (`.wk-schedule`,
`.wk-row`, `.wk-num`, `.wk-bye`) draws from existing tokens only
(`--panel-2`, `--line`, `--dim`, `--dim-2`) and needs no Retro-specific pass,
same reasoning as the News tab in §20.

**Scope deliberately held back:** no season-toggle (current vs. previous) like
Standings has — full detail for the current season was the actual ask, and a
toggle can be added later if it's wanted. No pagination/"show all" control
either: an NFL season is at most ~20 rows total (18 weeks + up to 4 playoff
rounds), which is exactly why "detailed full-season" is affordable here in a
way it deliberately isn't for a 162-game MLB schedule on the shared path.

**Validation:** both live-data scenarios above run against real production
ESPN endpoints (not fixtures), plus `node --check` on the edited file. **Not
verified in an actual browser** — no browser-automation tool was available in
this session, same limitation as §20. The local server at `localhost:8123` has
this change; Zach has not yet looked at it.

Not deployed. Next, per Zach's "hold and batch" choice: continue to per-team
news (the "Teams" half of "News belongs within NFL and Teams," §20 only
shipped the NFL-dashboard half), then deploy everything from this session
together.

## 22. Per-team news, and a shared news component — 2026-09-09

Implemented locally by Claude Code, on `main`, not deployed. NFL team pages
(`src/views/teams.js`) now have a News tab alongside Schedule/Roster/Stats/
Injuries — NFL-only, same gating as the existing Stats tab, using ESPN's
`?team=<id>` filter on the same news endpoint §20 already integrated. Verified
live that the filter is real (different article IDs for different team IDs,
not a silently-ignored no-op) rather than assumed from ESPN's docs.

**Refactored rather than duplicated:** the card rendering §20 wrote inline in
`views/nfl.js` moved into `components/dashboard.js` as `newsSectionHTML()` /
`wireNewsSection()`, matching the existing pattern there
(`leaderSectionHTML`/`standingsSectionHTML` are pure-render functions shared
by both `views/nfl.js` and `views/teams.js` already) — the same shared-
component reasoning §17 used for leader cards. `fetchNFLNews()` in `src/nfl.js`
gained an optional `teamId`, and its cache went from a single slot to a `Map`
keyed by the full request path, since league and per-team feeds now coexist
and must not evict each other.

Team news does not carry §20's stale-while-revalidate handling — checked
`app.js`'s 60-second refresh timer first, and Teams isn't in it (only Scores,
NFL, and Golf poll in the background), so there's no periodic re-render for a
team's news to flicker during. A fresh loading state on tab-open is correct
here, not a regression.

**Validation:** `fetchNFLNews({ teamId })` run against live production data
for both a league-wide and a team-scoped request (5/5 well-formed articles
each), plus confirmed a malformed `teamId` is rejected before any request is
made. `node --check` passed on all three touched files
(`nfl.js`, `dashboard.js`, `teams.js`). Grepped for leftover references to the
old inline `newsCardHTML`/`timeAgo` in `views/nfl.js` — none remain. **Not
verified in a real browser** — same limitation as §20–21; no browser-
automation tool is available in this session. The local server at
`localhost:8123` has this change.

This closes out the "News belongs within NFL and Teams" item from the
2026-09-08 planning notes. Zach reviewed this batch locally and asked to
deploy; §20–22 (Broadsheet default, app-wide type-system change with two
live-reviewed corrections, NFL News tab, detailed NFL team Schedule, per-team
News) shipped together in one push to `main`/GitHub Pages. See the status line
at the top of this file for the production verification that followed.

## 23. Week 1 kickoff — production capture check, and open items for the next planning session — 2026-09-09

No code changed in this section. Zach asked, ahead of tonight's actual Week 1
opener (Patriots @ Seahawks, event `401872656`, kickoff 8:20 PM ET), whether
the automated capture systems were positioned correctly. Checked production
directly — Worker code via `workers_get_worker_code`, live D1 via
`d1_database_query`, and live ESPN state — rather than trusting the docs.

**Confirmed working:**
- `/health` reports ok, D1 reachable, no missing secrets.
- The *deployed* Worker bundle (not just the repo) wires `scheduled()` to all
  three jobs — health check, leader-snapshot capture, game-stats capture — and
  `MAX_IMPORTS = 8` matches the documented per-run cap exactly. The historical
  deployed-from-a-branch hazard does not apply right now.
- Pick'em locking is real: the stored `locks_at` for tonight's game is
  `2026-09-09 20:20 ET`, ESPN's actual kickoff, not a placeholder.
- `stat_snapshots` and `nfl_game_capture_state` being empty right now is
  **correct, not broken** — ESPN's 2026 leaders endpoint is still a genuine
  404 (checked live), and game-stats capture only imports completed games.
  Both should start populating as today's games go final; the game-stats cron
  runs every 30 minutes.

**Found while checking, not yet acted on:**
- **Only Zach (user id 1) is a member of "Zach's Group" (pool 3, join code
  `GKFJ3D`).** A second account exists (Jared Nechamkin, user id 6, signed in)
  but has not joined any pool. Zach has already submitted all 16 Week 1 picks
  for himself. If other people are expected to play, they need to join before
  each game's own kickoff locks it.
- **Two disposable test pools are still live in production D1** — "Test 1"
  (id 6, confidence mode, 5 picks) and "test 2" (id 7, survivor mode, 1 pick),
  both owned by Zach. Harmless but not cleaned up; not deleted without asking
  first per the standing rule against unprompted destructive D1 writes.
- **The D1 backup-plan upgrade flagged in "Open decisions" item 4** ("upgrade
  to the $5/mo Workers plan before real picks exist — before 2026-09-09") has
  a deadline of today, and 16 real picks already exist. Billing tier isn't
  visible through the D1/Workers API used here, so this could not be verified
  either way — needs a direct look at the Cloudflare dashboard.
- **The Cloudflare Worker error-rate email alert is still not configured**
  (same item as before). Tonight is the first night all three cron jobs have
  real work to do; nothing currently notifies anyone if one throws.

**Next planning session moves to Codex/ChatGPT.** Zach is taking the
still-open redesign decisions there rather than deciding them in this session.
For whichever tool picks this up next, the concrete undecided items are
exactly the ones listed in §5 "Still open" above, refined by what's since
shipped:
- **Which serif — likely already settled, not confirmed in writing.**
  Newsreader shipped as part of Broadsheet (§20) and Zach reviewed/approved it
  live in production, correcting *where* it applies (nav tabs stay sans-serif)
  but never objecting to *which* typeface. Worth a one-line confirmation
  before treating it as closed, but there is no live signal it's still
  actually contested.
- **A HOME tab is still fully undecided** — whether Fixtura gets a landing
  view at all, and if so what would be on it. Nothing has been built toward
  this.
- **The mobile bottom bar does not exist in the real app at all** — checked
  the actual codebase (grepped for any bottom-nav/tab-bar implementation) to
  confirm this before recording it: today's mobile nav is the same
  horizontally-scrollable `nav.views` row used on desktop, just with smaller
  type/padding under the 700px breakpoint. The "first four tabs + a More
  sheet" idea is a proposal that exists only in the original standalone
  design prototype (§7) and was never started in the shipped app. Treat this
  as a bigger navigation-paradigm decision, not a small tweak, if it's picked
  up.
- **The page-content walkthrough Zach wanted** ("idk if I am good with what
  is on each page yet," §5) has not happened. Nothing about the current page
  contents should be assumed settled just because it shipped.

## 24. NFL next-steps and EPA planning — 2026-09-09

Planning only; no application, Worker, schema, database, workflow, or deployment
changed. Zach asked for a sizeable implementation plan that can be handed back to
Claude Code and explicitly added NFL expected points added (EPA) as a product
goal, while leaving its granularity open for planning.

The resulting living plan is `NFL-IMPLEMENTATION-PLAN.md`. It specifies a proposed
NFL Overview league-pulse layout; researches nflverse's NFL data and
SportsDataverse/cfbfastR's ESPN-derived CFB data; recommends separate league/model
contracts using hybrid slim-play plus materialized-summary D1 storage; defines
initial team/QB/rusher metrics and deferred attribution; and lays out offline
ingestion, API, UI, validation, operations, and release gates.

Zach then expanded the goal to ongoing college football. The CFB plan scopes the
first release to finals discovered through Fixtura's existing ESPN `groups=80`
coverage, uses ESPN IDs already present in the preferred source, and adds Game
Center then CFB team Stats before deciding whether CFB deserves a top-level
dashboard. The preferred compiled 2026 Parquet was not assumed available: the
release page checked on 2026-09-09 listed compiled seasons through 2025 despite
active 2026-aware workflows. Phase C0 therefore compares that exact asset,
per-game enriched final JSON, and locally processed cfbfastR output and selects one
canonical source rather than stacking silent fallbacks.

The plan deliberately starts with source/contract inspection and sample payloads;
it does not authorize a migration, backfill, Worker deploy, or frontend release.

The Game Center portion now has an implementation-ready proposed screen contract
for both leagues: final-game tab eligibility and placement, lazy Worker reads,
modal/Drive polling lifecycle, complete/pending/partial/failed/unsupported states,
desktop and mobile hierarchy, value formatting, accessibility, a shared outer API
envelope, league-specific routes, identity limits on play links, and acceptance
checks. A conversation-only layout mockup was created outside the repository; no
frontend component or CSS was changed.

`CLAUDE.md` now contains Claude-specific model routing so its instruction to ignore
Codex-only model mechanics does not leave delegation ambiguous: Opus leads source,
architecture, integration, and review; Sonnet receives bounded implementation;
Haiku receives small mechanical work; delegation is limited to two concurrent,
disjoint tasks and every result returns to the lead for review. The implementation
plan also contains a copy-ready Claude Code startup prompt that begins with Phase
C0 and preserves the current planning-only boundary.

## 25. EPA source-and-contract spike (Phase C0 + N0) — 2026-09-09

**Scope:** the "First implementation-ready task for Claude Code" in
`NFL-IMPLEMENTATION-PLAN.md`, and nothing beyond it. Phase C0 first because
the college season is live and its source availability was unresolved, then
Phase N0.

**Branch/commit:** `main`, aligned with `origin/main` at `5dfc989`. **Nothing
committed and nothing pushed.** No migration, no schema change, no remote or
local D1 command, no Worker deploy, no frontend change — verified by the fact
that the only files touched are the eight new ones below plus two planning
documents.

**Working tree:** the pre-existing intentional planning edits are preserved
untouched (`CLAUDE.md` model-routing block, `DECISIONS.md`, `HANDOFF-REDESIGN.md`
§24, and the untracked `NFL-IMPLEMENTATION-PLAN.md`). Added this session:

```
worker/scripts/epa/{README.md,requirements.txt,.gitignore,
                    common.py,sources.py,nfl.py,cfb.py,epa_inspect.py}
```

plus `DECISIONS.md` "CFB EPA source selected; NFL source confirmed" and this
section. `.venv/`, `cache/` and `out/` are gitignored; `git status` shows only
the eight intended files.

**Local, remote, frontend, Worker, database alignment:** local == remote
(`main` @ `5dfc989`) apart from the uncommitted files above. The frontend, the
deployed Worker, and D1 are all untouched and therefore still aligned with
`main` as recorded in §23. The deployed-from-a-branch hazard remains
not-currently-applicable; nothing here goes near a deploy.

### What the tool is

`worker/scripts/epa/` is offline, deterministic inspection tooling: one
dependency (DuckDB) in a local venv, separate NFL and CFB adapters, separate
exported versioned qualifying-play predicates, and five subcommands —
`probe`, `extract`, `coverage`, `reconcile`, `sizing`. It has no write path to
anything except its own gitignored `cache/` and `out/`. Exact commands are in
its README.

### What it found

The full evidence is in `worker/scripts/epa/README.md` and the decision is in
`DECISIONS.md`. The three things that change what gets built:

1. **The 2026 CFB compiled Parquet exists and is fresh** (rebuilt daily, with a
   machine-readable `timestamp.json`). The plan's central uncertainty is
   resolved in favour of the preferred source.
2. **Coverage, not availability, is the real constraint.** 53 of ESPN's 99
   `groups=80` week-1 finals are importable; 44 are present but were captured
   mid-game and never re-captured; 2 are absent. Truncated games carry real EPA
   and read as low-scoring games. `status_type_completed` is the only safe
   gate — play count is not, since a truncated game held 179 rows against a
   complete game's 161.
3. **Neither documented fallback helps.** The per-game enriched JSON is the
   same capture (it reconciles exactly with the Parquet, *including* on the
   truncated numbers), and cfbfastR-locally could not be run because R is not
   installed here.

NFL identity is exact both ways (272/272 games, 345/345 passers and rushers),
every predicate column exists, and both sample games normalize and reconcile.

### Real-data limitations — do not paper over these

- **The CFB overtime path is untested.** No game in the 2026 asset reaches a
  fifth period, and the one known week-1 overtime final (Charlotte–The Citadel,
  `401862694`, `Final/3OT`) is one of the two games missing entirely. Verify
  against a real overtime game before the college UI ships.
- **Whether truncated current-season games heal, and how fast, is unknown.**
  Week-1 games were still stale three to eleven days out. 2025 is 956/956
  complete, so it does resolve eventually — but the recheck window for the
  scheduled job must not be fixed at "the previous two weeks" until this is
  observed.
- **No live NFL 2026 data was available.** `play_by_play_2026.parquet` was a
  404 all session; Week 1 kicks off tonight. Everything NFL here is archived
  2025 data, and nothing about live-season behaviour was tested.
- **D1 row storage was not measured** — only JSON bytes. ~85–95 MB per CFB
  season, ~20 MB per NFL season, as JSON. Measure against a local D1 in Phase 1
  before sizing anything.

### Validation performed

`probe`, `extract`, `coverage`, `reconcile` and `sizing` were each run against
live upstream data. Four real games normalize and pass every contract check:
NFL `401772810` (return TD scored by the non-possession team) and `401772921`
(overtime, and a tie); CFB `401858422` (FBS vs FCS) and `401864495` (15 no-play
penalties). Determinism confirmed — the same game extracted twice produces an
identical `content_hash`, and referring to an NFL game by nflverse id or by
ESPN event id produces the same hash. Rejection paths confirmed: a truncated
CFB game, a game absent from the source, and an unknown NFL game each fail
loudly with a specific reason.

A Sonnet subagent then reviewed the tool read-only against the stated
invariants, and its findings were re-measured against the source before
anything was changed. Seven confirmed defects were fixed; the full list is in
the README. The two that would have caused real damage:

- **`content_hash` was not stable.** The CFB adapter folded a live release
  timestamp into the hashed payload, so the hash changed whenever upstream
  republished anything, even with byte-identical plays — defeating the only
  purpose the hash has, which is letting a scheduled importer skip unchanged
  games. Now hashed over a data core that excludes fetch-time metadata, and
  verified stable across a simulated republish.
- **NFL coverage hardcoded `game_type = 'REG'`**, so every postseason game
  reported as missing. Fixing it exposed a worse trap: nflverse schedules have
  **no `POST` value** — they use `WC`/`DIV`/`CON`/`SB`, and postseason weeks
  *continue* the regular season's numbering, so ESPN seasontype 3 week 1 is
  nflverse **week 19**. The pbp table separately uses `REG`/`POST`. Postseason
  coverage now reports 6/6 rather than 0/6.

One reviewer claim did not survive checking — that the kneel handling was
wrong. Measured, kneels are correctly excluded (48 rows, 0 qualifying); spikes
are the actual gap (3, all qualifying, and the source has no spike flag), and
they are left in deliberately rather than fixed by pattern-matching
description text. An earlier text search of my own had been contaminated by a
player name containing "kneel", which is why both claims were re-measured
rather than either one taken on trust.

Two defects were found in my own validation before the review: a 404 on a
not-yet-published season asset produced a raw traceback. That is hard-won detail 28 arriving
through a different door, and in a scheduled importer it would be a thrown
handler error every run until the season publishes. Upstream fetch failures are
now typed — 4xx is a legible "not published yet" skip, 5xx and network failures
stay loud and retryable. Nothing globally suppresses upstream errors.

And nflverse and SportsDataverse both
publish a file named `play_by_play_2025.parquet`, so the download cache keyed
by basename would have silently served one league's season file to the other
league's adapter. The cache is now keyed by a hash of the full URL.

### Exact next implementation-ready task

Superseded by §26 — the spike was accepted, the schema questions were decided,
and Phase 1 has been built locally. The open-question list that used to live
here is now maintained in one place, `worker/scripts/epa/README.md`
"Question ledger", because the copy here and the copy there had already drifted
apart once.

Then Phase 1 (`0003_nfl_epa.sql`, and `0004_cfb_epa.sql` now that the CFB source
is selected), with all id columns `TEXT` — the CFB play id
`401858212104999901` is four orders of magnitude past JavaScript's safe integer
range and would round silently as a JSON number.

Still untouched and still open from §23: the two disposable test pools in
production D1, the D1 paid-plan/backup question, and the Worker error-rate
alert.

## 26. EPA spike accepted; Phase 1 built locally — 2026-09-09

**Scope:** Zach reviewed the Phase C0/N0 diff and accepted the spike, recorded
the outstanding schema decisions, and asked for Phase 1 design plus a real
local D1 storage measurement. Explicitly excluded and not done: **no remote
migration, no deploy, no frontend work.**

**Branch/commit:** `main`, still aligned with `origin/main` at `5dfc989`.
**Nothing committed, nothing pushed.** No `--remote` D1 command was issued, no
Worker was deployed, and no file under `src/` (frontend or Worker) was touched.

**Decisions recorded** in `DECISIONS.md` "EPA spike accepted; storage contract
settled": store `description` from the start; backfill 2025 and 2026 only; keep
the 11 source-qualified penalty-no-play records with their `is_penalty_no_play`
audit flag; retain the documented CFB spike behavior; NFL and CFB keep separate
shapes, tables, routes and predicates. **Public CFB release stays gated on
attribution and data-term review** — local storage and local routes may
proceed, shipping CFB EPA to the live site may not. NFL is not blocked by this.

**Coverage re-measured** ~13.5 hours on: the 2026 asset was byte-identical
(same sha256, `Last-Modified` unchanged), so week-1 coverage is still 53 of 99.
The source simply had not republished, so this is **not** evidence about
whether truncated games heal. That question needs a reading taken after an
actual upstream rebuild.

**Question lists reconciled.** The README and this handoff each carried an
open-question list and they had already drifted (the handoff's said four items
gated Phase 1; the README's had six). There is now **one** ledger, in
`worker/scripts/epa/README.md` — five settled with their decisions, three still
open, none of which blocks Phase 1. §25's next-task section points here rather
than keeping a second copy.

### Phase 1 — what was built

Design and measurements are in `worker/EPA-PHASE1.md`. Added:

```
worker/migrations/0003_nfl_epa.sql     worker/migrations/0004_cfb_epa.sql
worker/EPA-PHASE1.md                   worker/test/epa-schema.test.py
worker/scripts/epa/load_local_d1.py
```

and `worker/schema.sql` now mirrors both migrations verbatim, as the existing
convention requires.

**Validation, all local:** fresh database applies cleanly; an existing pre-EPA
database with seeded users/pools/picks/`nfl_stat_games` migrates with every row
intact; `.schema` is **identical** either way; re-applying is a no-op; 69 real
games (53 CFB + 16 NFL, 8,804 plays) import and **re-import idempotently** with
`first_imported_at` preserved. `npm run test:stats` is green — 38 node tests
plus three Python schema tests, including a new one asserting that a CFB play
id past 2^53 round-trips exactly as TEXT.

**Measured storage — this supersedes the JSON estimate.** Via `dbstat` over the
real load, counting every index: NFL **319 bytes/play**, CFB **393
bytes/play**. Projected for the approved 2025 + 2026 backfill: **116 MB total**
(NFL 22 MB, CFB 94 MB), about **23% of the 500 MB free-tier cap** before
whatever the database already holds. Real D1 came in materially cheaper than
JSON suggested, because JSON repeats every key name per row.

**One correction that matters.** Descriptions were reported earlier as "~20% of
a play row" from JSON. Measured in storage they are **41–47% of the plays
table** and **30% of projected EPA storage** (34.7 MB of the 116 MB). The
decision to store them stands and the cost is affordable, but the figure that
decision was weighed against was too low.

**One regression caught and fixed.** `test/game-stats-schema.test.py` and
`test/game-stats-capture-schema.test.py` both asserted that `schema.sql` *ends
with* a specific migration, which broke the moment 0003/0004 were mirrored.
Both now locate their migration by position within the ordered migration tail,
so they stay correct as further migrations are added instead of failing again
each time.

### Exact next implementation-ready task

Phase 2 — the Worker side, still local:

1. Payload validation and aggregation **inside the Worker**. The spike
   validates in Python, offline; the Worker needs its own and cannot import it.
2. Correction-aware atomic storage as Worker code rather than
   `load_local_d1.py`, which is a measurement tool, not a shipping path.
3. Private machine-authenticated import routes and public read routes, keeping
   private-first routing and the prefix-disjointness assertions intact.
4. Extend `worker/test.sh` without reducing its current assertions, and run the
   whole suite against disposable local D1.

`worker/test.sh` was **not** run this session: no file under `worker/src/` was
touched, so the integration suite's subject is unchanged, and running it needs
`npm run dev` in a second terminal. It must be run for Phase 2, where Worker
code does change.

Still untouched and still open from §23: the two disposable test pools in
production D1, the D1 paid-plan/backup question (sharper now — EPA adds ~116 MB
of derived data to a database whose Time Travel window is 7 days on the free
plan), and the Worker error-rate alert.

## 27. EPA Phase 2 — Worker validation, storage and routes — 2026-09-10

**Scope:** the six ordered Phase 2 steps. All local. **No remote migration, no
deploy, no frontend work** — verified: nothing under `/src` (frontend),
`index.html` or `styles.css` was touched, and no `--remote` command was run.

**Branch/commit:** `main`, still aligned with `origin/main` at `5dfc989`.
Nothing committed, nothing pushed. Design detail is in `worker/EPA-PHASE2.md`.

Added: `worker/src/epa-{validate,store,import,read}.js`,
`worker/test/epa-{validate,store}.test.js`, `worker/EPA-PHASE2.md`, 45 new
`test.sh` assertions, and an `EPA_IMPORT_TOKEN` entry in `.dev.vars.example`.
Changed: `worker/src/index.js` (an `epa` private prefix, a
`stats/:league/epa/...` dispatch, one `/health` field) and `package.json`.
`pools.js`, `auth.js`, `me.js`, `proxy.js`, `trends.js` and every
`game-stats-*` module are untouched.

### The load-bearing decisions

- **The Worker recomputes every aggregate from the plays** and cross-checks the
  submitted team/player rows, rejecting a disagreement with the field named and
  both values. The offline tool runs on a laptop, in Python, outside the
  Worker; the Pick'em rule that a client-enforced rule is not a rule applies
  here unchanged.
- **`epa` is a private prefix**, so an import can never reach the cached lane;
  the disjointness assertion now covers it. Reads sit under the existing
  `stats` public prefix and dispatch on segment 2, leaving `/stats/nfl/...`
  byte-identical.
- **Import auth is a dedicated `EPA_IMPORT_TOKEN`**, compared in constant time,
  never logged or echoed, and **503 when unset rather than 401** — "cannot" and
  "may not" are different problems.
- **207 on partial failure**, so a workflow cannot read a half-failed import as
  success.

### One real bug found by a failing test

Nothing prevented a single athlete accumulating EPA under two different
possession teams in one game: the code took whichever team appeared first and
silently attributed half that player's EPA to the wrong side. Now rejected in
both leagues, with a test.

### Validation

`npm run test:stats` — **67 unit tests + 3 Python schema tests, all green.**

`./test.sh` against local D1 — **220 passed, 12 failed.**

**The 12 failures are pre-existing and have nothing to do with EPA.** This was
verified, not assumed: a pristine `git worktree` at `5dfc989` containing no EPA
code was run on a separate port and produced **the same 12 failures with
identical text** (175 passed, 12 failed). All 45 EPA assertions pass, including
route separation, the private lane's `no-store`, the public lane's cache
headers, CORS refusal for an unknown origin, and a leak check that finds no
account keys in a public read.

**The cause is time, not code, and it will recur all season.** The Pick'em
tests assume the current NFL week has no started games. Week 1 kicked off
2026-09-09, so ESPN now reports one of the 16 week-1 games as `Final`; the
tests pick the week's first two games, one is legitimately locked, and every
downstream assertion cascades. Fixing it means seeding fixtures instead of
reading the live scoreboard, or selecting a week with no started games. Left
alone deliberately — rewriting Pick'em tests is not Phase 2's business, and it
is a real decision about how that suite should work.

### Exact next implementation-ready task

Phase 3, the scheduled ingestion pipeline, still local:

1. The offline normalizer already exists (`scripts/epa/`); add pinned
   dependencies and dry-run / one-game / one-week / season modes for it.
2. A GitHub Actions workflow with `workflow_dispatch`, posting bounded payloads
   to `POST /epa/import/:league` with the dedicated secret.
3. An independent CFB job following the source's publication window. **Do not
   fix its recheck window yet** — whether truncated college games heal, and how
   fast, is still unmeasured (§26).
4. Coverage artifacts and documented replay steps.

Two things worth doing before or alongside it, neither blocking:

- **Fix the Pick'em test fragility above.** It will now fail every week of the
  season and makes `test.sh` harder to trust as a regression signal.
- **Re-run `coverage --league cfb --season 2026 --week 1`** once the upstream
  actually republishes, to answer the healing question.

Still open from §23: the two disposable test pools in production D1, the D1
paid-plan/backup question, and the Worker error-rate alert.

## 28. EPA Phase 2 contract-correction pass — 2026-09-10

**Scope:** Phase 3 paused. Phase 2 brought into line with the accepted contract
in `NFL-IMPLEMENTATION-PLAN.md`, all ten requested items. All local: **no
remote migration, no secret write, no deploy, no commit, no push.** Design
detail is in `worker/EPA-PHASE2.md`; the choices that could have gone another
way are in `DECISIONS.md` ("EPA contract-correction decisions").

**Branch/commit:** `main`, still aligned with `origin/main` at `5dfc989`.
Nothing committed. The frontend is untouched.

### What changed

- **Drives** are now first-class, and are **real provider data**. Both
  upstreams publish drive summaries directly (nflverse `fixed_drive*`,
  cfbfastR `drive.*`), so the offline normalizers, payloads, validators,
  migration `0005`, storage and the size projection were all extended. Result,
  play count and yards are the source's own; only EPA is derived.
- **NFL drive yards are null and stay null.** nflverse has no drive
  net-yards field, and subtracting its yard-line strings would be the
  field-position inference the contract forbids — and would be wrong on any
  drive with a penalty or change of possession. CFB has a real `drive.yards`.
- **The split-denominator bug is fixed.** Defensive pass/rush EPA was being
  divided by *all* defensive plays. Split success rates needed numerators the
  schema did not have, so `0005` adds `def_pass_success_allowed` /
  `def_rush_success_allowed` rather than approximating them.
- **Teams return away then home**, impact plays carry `clock` and `driveId`
  with a deterministic play-id tiebreaker, ranking is defined for both offence
  and defence with the direction stated in the response, player identity is the
  latest team by chronology instead of `MAX(team)`, and coverage/provenance
  match the contract's blocks.
- **The EPA routes use the contract's camelCase keys**, unlike the older
  `/stats/nfl/...` snake_case routes. Deliberate, confined to the EPA tree, and
  recorded as a decision.

### The Pick'em harness

Rebuilt on deterministic fixtures rather than a different "future" week.
`ESPN_SCOREBOARD_BASE` overrides the scoreboard host — unset in production and
in `npm run dev`, pointed at `test/fixtures/scoreboard-server.mjs` by the new
`npm run dev:test`. `test.sh` starts the fixture server itself and **refuses to
run against live data**, checking `/health`'s `scoreboard_override` flag first.
The Worker remains the authority on kickoff, eligibility and results; only the
address it reads changes. The two in-test seed scripts were repointed at the
same fixtures — seeding from live ESPN while the worker served fixtures
produced picks whose event ids did not exist in the pool week, so nothing
scored.

### Results

**`npm run test:stats`: 88 passed, 0 failed.**
**`./test.sh`: 244 passed, 0 failed — fully green.**

The 12 calendar-dependent Pick'em failures recorded in §27 are gone, and they
are gone because the dependency was removed, not because a different week was
chosen.

Storage re-measured with drives: **125.5 MB** for the approved 2025+2026
backfill, up from 116.1 MB, still about 25% of the 500 MB free tier.

### Two things worth knowing

- **`schema.sql` and migration `0005` are different artifacts.** `schema.sql`
  is the **repeat-safe canonical final schema**: every statement is
  `CREATE ... IF NOT EXISTS` and the columns `0005` adds are inline, so
  applying it twice is a no-op and `npm run db:schema:local` stays re-runnable.
  `migrations/0005_epa_drives_and_coverage.sql` is the **one-time migration**
  for a database that already has `0003`/`0004`; it uses `ALTER TABLE ADD
  COLUMN`, so it must be applied exactly once and **migration tracking is what
  prevents a second application**. Both routes produce identical table
  definitions, and the schema test proves it.
- **One assertion has no teeth, and says so.** The impact-play tiebreaker test
  cannot detect removal of the `play_id ASC` clause: the plays table's primary
  key is `(event_id, play_id)`, so SQLite already returns ties in play-id
  order. Measured, with ids inserted in descending order. The clause stays
  because incidental index behaviour is not a guarantee, but the limitation is
  recorded in the test.

### Exact next implementation-ready task

Phase 3, the scheduled ingestion pipeline, still local — unchanged from §27:
pinned dependencies and dry-run/one-game/one-week/season modes for
`scripts/epa/`, a `workflow_dispatch` GitHub Actions workflow posting bounded
payloads to `POST /epa/import/:league`, an independent CFB job, coverage
artifacts and replay steps. **Do not fix the CFB recheck window yet** — whether
truncated college games heal, and how fast, is still unmeasured (§26).

Still open from §23: the two disposable test pools in production D1, the D1
paid-plan/backup question, and the Worker error-rate alert.

## 29. Canonical schema separated from the one-time migration — 2026-09-10

**Scope:** a correction to §28's schema handling. Phase 3 stays paused. All
local: no remote change, no deployment, no commit, no push.

**Branch/commit:** `main`, still aligned with `origin/main` at `5dfc989`.

§28 left `schema.sql` as a concatenation of every migration, which dragged
`0005`'s `ALTER TABLE` statements into it and made the canonical schema itself
non-repeat-safe — `npm run db:schema:local` errored on a second run. That
conflated two artifacts that need different properties:

- **`schema.sql` — the repeat-safe canonical final schema.** Every statement is
  `CREATE ... IF NOT EXISTS`. The columns `0005` adds are now written inline,
  positioned after the last column and before any table constraint, which is
  exactly where `ALTER TABLE` places them. No executable `ALTER` remains in the
  file. Applying it twice is a clean no-op, verified against a real local D1.
- **`migrations/0005_epa_drives_and_coverage.sql` — the one-time migration**,
  unchanged, for databases that already carry `0003`/`0004`. It is not
  repeat-safe and cannot be, and **migration tracking is what must prevent a
  second application**; the duplicate-column failure is a backstop, not the
  mechanism.

`test/epa-schema.test.py` now proves all four required properties:

1. `schema.sql` applies twice to a fresh database with no error.
2. `0001`+`0002`+`0003`+`0004` then `0005` **once** produces table definitions
   identical to fresh `schema.sql` — compared at pragma level (columns, types,
   nullability, defaults, primary keys, indexes, foreign keys) across all 24
   tables, not by SQL text, since the two files are deliberately worded
   differently.
3. A database already holding account, pool, pool-member, pick, snapshot and
   EPA rows comes through `0005` with every row and every pre-existing value
   intact, and the new columns arriving as NULL rather than silently defaulted
   to 0.
4. `0005` applied twice still fails, on `duplicate column`, with the test
   asserting that failure rather than hiding it.

The two older schema tests assumed `schema.sql` was a migration concatenation
and were updated: they now assert that `0001` and `0002` are embedded verbatim
and in order, and build their pre-migration databases from the prefix before
each, which is what they actually needed.

**Results: `npm run test:stats` 88 passed, 0 failed. `./test.sh` 244 passed,
0 failed.** Both re-run against a local D1 rebuilt from the canonical schema.
`db:schema:local` was also run twice in succession to confirm the ergonomic
regression is gone.

One cosmetic fix: `test.sh` now disowns the fixture server so the shell no
longer prints `Terminated` after `passed=244 failed=0`, which read like a
failure.

### Exact next implementation-ready task

Unchanged from §28: Phase 3, the scheduled ingestion pipeline, still local.
**Do not fix the CFB recheck window yet** — whether truncated college games
heal, and how fast, is still unmeasured (§26).

Still open from §23: the two disposable test pools in production D1, the D1
paid-plan/backup question, and the Worker error-rate alert.

## 30. EPA Phase 3 — scheduled ingestion pipeline — 2026-09-10

**Scope:** Phase 3, built and proven locally. **No production secret, no remote
migration, no deployment, no commit, no push.** The workflow file exists and is
**gated off**: every job requires the repository variable `EPA_INGEST_ENABLED`
to be `'true'`, so it does nothing until someone enables it.

**Branch/commit:** `main`, still aligned with `origin/main` at `5dfc989`.
Design detail and the replay/recovery procedures are in `worker/EPA-PHASE3.md`;
the choices are in `DECISIONS.md` ("EPA Phase 3 ingestion decisions").

Added: `worker/scripts/epa/ingest.py`, `worker/scripts/epa/verify-determinism.sh`,
`.github/workflows/epa-ingest.yml`, `worker/EPA-PHASE3.md`. Changed:
`worker/scripts/epa/requirements.txt` (now hash-pinned), `nfl.py`/`cfb.py`
(drive coverage, provider sentinels), `worker/src/epa-validate.js` (drive
rule), `worker/test/epa-validate.test.js` (+2 tests).

### Two data findings that changed the contract

Both were found by running the pipeline against the real Worker rather than by
reading the source, and both would have shipped silently wrong.

- **`drive_play_count` excludes accepted-penalty plays.** Our predicate keeps
  them deliberately, so the modeled count exceeds the provider's on **18.1% of
  2025 drives** (1,041 of 5,745). The first upload of NFL week 1 rejected **all
  16 games** on a validator rule asserting `modeled <= provider`. That rule was
  wrong: the two counts measure different things. Drive coverage is now
  measured against what the model was in scope to score, both counts are
  stored, and there are tests pinning the finding.
- **The college source uses sentinels for "unknown".** `down = 0`,
  `end period = 0`, and **negative athlete ids** for unidentified participants.
  The first CFB upload rejected 9 of 53 games on these. They now become null,
  because that is what they mean — the play and its EPA are kept, only the
  attribution or the down is absent. Storing `0` would render as "0th down";
  storing a negative id would create a player row that can never resolve to
  ESPN.

### Proven, not asserted

- **Determinism — the Phase 3 exit criterion.** `./verify-determinism.sh nfl
  2025 season` runs a full archived season twice: **report byte-identical, all
  272 payloads byte-identical.** Also verified for CFB week 1 (53 games). This
  is load-bearing rather than tidy: the pipeline skips unchanged games by
  content hash, so non-deterministic normalization would make every run look
  like a correction.
- **End-to-end against the local Worker.** NFL 2025 week 1: 16 games,
  2 batches, all `inserted`. CFB 2026 week 1: 53 games, 7 batches, all through;
  a re-run returned **53 `unchanged`**, proving the hash-based skip works from
  both ends.
- **Auth refusal**: with `EPA_IMPORT_TOKEN` unset the runner exits 2 and
  uploads nothing.
- **Workflow structure**: YAML parsed and asserted — two jobs, no `needs:`
  between them, both gated off, manual runs defaulting to dry run, recheck
  window unset by default.

### The CFB recheck window remains unresolved, by design

`--recheck-weeks` is unset by default, which revisits every week still holding
an incomplete game — bounded by the season, and the conservative choice while
the healing behaviour is unmeasured (§26). The workflow input is documented as
"leave blank". Every report records the policy string that was applied. **Do
not put a number there until someone measures when truncated games actually
heal.**

### Results

**`npm run test:stats`: 90 passed, 0 failed.**
**`./test.sh`: 244 passed, 0 failed.**

The unit count is 90 rather than the 88 recorded in §29 because two tests were
added, pinning the drive-count finding above: one asserting a drive may model
*more* plays than the provider counted, one asserting a drive that missed a
play in scope is partial and cannot claim complete.

### Exact next implementation-ready task

Phase 3 is complete locally. Phase 4 is the **controlled production release**,
and it needs explicit authorization — it is the first step in this whole track
that writes to production:

1. Verify the outgoing Worker tree still contains trends, ESPN game-stat
   capture, cron wiring, auth and Pick'em routes.
2. Verify backup/recovery and export a backup **before** any migration. D1 Time
   Travel is 7 days on the free plan and real picks plus unbackfillable
   `stat_snapshots` already live there (§23, still open).
3. Apply `0003`, `0004`, `0005` remotely in order — each a separate approval
   and recovery checkpoint, `0005` exactly once.
4. Deploy the Worker; check `/health`, auth privacy, Pick'em reads, CORS, cache
   headers and the existing stats routes.
5. Set `EPA_IMPORT_TOKEN` (Wrangler secret and Actions secret), `EPA_API_BASE`,
   and only then `EPA_INGEST_ENABLED=true`.
6. Import one archived validation game per league before any backfill.
7. **Public CFB release stays gated on the attribution and data-term review**
   — separate from all of the above.

Also still open: re-measure CFB week-1 coverage once the upstream actually
republishes, to answer the healing question; the two disposable test pools in
production D1; the D1 paid-plan question; and the Worker error-rate alert
(§23).

## 31. Fantasy roster and league integration plan — 2026-09-10

**Scope:** planning only. No fantasy Worker route, schema, provider credential,
frontend view or production state was created. The implementation-ready product,
provider, security, storage, testing and phased rollout plan is in
`FANTASY-INTEGRATION-PLAN.md`.

The recommended provider order is Sleeper, then Yahoo after approval. Sleeper
has an official public read-only API and is the smallest viable connected
integration, but commercial use requires a licensing conversation and its
documented matchup contract guarantees team totals rather than a full live
per-player scoring feed. Yahoo has an official Fantasy API with league settings,
weekly rosters, scoreboards and player points, but access now requires application
review and OAuth. Yahoo's general developer terms also restrict most Yahoo
user-data storage to 24 hours unless the approved API agreement explicitly grants
a longer period, so Yahoo must use expiring cached snapshots rather than permanent
history.

**Accepted ESPN direction:** manual roster-and-rules import. No supported public
Fantasy developer/OAuth program was found, private league access commonly depends
on copying full ESPN web-session cookies, and Disney's current terms restrict
automated extraction without express written permission. Fixtura will not collect
`espn_s2`/`SWID` or ship against ESPN's undocumented internal fantasy endpoints.
The planned import is a versioned CSV roster plus a guided scoring-rules form,
always labeled `Manual import` with an as-of date. Live Fixtura NFL game, stats and
EPA enrichment may update normally, while ESPN lineup, transaction, matchup and
official fantasy-point data remain absent or stale until the user imports again.

The first product remains read-only. Provider integrations keep provider fantasy
scores, rosters, lineups, matchups and rules authoritative; the ESPN manual path
keeps user-submitted roster and rules explicitly identified. Fixtura does not
recalculate or impersonate an official fantasy result.

**Timing:** EPA Phase 3 is now complete locally, but its controlled production
release remains the exact next task in §30. Do not mix fantasy implementation into
that uncommitted release slice. Apply for Yahoo access and clarify Sleeper
licensing when ready; begin Fantasy Phase F0 after EPA is checkpointed. This note
is not authorization for provider signup, credential creation, migration,
deployment, commit or push.

## 32. EPA work committed; an uncommitted Pick'em hotfix found in production — 2026-09-22

**Scope:** commits only. No push, no migration, no deploy in this session.

**Branch:** `epa-pipeline`, cut from `main` at `5dfc989`, not pushed. Commits:

- `d8753f6` Pick'em integration tests against deterministic scoreboard fixtures
  (`ESPN_SCOREBOARD_BASE` override, `test/fixtures/scoreboard-server.mjs`,
  `npm run dev:test`, `/health.scoreboard_override`).
- `d762bd9` `scoreWeek()` writes only newly-final or changed results.
- EPA Worker storage, import and read routes, migrations 0003–0005.
- EPA ingestion pipeline and the gated workflow.
- This docs commit (plans, decisions, handoff, CLAUDE.md delegation policy).

**Found while committing — undocumented production deploy.** `wrangler
deployments list` shows a Worker deploy at **2026-09-22 01:39 UTC** (version
`81efe37c`, 20:39 CDT on 09-21) not recorded anywhere. `pools.js` was edited at
19:20 CDT that evening with the `scoreWeek()` change, whose comment cites D1
free-tier alerts on 2026-09-21. `epa-import.js`, `epa-read.js` and `index.js`
all carry an mtime of 20:39 CDT — the deploy minute — yet production `/health`
lacks the `epa_import_configured` field and `/stats/nfl/epa/...` 404s. The
likely reading (inferred, not proven — Workers does not expose deployed source
here) is that the EPA wiring was temporarily set aside so only the Pick'em fix
shipped, then restored. Treat production as: 2026-09-09 Worker **plus** the
`scoreWeek()` write fix, **without** EPA.

**Validation on the committed tree:** `npm run test:stats` 90/90;
`./test.sh` against `npm run dev:test` 244/244. Staged blobs of the two split
files were syntax-checked separately.

**D1 alerts:** Zach confirmed on 2026-09-22 that no further D1 free-tier
alert emails have arrived since the hotfix deploy.

**Merged:** Zach approved merging `epa-pipeline` into `main` and pushing on
2026-09-22 (fast-forward; no frontend file changed, so the Pages deploy is a
no-op for the app). `main` now matches production's Pick'em code, **but the
next Worker deploy from `main` will also ship the EPA routes** — apply
migrations 0003–0005 to remote D1 first.

**Still open:** everything in §30's Phase 4 list and its trailing items.

**Phase 4 step 2 done — pre-migration backup (2026-09-22 19:31 UTC).**
`wrangler d1 export fixtura --remote` to
`~/Documents/Fixtura-backups/fixtura-d1-2026-09-22-pre-epa.sql` (outside the
repo on purpose: it holds users and session hashes), 3,781,619 bytes, SHA-256
`76777c5690f17c70ef28845fc05f7f2cb49adde1a929874326c0cb8294585e31`. Verified
by restoring into an empty SQLite database: all 12 tables match production
row counts exactly (users 2, sessions 11, settings 4, pools 3, pool_members 3,
picks 22, results 0, stat_snapshots 194, nfl_player_games 2,091,
nfl_player_game_stats 16,654, nfl_stat_games 32, nfl_game_capture_state 32).
Time Travel bookmark at export:
`000005a7-0000000f-000050ee-cf7cb7cf91d8b65a22bb4ba68063bf91`
(`wrangler d1 time-travel restore fixtura --bookmark=...`; free plan keeps 7
days, so this bookmark expires around 2026-09-29).

**Empty `results` — diagnosed 2026-09-22, benign.** From `wrangler d1
insights` (31d/14d/7d/1d windows): the standings query has run 5 times in 31
days and **0 times in the last 14**, i.e. never since Week 1 finished, and
scoring is lazy on that read. All 24 historical `INSERT INTO results` belonged
to disposable pool 4 (seeded with 2025 events) and were removed by a manual
`DELETE FROM results WHERE pool_id = 4` cleanup. There is no delete of pool 3
results anywhere. ESPN's Week 1 scoreboard shows all 16 games `post` with a
winner, so the next Standings read will score Week 1. Week 2 has no picks in
any pool.

**The 2026-09-21 D1 alerts were not caused by Pick'em scoring.** Same insights
data: results scoring wrote **48 rows in 31 days**, while ESPN player-stat
capture wrote ~99.9% of all rows: 288,341 in the last 7 days, 287,981 of them
`nfl_*` capture tables, led by `INSERT INTO nfl_player_game_stats` (246,258
rows over 156 runs, ~1,580 rows per run: each changed capture deletes and
reinserts a whole game's stats). The free tier caps writes at 100k rows/day,
so game Sundays exceed it. The `scoreWeek()` change (`d762bd9`) is harmless
and correct but did not address this; the alerts stopping is explained by no
games since Monday night. **Expect them again on Sunday 2026-09-27** unless the
capture write pattern changes or the account moves to the $5/mo plan (50M
rows/month).

**Capture write fix built, committed, NOT deployed (2026-09-22).** Zach
declined the $5/mo plan for now, so the capture write volume has to fall
below 100k/day before Sunday 2026-09-27. Root cause, now measured: ESPN
revises **adjusted QBR** on finished games for days without moving
`meta.lastUpdatedAt`; each revision changed the content hash and the store
deleted and reinserted the whole game. A read-only diff of all 32 stored
production games against fresh ESPN: 29 unchanged (diff empty, which also
proves the new comparison matches D1's stored values), 3 changed only in
adjQBR, 1–3 cells each. `game-stats-store.js` now writes only changed rows,
guarded by an optimistic check on the stored hash with re-read-and-retry.
`game-stats-capture.js` backs off games still partial 12h after kickoff to the
6h/24h schedule and logs changed-row counts per run. Estimated Sunday cost is
dominated by first captures, ~16 games × ~1,800 row writes ≈ 30k.
Validation: `test:stats` 91/91, `test:stats:d1` 2/2 (new test proves a
diffed correction ends byte-identical to a from-scratch write, and fails if
deletes are disabled), `test.sh` 244/244.

**Migration 0003 applied to remote D1 (2026-09-22).** Pre-apply Time Travel
bookmark `000005ac-00000000-000050ee-723160e897eebd5c48317d97d4d0da18`.
`wrangler d1 execute fixtura --remote --file=migrations/0003_nfl_epa.sql`,
22 rows written. Verified: all 5 `nfl_epa_*` tables and 6 named indexes exist,
matching a local apply of the same file; users 2, picks 22, pools 3,
stat_snapshots 194, nfl_player_game_stats 16,654 unchanged; `/health` ok. The
deployed Worker does not reference these tables yet. `0004` and `0005` applied, below.

**Migration 0004 applied to remote D1 (2026-09-22).** Pre-apply bookmark
`000005ad-00000002-000050ee-601f78bd0f99418c4010adb671c67767`; 21 rows written.
Verified: all 5 `cfb_epa_*` tables and 6 `idx_cfb_*` indexes exist, matching a
local apply; existing counts unchanged; `/health` ok.

**Migration 0005 applied to remote D1 (2026-09-22) — do not run it again.**
Pre-check: none of its 16 columns or 2 drive tables existed, all EPA tables
empty. Pre-apply bookmark
`000005ad-0000000c-000050ee-feb13ffd23afb8e0356afc32d7f6cfad`; 23 rows
written, no error. Verified: all 39 EPA objects and all 216 columns across the
12 EPA tables (name, type, not-null, pk) match a fresh local apply of
`schema.sql`; existing counts unchanged; `/health` ok. Remote D1 schema now
matches `main`.

**Worker deployed from clean `main` (2026-09-22 20:30:10 UTC), version
`6aeb079f-5c7a-48c3-8bc6-a120a47deffe`, commit `986dd49`.** Production now
carries the capture write fix, the Pick'em `scoreWeek()` fix, and the EPA
routes. Verified against a pre-deploy snapshot of the same requests:
`/health` ok with `epa_import_configured: false`, `scoreboard_override: false`;
`/stats/nfl/coverage`, `/stats/nfl/leaders`, `/stats/nfl/players/:id/games`,
`/trends/leaders` status, cache headers and bodies unchanged (coverage differed
only in `last_seen_at`, from a cron run in between); `/me` and `/pools` 401
`no-store, private`; ESPN proxy 200 `max-age=30`; EPA reads
`/stats/{nfl,cfb}/epa/coverage`, `/stats/nfl/epa/teams`, `/players` 200
`public, max-age=300`, an unimported game 404 `no-store`; `POST
/epa/import/nfl` without a token 503; an off-list Origin gets no CORS header.
The first post-deploy cron (15:30:25 CDT) had no games due and wrote nothing.

### Code review fixes — 2026-09-22 (deployed 2026-09-23)

A whole-repo review found nine issues; all are fixed in commits `0557b93`..
`da36ae5` plus this docs commit:

- **Pick'em scoring** (`0557b93`): `scoreWeek()` counted all of a week's
  results against the picked-game count, so unpicked finals could leave a
  picked game unscored forever; standings counted every unscored pick (and a
  pick-less member) as a push. New `test.sh` pool: all 4 checks fail on the old
  code.
- **EPA store** (`0651cbb`): row-level diffs instead of delete-and-reinsert
  (same write-volume problem as the stat capture), with a stored-hash guard and
  re-read; stale/superseded imports no longer overwrite import state.
- **Ingest workflow** (`910f023`): exit 3 was unreachable under `bash -e`.
- **Login CSRF** (`45a9cfc`): sign-in nonce in sessionStorage → signed state →
  `fixtura_nonce` → checked by `initAuth()`.
- **Odds route removed** (`55bb3b3`): a public keyed route spends a paid key for
  anyone; never used, key never set.
- **Update banner Reload** (`da36ae5`): refetches modules/CSS with
  `cache:'reload'` first.
- **CLAUDE.md**: test recipe (`npm run dev:test`), refresh/auto-refresh text,
  the service-worker rationale, scoring and sign-in notes, the deploy warning.

Validation: `test:stats` 94/94, `test:stats:d1` 2/2, `test.sh` 249/249 (fixture
mode); browser check of the frontend at localhost:8123 (forged token ignored,
matching nonce accepted and consumed, all tabs load, no module errors).

**Deploy order matters:** the new frontend refuses a token without
`fixtura_nonce`, and only the new Worker returns one. Deploy the Worker
(`npm run deploy` from clean `main`) **before** `git push`, or sign-in fails
for anyone on the new frontend until the Worker catches up. The Worker change is
backward compatible with the current frontend.

**Deployed 2026-09-23, Worker first:** Worker version
`3623aaa8-9e3f-4387-a50f-acf11e351e8a` from clean `main` at `c26160f`, then
`git push` (`42420b0..c26160f`); Pages served the new modules ~50s later.
Verified: `/health` ok and `proxy_routes` no longer lists `odds`; `/odds/...`
404; `/auth/google/start` carries a supplied nonce in the signed state, refuses a
malformed one (400), and still redirects without one (older cached app);
`/me`/`/pools` 401 signed out; stats, EPA, trends and ESPN proxy routes 200. Live
site in a browser: 7 tabs, 21 modules, no console errors. A full real Google
sign-in round trip was not exercised by the agent — Zach's next sign-in is the
first end-to-end test of the nonce path.

Unverified: the first post-deploy capture run's `changed` counts. The
`wrangler tail` left running through 16:00 CDT captured only a fetch event, not
the scheduled run; check Workers Logs in the dashboard, or D1
`nfl_game_capture_state.last_attempt_at`, instead.

### EPA import enabled (Phase 4 steps 5–6) — 2026-09-23

- `EPA_IMPORT_TOKEN` generated (`openssl rand -base64 48`, never printed) and set
  as a Wrangler secret; `/health` reports `epa_import_configured: true`. The
  value sits in `~/Documents/Fixtura-backups/epa-import-token.txt` (mode 600,
  outside the repo) for Zach to paste into the GitHub Actions secret; delete it
  afterwards — it can always be rotated with a new `wrangler secret put`.
- **Validation imports into production:** NFL `401772810` (2025 wk 1): inserted,
  122 modeled plays / 27 drives, read back via `/stats/nfl/epa/games/…`, a
  re-import returned `unchanged`. CFB `401856634` (2026 wk 1): inserted, 120/146
  plays, 23 drives, read back.
- **First-run size, from a dry run of both 2026 seasons:** 32 NFL games (~5.1k
  rows) and 53 CFB games (~9.1k rows), ~50k D1 row writes with indexes if both
  ran; NFL alone is ~18k. Later runs write only changed rows.
- **CFB has its own switch:** the workflow's `cfb` job now also requires
  `vars.EPA_CFB_ENABLED == 'true'`. Public CFB EPA stays gated on the
  attribution/data-terms review, and the read routes are public, so leave it
  unset until that review is done. The one CFB validation game above is
  readable publicly; nothing links to it.
- **Zach-side, GitHub → Settings → Secrets and variables → Actions:** secret
  `EPA_IMPORT_TOKEN` (from the file), variables `EPA_API_BASE =
  https://fixtura-api.fixturaapp.workers.dev` and `EPA_INGEST_ENABLED = true`.
  The schedule is 11:30 UTC daily.

**Exact next task:** confirm the first cron run that rechecks a game logs
`changed` counts in the low single digits (Workers Logs is enabled), then watch
Sunday 2026-09-27's D1 rows-written stay under 100k. After that, the rest of
§30 Phase 4: set `EPA_IMPORT_TOKEN` (Wrangler + Actions secret) and
`EPA_API_BASE`, then `EPA_INGEST_ENABLED=true`, then one archived validation
game per league. Public CFB stays gated on the attribution/data-term review.
