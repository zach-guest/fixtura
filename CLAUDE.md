# Fixtura

A personal multi-sport dashboard — scores, schedules, rosters, stats, F1, and a
fixture calendar. Built to replace juggling ESPN, Sleeper, and a pile of apps.

Called "Pressbox" until 2026-08-16. The name is provisional; the old one was
dropped because the domain was taken.

## The hard constraint

**One self-contained HTML file. No build step, no dependencies, no backend.**
Google Fonts is the only external asset; everything else is inline. Deployed by
dropping one file on a static host.

Do not introduce a bundler, framework, or npm dependency into the frontend
without explicitly agreeing to abandon this constraint first. The zero-friction
deploy is a feature, not an accident.

## Layout

- `index.html` — the entire app, ~1,650 lines.
- `worker/` — a Cloudflare Worker API proxy. **Written but never deployed.** The
  frontend does not reference it. See "Open decisions" below.

Before git, versions were hand-saved copies in `old versions/`; those 14
snapshots and the original `HANDOFF.md` this file draws from live in history
(`git log --diff-filter=D --name-only` to find them).

## Running it

Open `index.html` in a browser, or serve the folder:

```bash
ruby -run -e httpd . -p 8123
```

Both work from a normal terminal. Under the agent sandbox neither does: system
`python3` can't call `getcwd` at import, and WEBrick hits the same wall when the
harness spawns it. Open the file over `file://` to verify instead — the ESPN
endpoints are CORS-open, so the app works fully from a file URL.

**Verifying a change under the agent.** There is no `node` on this machine, so
there's no CLI syntax check — load the file in the browser pane and read the
console instead. The pane **serves a cached snapshot**: injected state is dropped
between a `javascript_exec` and a later `screenshot`, so a screenshot can show a
stale render and quietly mislead you. Do assertions **programmatically** in a
single `javascript_exec` that sets up state and returns its own findings, and
treat screenshots as a look at the visuals only. Driving the real code paths
(`openGame()`, clicking the real tab buttons) catches wiring bugs that calling a
renderer directly does not.

**Finding a live game to test against:** scan the scoreboard for
`status.type.state === 'in'`.

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" \
 | python3 -c "import sys,json;[print(e['id'],e['shortName'],e['status']['type']['detail']) for e in json.load(sys.stdin)['events'] if e['status']['type']['state']=='in']"
```

NFL preseason runs in August; the regular season resumes in September. Between
seasons the scoreboard returns only `pre`/`post` games and the live paths can't
be exercised at all.

## Deploying

Live at **https://zach-guest.github.io/fixtura/**, GitHub Pages serving `main`
from the repo root. There is no build and no CI — pushing to `main` is the
deploy:

```bash
git push
```

The predecessor repo `zach-guest/pressbox` still exists and still serves the old
Pressbox-branded build at `zach-guest.github.io/pressbox`. It is superseded;
delete it once nothing points there.

### Deploying is instant; the client is not

Pushing updates the site immediately, but a user can sit on an old build for a long
time, which looks exactly like "the feature didn't ship":

- GitHub Pages sends `cache-control: max-age=600`, so a tab already open keeps the
  old file for ten minutes.
- Zach runs Fixtura as a Safari **"Add to Dock" web app** on the Mac
  (`~/Applications/Fixtura.app`, a template bundle whose `Manifest.start_url` is
  `https://zach-guest.github.io/fixtura/`). It **suspends instead of reloading**, so
  it can serve a build from days earlier. Closing the window is not enough — Cmd+Q,
  or Cmd+R inside the window.

`checkForUpdate()` handles this in-app: it HEADs the page's own URL and watches the
`ETag`. Same-origin, so the header is readable; HEAD, so there's no body to download.
It runs on load, every 10 minutes, and **on focus / visibilitychange** — the focus
case is the important one, since that's exactly when a suspended web app resumes. A
changed ETag raises a "new version available" banner. Settings shows the served
build's `Last-Modified` so "am I on the latest?" is answerable directly.

A service worker would be the textbook fix and is deliberately not used: it needs a
second same-origin file and would break the single-file constraint.

## Architecture

Section banners in the source (`/* ===== NAME ===== */`) mark the boundaries:
LEAGUES, STATE, UTIL, THEME, GAME CARD, SETTINGS PANEL, the per-view renderers,
then wiring at the bottom.

State is plain module-level `let`. No framework, no reactive layer — views
re-render by assigning `innerHTML` and re-wiring handlers.

