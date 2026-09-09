# Handoff — redesign + NFL dashboards

**Current status:** see the 2026-09-08 Codex update at the end. The original
sections below preserve the Claude handoff and its historical status.

Written 2026-09-07, at the end of the planning/prototype session that opened this
track. Everything here is either a fact verified that day or a decision Zach
actually made. **Nothing visual is approved** — the prototype is a draft.

Read `AGENTS.md` first for current Codex operating instructions; this document assumes
them and does not repeat them. The short version of the ones that bite hardest:
**no build step, no bundler, no framework, no npm at runtime**, ES modules loaded
as static files, one flat stylesheet, `esc()` on every string rendered into HTML,
and **no invented data** — if ESPN doesn't publish it, don't model it.

---

## 1. Where the work actually stands

| Piece | State |
|---|---|
| Leaderboard snapshot cron | **Shipped, deployed, verified in production** |
| Everything visual | **Draft only.** Lives in a published artifact, not in the repo |
| Repo branch | `redesign-nfl-dashboards`, not merged to `main` |

### The one hazard to know before touching anything

`wrangler deploy` ships the working directory and knows nothing about branches.
`worker/src/trends.js` is **running in production but exists only on the
`redesign-nfl-dashboards` branch**. Deploying from `main` silently reverts it —
the weekly capture stops and `/trends` 404s, with no error anywhere. Merge the
branch, or deploy only from it.

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