- **Themes** — five, as CSS custom properties on `html[data-theme=...]` at the
  top of the `<style>` block: paper (light, default), midnight, ice, terminal,
  crimson. A new colour must be added to all five or one theme breaks. Never
  hardcode a hex outside those blocks. Responsive breakpoint at 700px.
- **Tab row** — data-driven, not hardcoded. `VIEW_LABELS` defines every view that can
  exist; `VIEW_ORDER` (persisted to `sb-views`) is the visible subset in display order.
  `renderNav()` builds the row and rewires it. Settings offers up/down reordering and
  hide/show. Two guards must survive any refactor: the last visible tab cannot be
  hidden, and hiding the view you are currently on moves you to the first visible one.
- **Views** — SCORES, TEAMS, F1, GOLF, CALENDAR.
  - *Scores*: league chips plus a LIVE NOW chip that scans `LIVE_SCAN` and
    filters to in-progress games. Day/Week toggle (week uses ESPN's
    `dates=YYYYMMDD-YYYYMMDD` range syntax), date picker, arrow-key nav.
  - *Teams*: favourites bar, cross-league search, per-team schedule / roster /
    injuries.
  - *F1*: next race with session times, season calendar (click a completed round
    to expand results and qualifying inline), driver and constructor standings.
  - *Golf*: six tours (`GOLF_TOURS`) — PGA, LPGA, LIV, DP World, Champions, Korn Ferry.
    Golf is a field, not two teams, so it has its own renderer rather than reusing
    `gameCard()`. ESPN leaves `status.position` empty on finished events, so
    `golfPositions()` derives ranks from scores and adds the `T` tie prefix. A
    competitor's `id` *is* the athlete id, so rows open the normal player modal.
    Three sub-tabs, all built from free ESPN data:
    - *Leaderboard* — position, total, `thru`, per-round. Rows expand in place to a
      hole-by-hole scorecard colour-coded against par, plus that round's stats
      (driving distance, fairways, GIR, putts/GIR, sand saves) lazily fetched from
      `playersummary` on expand rather than 50x up front.
    - *Course* — field-wide hole difficulty: average strokes over par per hole across
      everyone who has posted it, with par, yardage and a diverging bar. Real derived
      analytics from free data; no modelling and nothing inferred.
    - *Today* — best completed round, and who is climbing or sliding, comparing
      position now against position through the previous round.
    Refreshes every 60s via the global timer (previously scores-only), keeping the
    sub-tab, the expanded player and scroll position.
    The sub-tabs use `.gtabs` (the app's underlined tab-row style), **not** `.chip` —
    they shipped as chips first and were invisible, reading as more tour filters
    sitting under the real ones. A row of tabs and a row of filter chips are
    different controls and must not look alike. Leaderboard rows carry a `.gcar`
    chevron and a one-line hint because nothing else signals that they expand.
  - *Calendar*: month grid with favourite teams' logos on days they play.
- **Drive view** (football only) — a `Drive` tab in the game modal: a
  hover-readable win-probability chart, an animated 100-yard field with
  team-coloured end zones, and an expandable drive list naming the scorer on each
  scoring drive. Built entirely from `summary?event=`, which the modal already
  fetches — no extra request, no key, no Worker. The tab is added to the tab array
  only when `hasDrives()` passes, and `drawModal()` falls back to Box Score if the
  current tab isn't in the row (otherwise opening a baseball game while on Drive
  renders an empty body).
  - *End zones* take each team's `team.color` from the header competitors. The
    offense always attacks right, so the right end zone is the defending team's and
    the colours swap as possession flips — the abbreviations are drawn in because
    colour alone is ambiguous once they swap. `onColor()` picks black or white for
    the label from the fill's WCAG luminance; this is the one place a literal colour
    is correct, since a theme token can't be guaranteed to contrast with arbitrary
    brand hex.
  - *Animation* — the ball mounts at the play's start and moves to its end on the
    next frame via a CSS transition. Guarded by play id (`lastAnimPlay`) so
    re-rendering for any other reason snaps to the final position instead of
    replaying. Honours `prefers-reduced-motion`.
  - *Refresh* — `startDriveRefresh()` runs a **20s** timer scoped to this tab, this
    game, and `state==='in'` only. It re-renders the tab body in place, preserving
    scroll position and which drive is expanded, and stops on tab change, modal
    close, or the game going final. Polling faster than 20s is wasted: plays land
    ~30–45s after they happen (see Data sources).
- **Game detail modal** — tabs for Box Score, Lineups, Rosters, Injuries, Team
  Stats, Plays, Odds, Venue, Info. Team names in the header navigate to the team
  page; player names open a second-level modal with bio and career stats.
- **Team colours** — `header.competitions[0].competitors[].team` carries `color` and
  `alternateColor` as **bare hex with no `#`**, and omits them for some teams.
  `teamColors()` normalises and guards both.
- **Config** — `LEAGUES` maps a key to an ESPN path; `SOCCER_GROUPS` expands into
  `soc:<espn-code>` entries; `PRIMARY` is the tab row, `DEFAULT_TICKER` the
  ticker, `DEFAULT_TEAMS` the starting favourites.
- **Persistence** — `localStorage` under `sb-*`: `sb-favs`, `sb-ticker`,
  `sb-theme`, `sb-teams-<league>` (30-day cache), `sb-views` (tab order/visibility),
  `sb-lastview` (reopens where you left off). Keys keep the old `sb-` prefix
  deliberately so a rename never wipes saved teams. Don't "tidy" them.
  Every write goes through `store()`, which swallows failures — localStorage is
  disabled entirely under `data:`/`file:` in some previews, and the app must still run.
- **Refresh** — clock every 30s; scores and ticker every 60s.

### Golf data — what ESPN does and doesn't have

Checked against a live tournament, 2026-08-21.

- **No shot-level data, at all.** `playByPlayAvailable` and `shotChartAvailable` are
  both `false` for golf. Shot coordinates come from ShotLink, which PGA Tour licenses
  to enterprises; there is no free or cheap route to it. **Do not "work around" this
  by modelling shot positions from hole scores** — a hole score is one number and the
  set of shot sequences producing it is enormous, so any such map is invented, not
  inferred. It would also destroy the app's credibility with exactly the people who
  care, since the broadcast shows where the ball actually is.
- **The core API has much more than the site scoreboard.**
  `sports.core.api.espn.com/v2/sports/golf/leagues/{tour}/events/{id}` carries the full
  course card (`courses[0].holes[]` with `shotsToPar` and `totalYards` per hole),
  **live weather at the course** (wind speed/direction/gusts, temp, precip), purse,
  defending champion, and `isCupPlayoff`. Cached per event in `ensureGolfCourse()`.
- **Par is not on the scoreboard.** Hole scores are, par isn't — it comes from the
  course card. Hole difficulty needs both.
- **Hole-by-hole scoring only exists on some tours.** PGA and Korn Ferry publish it;
  DP World, LPGA, LIV and Champions publish round totals only. `hasHoleData()` gates
  the scorecard and difficulty table, and the Course tab falls back to a plain course
  card. Never assume `linescores[].linescores[]` is populated.
- **`playersummary` is richer than the leaderboard** — 26 per-player stats including
  driving distance, driving accuracy %, GIR, putts per GIR and sand saves, plus par
  per hole. This covers most of what a paid provider would be bought for; the genuinely
  exclusive paid data is strokes-gained by category and proximity.
  `site.web.api.espn.com/apis/site/v2/sports/golf/{tour}/leaderboard/{event}/playersummary?player={id}`
  — the `season` param the community docs mention is optional.

## Data sources

All public, all keyless, all called straight from the browser.

| Source | Used for | Notes |
|---|---|---|
| `site.api.espn.com/apis/site/v2/sports` | scoreboards, schedules, summaries, rosters | Undocumented, CORS-open |
| `site.web.api.espn.com/apis/common/v3/sports` | athlete profile / bio / stats | Same |
| `sports.core.api.espn.com/v2` | venues, team lists (fallback), athlete core record | Same |
| `api.jolpi.ca/ergast/f1` | all F1 data | **200 req/hour, 4/sec** — a real limit |
| `en.wikipedia.org/w/api.php` | venue photos, player photo fallback | `origin=*` for CORS |
| `open-meteo.com` (+ geocoding) | venue weather | 10k/day, non-commercial |
| `a.espncdn.com` | team logos | |

**ESPN live play-by-play — verified working** (tested against an in-progress game,
2026-08-21). All keyless, all `access-control-allow-origin: *`:

```
sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{ID}/competitions/{ID}/plays?limit=300
                                                          .../competitions/{ID}/drives
                                                          .../competitions/{ID}/probabilities?limit=300
```

`probabilities` returns one record per play with `homeWinPercentage`,
`awayWinPercentage`, `tiePercentage`, plus `spreadCoverProbHome` and
`totalOverProb` — free odds-adjacent data worth remembering for betting work.

**Prefer `summary?event=` for opening a game** — it already carries
`winprobability` and `drives` inline, and the modal fetches it anyway. But it is
**~520 KB**; the three narrow endpoints above are a few KB each. If you ever poll
faster or on more games, switch to those rather than re-pulling the summary.

A `plays` item's `team`/`probability`/`drive` fields are `$ref` URLs, not inline
objects — the copies nested inside `drives` are fully inline, which is why the
drive view reads from `drives` and never dereferences anything.

ESPN's `summary?event=` carries **`winprobability`** (one entry per play) and
**`drives`** (current + previous, plays inline) alongside the box score. Measured
live during a 2026 preseason game, new plays appeared **~30–45s after the play
happened** (n=9; min 30s, median 38s, max 71s) — roughly streaming-broadcast
delay, so the feed lands about when a streaming viewer sees the play. Win
probability was attached to every play on arrival, never lagging behind it.

ESPN's endpoints are undocumented, unversioned, and have no stated limits.
Fields are often missing rather than null — guard every access. Treat politely;
the caching exists partly for this reason.

## Hard-won details — DO NOT REGRESS THESE

Each was a real bug found in testing. All are non-obvious and easy to reintroduce.

1. **Soccer starter detection.** ESPN marks bench players `formationPlace: "0"`.
   A truthiness check reads `"0"` as a starter and flags all 23. Use
   `isStarter()`: explicit boolean first, then `+formationPlace > 0`. Soccer caps
   at 11, basketball at 5.

2. **Soccer pitch layout** — `pitchHTML()` / `parsePos()` / `lineOf()` /
   `lateral()` / `attackRank()` interlock:
   - Position codes look like `CD-L`, `AM-R`, `RWB`, `LM`. Parse into base role
     plus flank.
   - `lineOf()` must test midfield (`/M$/`) *before* defense or `DM` reads as a
     defender. Defense uses **exact** matches (`WB|FB|B|CB|CD|D|SW`) for the same
     reason.
   - `lateral()` must weight wide roles as further from centre than central ones
     (fullback 2, centre-back 1), or you get LB, CD-L, RB, CD-R instead of
     LB, CD-L, CD-R, RB.
   - Midfield splits into rows by `attackRank()` (DM=0, CM/LM/RM=1, AM=2), **not**
     raw `formationPlace`, which produced nonsense pivots.
   - Trust the formation string only when its counts match the real position
     counts; otherwise fall back to plain G/D/M/F rows.

3. **Team schedules** — `fetchTeamEvents()` guards three failure modes:
   - `seasontype=1|2|3` is a US-sports concept. **Never send it for soccer** —
     it malformed every PSG request.
   - Query alternate season years **only when the default call returns nothing**.
     Querying several and merging produced 201 "upcoming" Cardinals games.
   - Final fallback sweeps the league scoreboard across four date ranges (−60 to
     +180 days) and filters for the team. This is what rescues soccer fixtures.

4. **Team list loading.** ESPN's `/teams` fails in some environments.
   `ensureTeams()` tries the site API twice, then falls back to the core API
   **with pagination** — an earlier 160-team cap meant Texas Longhorns never
   loaded and only Texas A&M appeared for "texa".

5. **Logos.** Soccer responses omit the `logos` array US sports include.
   `logoOf(team, leagueKey)` checks both shapes, then builds
   `a.espncdn.com/i/teamlogos/{sport}/500/{id}.png`. Every logo `<img>` needs an
   `onerror` handler.

6. **Ticker.** Constant 60 px/sec derived from measured width — a fixed duration
   made it crawl or fly depending on game count. Content repeats to exceed the
   viewport, then duplicates exactly twice for a seamless `-50%` loop. Spacing is
   padding *inside* items, not flex `gap`, or the wrap hitches. Skip repaints
   when content is unchanged so the animation doesn't restart.

7. **Auto-refresh.** Scores view only, only when no modal is open, and it reloads
   only the game list. The user specifically complained about being yanked out of
   a player profile.

8. **Venue images.** Wikipedia images are filtered by `BAD_IMG` plus a ≥600px
   width and aspect-ratio check — without it a generic "sports balls and dice"
   portal graphic appeared. Filenames containing interior/pitch/field/stand/
   panorama score to the front.

9. **ESPN drive + win-probability shapes.** All four of these were real bugs while
   building the Drive view:
   - `drives.current` is **also the last element of `drives.previous`**. Appending
     it renders the in-progress drive twice. `allDrives()` dedupes by id.
   - `drive.start` / `drive.end` carry only `yardLine` and `text` — **no
     `yardsToEndzone`** — and `drive.end` is `null` while the drive is live. Derive
     a drive's field span from its own first and last *play*, which do carry it.
   - Prefer `yardsToEndzone` over `yardLine` everywhere. It's the only
     field-position value that doesn't depend on knowing whose half you're on.
   - ESPN has win probability but **no EPA**. There is no expected-points field
     anywhere in `summary` or the core `plays` feed — don't go looking. EPA is
     nflverse-derived and post-game only, from a different provider.

10. **Drive view rendering.** The field SVG uses `preserveAspectRatio="none"` so it
    stretches to any width — which turns an SVG `<circle>` into an ellipse and
    distorts `<text>`. The ball marker and the yard numbers are therefore
    absolutely-positioned **DOM** elements over the SVG, not SVG nodes; strokes use
    `vector-effect:non-scaling-stroke` so the stretch never thickens a line.
    Separately, `wpPct()` clamps to `<1%` / `>99%` — rounding a live 0.4% down to a
    flat "0%" reads as mathematically eliminated, which it isn't.

11. **Naming a scoring play.** `scoringPlays[].id` matches a play id *inside* a
    drive (verified 9/9 on a real game), so a drive's scorer is a lookup, not a
    text match against the drive. The scoring text reads
    `"Jordan Watkins 17 Yd pass from Adrian Martinez (Eddy Pineiro Kick)"` — the
    scorer is everything before the yardage, which `scorerOf()` takes with
    `/^([^0-9]+?)\s+\d/`. `athletesInvolved` and `participants` are **null** on
    these records, so the text is the only source. On a defensive or return
    touchdown the scorer is *not* on the drive's team; that's correct, don't
    "fix" it.

12. **`.fbar` was already taken.** The footer's refresh bar uses `.fbar`; the drive
    view's gain bar is `.fgain`. The app has one flat global stylesheet and no
    scoping, so **check a new class name against the existing file before using it**
    — the collision here was silent, since the field-scoped CSS rule still matched
    only the right element while `document.querySelector('.fbar')` returned the
    footer.

13. **Golf: ESPN pads the round list.** A tournament in round 2 reports *three*
    `linescores` entries, the third empty. Counting rounds off `linescores.length`
    double-counts a round nobody has played, which breaks `thru`, the round columns
    and the movers comparison. Use `activeRounds()`.

14. **Golf: never rank by cumulative strokes.** Mid-round, a player three holes in has
    more strokes than one who hasn't teed off, so ranking by strokes buries everyone
    currently on the course — the first version of the movers table showed the joint
    leader as having dropped 41 places. Rank by score **to par** (`toPar()` parses
    `E` / `-5` / `+2`), and make it tie-aware.

15. **Golf: a round in progress reports running strokes.** `linescores[i].value` is
    10 after three holes, which reads as a score. Show `displayValue` (to par) until
    the round is complete, and derive `thru` from posted holes since ESPN has no
    `thru` on the scoreboard.

16. **A wide element inside a `colspan` cell stretches the whole table.** The expanded
    scorecard forced the leaderboard's Pos column to 177px and pushed Total/Thru off
    screen, because a table's min-content width includes its widest cell. `.gwrap` is
    capped with `max-width:calc(100vw - 44px)` and scrolls internally.

## Known limitations

- **Soccer player headshots are sparse.** ESPN doesn't license them for most
  non-domestic players; the Wikipedia fallback covers well-known names only. No
  free API fixes this — Sofascore and FM/FIFA databases are not openly
  accessible.
- **College player bios are thin** compared to pros. An ESPN-side gap.
- **No multi-user anything.** Favourites are localStorage, per-device.
- **Betting data is limited** to whatever ESPN's `pickcenter` returns.

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

## Working style

Zach is a data analyst: strong SQL, growing Python, newer to JS, and recently
switched from Windows to macOS. He tests thoroughly and reports bugs with
screenshots.

Several past fixes failed because they were guesses rather than diagnoses. When
something breaks, **add real error reporting** — actual status codes, per-attempt
failure reasons — rather than layering on another speculative fallback.

Say plainly when something isn't possible (soccer headshots, social feeds)
instead of shipping a workaround that half-works.
