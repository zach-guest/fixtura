# Fixtura

A personal multi-sport dashboard — scores, schedules, rosters, stats, F1, and a
fixture calendar. Built to replace juggling ESPN, Sleeper, and a pile of apps.

Called "Pressbox" until 2026-08-16. The name is provisional; the old one was
dropped because the domain was taken.

## The hard constraint

**No build step, no bundler, no framework, no npm dependency at runtime.**
Google Fonts is the only external asset; everything else the browser loads
directly, as static files. Deployed by pushing files to a static host — `git
push`, nothing compiles.

This used to also mean "one file." That part was relaxed on 2026-08-23: the
frontend is now `index.html` (a shell) plus `styles.css` plus `src/*.js`, loaded
as native ES modules (`<script type="module">`) — no bundler involved, still
zero build step, still deployed by pushing files as-is. See **Frontend module
layout** below for why and how. The load-bearing part of the constraint was
always "no build step," not "one file"; the Worker already broke "no backend"
for the same reason (a real need, decided deliberately, written down). Do not
introduce a bundler or reach for npm at runtime without the same kind of
explicit decision.

## Layout

- `index.html` — the DOM shell only (~60 lines): `<head>`, the static markup, and
  a single `<script type="module" src="src/app.js">`. No app logic lives here
  anymore.
- `styles.css` — the whole stylesheet, unchanged from when it was inline; a
  straight extraction, byte-identical to the old `<style>` block.
- `src/` — the app, as ES modules. See **Frontend module layout** below.
- `worker/` — the Cloudflare Worker API, **deployed 2026-08-22** at
  `https://fixtura-api.fixturaapp.workers.dev`. The frontend calls it for
  accounts, settings sync, and pick'em (`src/api.js`, `src/account.js`,
  `src/views/pickem.js`) — public sports data still goes straight to ESPN. It
  has its own section below; `worker/test.sh` is the integration suite. See
  `DECISIONS.md` for why the Worker exists.
- `DECISIONS.md` — what was decided and what is planned. Not needed for ordinary
  changes; read it before touching the accounts/betting track.

Before git, versions were hand-saved copies in `old versions/`; those 14
snapshots and the original `HANDOFF.md` this file draws from live in history
(`git log --diff-filter=D --name-only` to find them). The pre-split single-file
`index.html` (~3,325 lines) is likewise in git history — anything from before
2026-08-23 (`git log --before=2026-08-23 -- index.html`) shows the whole app as
one file, which is a faster read than the split version for understanding a
single code path start to finish.

## Frontend module layout

`src/app.js` is the entry point; everything else is imported from it, directly
or transitively. Roughly leaf-to-root:

- `state.js` — one exported object, `S`, holding every piece of mutable app
  state (`S.view`, `S.pkPool`, `S.modalData`, …). ES modules cannot share a
  *reassignable* binding across files — `import {view} from './state.js'; view
  = 'x'` is a `SyntaxError` — so anything that used to be a bare `let` became a
  property write on this shared object instead. Constants that are genuinely
  never reassigned (`LEAGUES`, `VIEW_LABELS`, …) stayed as plain `export const`
  in `config.js` and did not need this treatment.
- `config.js` — leagues, endpoints, static config. No imports.
- `util.js` — generic helpers (`esc`, `store`, `logoOf`, date formatting, the
  Wikipedia photo lookup shared by rosters/player-modal/venue). Only imports
  from `config.js`. Deliberately a leaf: nothing in here imports from `views/`
  or `components/` — if a "utility" needs a view- or component-specific
  function, it isn't a utility, it belongs in that view/component instead
  (this happened once, with `rosterHTML`, and was moved to `components/modal.js`
  during the split rather than left as a reverse dependency).
- `api.js` — the one place that calls our own Worker (`api()`, wrapping
  `fetch` with the bearer token and JSON handling). ESPN calls still go through
  plain `get()` in `util.js` — the frontend does not proxy public data through
  the Worker; see `DECISIONS.md`.
- `account.js` — sign-in, sign-out, settings sync, favourites, the tab-layout
  bootstrap (`initSettings`, `reconcileViews`).
- `views/` — one file per tab: `scores.js`, `teams.js`, `f1.js`, `golf.js`,
  `calendar.js`, `pickem.js`.
- `components/` — shared UI pieces used by more than one view: `gamecard.js`,
  `modal.js` (the whole game-detail and player modal, including soccer lineups
  and box scores), `drive.js`, `ticker.js`, `settings.js` (the settings panel
  *and* the build-freshness check it shares with `updatecheck.js`),
  `updatecheck.js`.

**Circular imports exist and are intentional**, not a smell to "fix": `app.js`
defines `render()`/`renderNav()`, which `components/settings.js` needs to
redraw the tab row after a settings change, and `views/scores.js` needs
`components/settings.js`'s `cfgHTML()`/`wireCfg()` because the settings panel
renders inside the scores shell. This is safe under ES module semantics
specifically because every cross-cycle reference is to a **hoisted function
declaration**, and none of them is *called* during module evaluation — only
later, from an event handler, after the whole graph has finished loading. If
you ever convert one of these to an arrow function assigned to a `const`, this
stops being safe (a `const` binding is in the temporal dead zone until its
declaration line runs) — keep these as `function` declarations.

**Side-effect-only imports are invisible to "what does this file need"
reasoning.** `components/updatecheck.js` self-wires via an IIFE and exports
nothing; nothing in `app.js` *references* it by name, so it has to be pulled in
with a bare `import './components/updatecheck.js';` — dropped once already
during the split (see hard-won detail below), because a reference-based import
generator has no way to see a module that nothing calls.

**Inline `onclick="fn()"` HTML strings need `fn` on `window` explicitly.** A
classic non-module `<script>` puts its top-level function declarations on
`window`; an ES module never does. Two functions in `components/modal.js`
(`closeModal`, `closePlayer`) are invoked from `onclick=` attributes inside
`renderXxxHTML()` template strings, so that file ends with
`window.closeModal = closeModal; window.closePlayer = closePlayer;` — those two
lines are load-bearing, not leftover debugging. If a new `renderXxxHTML()`
template ever adds an inline `onclick="someFn()"`, `someFn` needs the same
treatment (or, better, wire it with `.onclick=` from JS instead of an inline
HTML string, which doesn't have this problem at all — the two existing cases
were kept as inline strings only to keep the split a faithful line-for-line
move).

## Running it

**`file://` no longer works, full stop — not even to look at it.** This changed
on 2026-08-23. Before the module split, opening `index.html` directly worked
fine for casual viewing (only the Chrome extension refused it); now the browser
blocks `type="module"` scripts under `file://` on CORS grounds regardless of
what's driving it, so the page loads with no app at all. Always serve the
folder:

```bash
cd / && (python3 -m http.server 8123 --directory /Users/zguest/Documents/Fixtura &)
```

Same `getcwd`-under-the-sandbox reason as before to run it from `/` with
`--directory` rather than `cd`ing into the project first — `ruby -run -e httpd .
-p 8123` still works too, from a normal terminal, if you're not under the agent
sandbox. Kill the Python one with `pkill -f "http.server 8123"` when done, and
remember the browser caches modules as well as the page: navigate to `?v=2`
rather than wondering why an edit didn't take.

`python3` itself is still usable for scripting despite the above — the `getcwd`
failure depends on the working directory, and `cd / && python3 -c '...'` runs
fine. Useful for one-off analysis where there's no Node package to hand.

**Syntax-check every edit. It takes a second.** There's no single script block
to extract anymore — check the file you touched directly. `node --check` only
understands modules by file extension or an explicit flag, so a `.js` file
needs a throwaway `.mjs` copy (or `--input-type=module`):

```bash
cp src/views/pickem.js /tmp/check.mjs && node --check /tmp/check.mjs
```

This is now the routine after any change: it proves the syntax is valid but not
that every imported name actually exists in the file it's imported from — a
`.mjs`-syntax-check on one file in isolation can't see that. Load the page in a
real browser and check the console after any structural change to `src/`; a
missing or misspelled export shows up there as a `SyntaxError` at import time,
not at the call site, which can point you at the wrong file if you don't know
to expect it.

**Verifying behaviour under the agent.** The browser pane **serves a cached
snapshot**: injected state is dropped
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

`checkForUpdate()` (`src/components/updatecheck.js`) handles this in-app: it HEADs
the page's own URL and watches the `ETag`. Same-origin, so the header is
readable; HEAD, so there's no body to download. It runs on load, every 10
minutes, and **on focus / visibilitychange** — the focus case is the important
one, since that's exactly when a suspended web app resumes. A changed ETag
raises a "new version available" banner. It self-wires via an IIFE on import
rather than being called explicitly, which is exactly why it went missing for
one commit during the module split — see **Frontend module layout** above.

**The server's `Last-Modified` is the deploy time, not your version.** Asking only
the server cannot answer "am I stale?", and both this banner and the Settings panel
used to get that wrong — a stale client was shown the *new* deploy date and read as
current. `document.lastModified` is the missing half: it carries the `Last-Modified`
of the document that actually loaded, so comparing the two is a real staleness check,
and one that works on the very first run. An ETag baseline can't do that — it only
catches a deploy landing *after* the page loaded, so a page served from the 10-minute
Pages cache moments after a deploy recorded the new tag as its baseline and stayed
silent. Two guards in `staleAgainst()` are load-bearing: with no `Last-Modified`
header `document.lastModified` defaults to *now*, which must not read as permanently
stale, and second-resolution timestamps need a small skew allowance.

A service worker would be the textbook fix and is deliberately not used: it needs a
second same-origin file and would break the single-file constraint.

## Architecture

Since the 2026-08-23 module split, the file boundaries from **Frontend module
layout** above (`state.js`, `util.js`, `views/*.js`, `components/*.js`) are the
real map — the old `/* ===== NAME ===== */` section banners that used to mark
these same boundaries inside one file now mostly sit at the top of the file
each section moved to. State lives on the shared `S` object in `state.js`, not
bare module-level `let`. No framework, no reactive layer either way — views
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
- **Views** — SCORES, TEAMS, F1, GOLF, CALENDAR, PICK'EM.
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
  - *Pick'em*: the only view that needs an account, and the only one that writes
    to our own Worker. Signed out it is a single explanatory panel, not an error.
    Three sub-tabs on `.gtabs` (**not** `.chip` — see the Golf note): My picks,
    Everyone, Standings. All new classes are `pk`-prefixed against the 175 that
    already exist (see hard-won detail 12).
    - A pick is two buttons, not a select: one tap on a phone, and the choice
      stays visible. Saving is **optimistic** — the button lights up immediately
      and is put back if the server refuses, because waiting on a round trip to
      confirm a tap feels broken. The server still decides.
    - Nothing about locking, eligibility or results is decided here. The Worker
      sends `locked`, `final` and `winner_id`; this file renders them. A blank in
      the Everyone grid is not hidden — the pick was never sent.
    - A correct-looking pick is only coloured once the game is **final**. Colouring
      it at half time is a tease, not information.
    - `pkNotesHTML()` is separate from `pkPicksHTML()` so a tap can refresh the
      "still to pick" count in place; re-rendering the list would jump you back to
      the top of a 16-game week.
    - Home/away is shown as `away @ home`, and **`vs` at a neutral site** — ESPN
      flags `neutralSite` explicitly, so don't infer it from `shortName`
      containing "VS". Each button carries a `title` spelling it out.
    - The betting line is display-only and **off by default** (`sb-pk-odds`, per
      device). It is never used for scoring — a straight-up pool is decided by who
      won. It is also the groundwork for an `ats` pool later.
    - `details` on each row opens the ordinary game modal via `openGame(id, league)`
      — a pool's `league` is already a `LEAGUES` key, so nothing needs translating.
    - Renaming is owner-only and the name is the **only** mutable field on a pool.
      League, season and mode would all reinterpret existing picks, which is why
      `renamePool()` ignores them rather than merely not documenting them.
    - The create/join screen keeps `pkPool` set so it can offer a way back. It
      shipped without one and the only escape was reloading the page.
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
- **Account** (`ACCOUNT` section) — optional, and the app is fully usable without
  one. `api()` is the single place the bearer header is attached, so no call to the
  Worker can forget it; `APIBASE` points at the Worker and **only** account/pick'em
  traffic goes there — ESPN is still called directly.
  - The session token arrives in the URL *fragment* from the OAuth callback and is
    stripped with `history.replaceState` immediately, so it never lingers in the
    address bar to be copied into a message.
  - `initAuth()` runs **after** the first paint, deliberately: nothing the app draws
    should wait on a round trip to our Worker.
  - A **401 signs you out; any other failure does not.** Being unable to reach the
    Worker is not the same as being signed out, and must never silently log someone
    out — there is a test for this.
  - Sync semantics: **the account wins on load, the device pushes on change**
    (`pullSettings()` / `pushSettings()`, allow-listed to `SYNC_KEYS`). Pushes are
    fire-and-forget, because a failed sync must never block a local write. Real
    timestamp merging would need a per-key mtime `store()` doesn't track; revisit
    only if last-write-wins actually bites.
  - Sign-in **cannot work over `file://`** — it needs the served site or
    `localhost:8123`, both of which are on the Worker's origin allow-list.
  - **Bearer token, not a cookie — deliberate.** The frontend
    (`zach-guest.github.io`) and the Worker (`*.workers.dev`) are different
    sites, so a session cookie would be third-party, and **Safari blocks those
    by default** — which would break sign-in for exactly the Safari-dock-app
    usage pattern this file already cares about (see **Deploying**). A bearer
    token in `localStorage`, attached by `api()`, sidesteps that entirely.
- **Refresh** — clock every 30s; one 60s timer for everything else. The ticker
  refreshes on **every** view, because it sits above the tab row and is always on
  screen; scores and golf refresh only when their view is the open one. Keep the
  ticker call outside the per-view branches — it lived inside the scores branch for
  a while, which left a bar labelled LIVE frozen at whatever the scores were when
  the app was opened.

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

## The Worker

`worker/` is a separate deployable and the single-file constraint does **not**
apply to it — that rule is about `index.html`. It is a normal ES-module Worker
bundled by wrangler, so modules and dependencies are fine here.

**It has two lanes, and the whole file layout exists to keep them apart.**

A third shape was added 2026-09-07 and does not break the rule below, but is
worth naming because it is neither of the two: `src/trends.js` is **public and
cacheable like the proxy lane, but served from D1 rather than an upstream**. It
is not a proxy route because there is nothing upstream to proxy. It returns
`pub()`, it is matched before the proxy table, and `LOCAL_PUBLIC_PREFIXES` in
`index.js` keeps it provably disjoint from both the proxy routes and the private
prefixes — the same assertion that already guarded `picks`.

| Lane | Files | Answer | Cached? |
|---|---|---|---|
| PUBLIC | `src/proxy.js` | same for everyone | yes, edge-cached per route TTL |
| PRIVATE | `src/auth.js`, `src/me.js` | depends who asked | **never**, `no-store` |

The original worker had only the first lane: GET-only, with
`Cache-Control: public` stamped on every route in its table. Adding `/me` to
that shape would have edge-cached one person's response and handed it to the
next person who asked. Four things now make that impossible, and all four are
load-bearing:

1. `src/http.js` exposes exactly two response constructors, `pub()` and
   `priv()`. Nothing else builds a `Response`, so a new route cannot forget to
   declare which kind it is — it has to pick one to return anything.
2. `PRIVATE_PREFIXES` in `src/index.js` is checked **before** the proxy table,
   so a private path can never fall through into the cached lane.
3. A module-scope assertion throws if a proxy route is ever named the same as a
   private prefix. It fails on deploy rather than silently caching private data.
4. Workers Caching (the read-through cache) is explicitly **off** in
   `wrangler.jsonc`. Caching is done by `proxy.js` through the Cache API, so the
   only things ever stored are the ones that lane deliberately puts there. If
   that is ever revisited, note the private lane would then rest on `no-store`
   alone.

Cached entries are stored **without** CORS headers and re-stamped per origin on
the way out, so one origin's entry can't be replayed to another with the wrong
`Allow-Origin`. An origin that isn't on the allow-list gets no CORS headers at
all rather than someone else's.

Auth is Google OAuth (authorization code), then a bearer token of our own —
Google is asked "who is this?" once, at sign-in, and every request after that
costs one indexed D1 lookup. Only the SHA-256 of a session token is stored. The
OAuth `state` is HMAC-signed rather than stored, so it needs no KV namespace and
no rows to clean up; it carries the return URL, which is checked against the
allow-list because an open redirect there would hand over the session token.
`users` is keyed on Google's `sub` (the stable subject id), not email — email
can be reassigned within a Google Workspace, `sub` never changes.

Requested scopes are `openid email profile` — the non-sensitive tier, which is
why this doesn't need Google's app-verification review. The consent screen is
**published**, not restricted to a Testing-mode allow-list, so any Google
account can sign in; a pool's join code is the real gate, not the OAuth screen.
Testing mode's 7-day refresh-token expiry (which would otherwise force a
weekly re-login) doesn't apply here either way, since Google is only consulted
once at sign-in and the app runs on its own longer-lived bearer token after
that.

Routes: `GET /health` (includes a real D1 check and names any missing config),
`/auth/google/start`, `/auth/google/callback`, `POST /auth/logout`, `GET /me`,
`GET|PUT /me/settings`, `GET /trends/leaders` (see below), and pick'em under
`/pools` (see below). `picks` stays
reserved in the router so it can never become a proxy route, but everything
pick'em-related lives under `/pools` — a pick only means anything inside a pool.

### Leaderboard history (`src/trends.js`)

`GET /trends/leaders?league=nfl&season=2026&weeks=2` — the most recent weekly
snapshots of a league's statistical leaderboard, newest first. An empty
`snapshots` array is a normal answer, not an error: early in a season there is
genuinely no history yet.

**This exists because ESPN has no historical leaderboard and cannot be asked for
one after the fact** (both routes in were measured — see hard-won detail 29). So
movement is *recorded as it happens* by `captureLeaderSnapshot()`, run from the
same 30-minute cron as the health check. The guard is a single
`SELECT ... WHERE league/season/week`, which turns 48 runs a day into one row-set
a week; a row means "the first capture taken during ESPN's week N", which is why
`captured_at` is stored and why any UI must label movement by date rather than
claiming totals-through-week-N.

**A snapshot cannot be backfilled.** Whatever week this first runs in is the
first week of history that will ever exist. It went live 2026-09-07, two days
before Week 1.

Standings movement deliberately does **not** live here: a past week's results are
still fetchable (`scoreboard?seasontype=2&week=N`), so records and seeding stay
reconstructable on demand rather than becoming a second copy free to drift.

### Pick'em (`src/pools.js`)

`POST /pools`, `GET /pools`, `POST /pools/join`, `GET /pools/:id`,
`GET /pools/:id/week/:n` (`n` may be `current`), `PUT /pools/:id/picks`,
`GET /pools/:id/standings`.

**Two rules carry the whole feature, and both are enforced in the worker because
a rule enforced in the UI is not a rule:**

1. **Kickoff times come from ESPN, never from the client.** `picks.locks_at`
   exists so a late pick can be rejected without a network call — but if the
   client supplied it, anyone could send a far-future value and pick after the
   game started. `weekGames()` fetches the scoreboard and is the only authority
   on what is playable, who is playing, when it starts, and who won. It is also
   what validates that the selected team is actually *in* that game.
2. **A pick is invisible until its game starts.** Other people's picks for
   unlocked games are dropped from the JSON in `weekView()`, not hidden at
   render time — anything sent to the browser can be read in devtools.

Both are covered by tests that would fail loudly if either regressed.

Scoring is **lazy, on read** of `/standings`: any final game with no `results`
row gets one, then the tally runs. No cron trigger, nothing running when nobody
is looking. `results` is deliberately separate from `picks`, so re-scoring a week
is a delete-and-reinsert that never touches what anyone actually picked.

Only `su` (straight up) can be created; other modes are rejected at creation
rather than silently producing a pool nothing can score. `mode` is immutable per
pool, so new modes are additive later. The picks column is `selection_id`, not
`team_id` — named generically on purpose, so a later golf or F1 mode can store
an athlete or driver id there without a second migration.

Join codes are drawn from a 30-character alphabet with the visually-ambiguous
characters dropped (`I`/`1`, `O`/`0`, `S`/`5` — `CODE_ALPHABET` in `pools.js`),
since these get read aloud or typed on a phone.

`getJSON()` in `proxy.js` is what the private lane uses to read ESPN — it exists
so the User-Agent (hard-won detail 18) and the edge caching are not duplicated.

```bash
cd worker
npm run dev          # local, with a local D1 copy
./test.sh            # 115 assertions against it — run this after any change
KEEP=1 ./test.sh     # ... and leave the responses on disk when one fails
npm run deploy
npm run db:schema    # apply schema.sql to the remote D1
curl https://fixtura-api.fixturaapp.workers.dev/health
```

`/health` is the first thing to check after any deploy: it reports whether D1 is
reachable and which secrets are still unset, **by name only**.

> ⚠️ **Deployed-from-a-branch hazard, live as of 2026-09-07.** `wrangler deploy`
> ships whatever is in the working directory, with no notion of branches. The
> snapshot cron (`src/trends.js`, the `stat_snapshots` table, the `/trends`
> route) is **deployed and running in production** but lives only on the
> `redesign-nfl-dashboards` branch — it is *not* on `main`. Running
> `npm run deploy` from `main` would therefore silently **revert the production
> worker**, stopping the weekly capture and 404ing `/trends`, with no error
> anywhere. The `stat_snapshots` rows would survive, but the weeks missed while
> it was reverted are gone for good (they cannot be backfilled). Either merge
> the branch or deploy only from it until merged.

The account's workers.dev subdomain is `fixturaapp`, set once at the account
level, so every Worker deployed from this account is
`<worker-name>.fixturaapp.workers.dev`; the worker name comes from `name` in
`wrangler.jsonc`. It was briefly `zacharymguest` and was changed on 2026-08-22
because **Google's consent screen displays that domain to everyone who signs
in** — friends joining a pool would have been shown Zach's name. Two things to
know if it is ever changed again: the old URL dies immediately, and the new one
needs a `wrangler deploy` to attach the route plus a few minutes for Cloudflare
to issue the `*.<subdomain>.workers.dev` certificate. During that gap the host
resolves in DNS but refuses the TLS handshake outright — `curl` exit 35, "no
peer certificate available" — which looks like a broken deploy and is not one.
The redirect URI registered with Google has to change with it.

Note the onboarding URL wrangler prints when no subdomain exists is dead; the
setting lives on the Workers & Pages page under **Your subdomain**.

Secrets (`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`) are set with
`npx wrangler secret put`, never in the config. Local dev reads `.dev.vars`
(gitignored; copy `.dev.vars.example`). `worker-configuration.d.ts` is generated
by `npm run types` and gitignored.

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

17. **Every string rendered into HTML goes through `esc()`.** This is currently true
    everywhere and must stay true. The app has one flat namespace, no templating and
    ~76 `innerHTML=` assignments built by string concatenation, so the only thing
    standing between it and injection is the habit. It has cost nothing so far
    because every string came from ESPN — but the D1 schema introduces `pools.name`
    and `users.name`, which are the first genuinely attacker-controlled text this app
    will render, into a leaderboard *other people* see. Use `esc()` without exception,
    and prefer `textContent` when writing a bare name into an existing node.

18. **ESPN 403s a server-side request based on its User-Agent.** The browser is fine
    — this only bites the Worker, which is why it was never noticed. ESPN sits behind
    Akamai, and a bare product token is refused: measured 2026-08-21, `Fixtura/1.0`
    and `Fixtura/1.0 (personal sports dashboard)` both got 403 on 3/3 attempts, as did
    a short spoofed `Mozilla/5.0`. What passes is the conventional crawler form,
    product/version plus a contact URL —
    `Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)` — verified 200 on 3/3
    against all five upstreams. The pre-restructure `worker.js` sent one of the
    blocked strings, so every ESPN call would have failed the day it was deployed.
    It is deterministic, not rate limiting: re-probe before changing it.

19. **Adding a view to `VIEW_LABELS` does not make it appear.** `sb-views` is a
    snapshot of the views that existed when it was saved, so anyone who has ever
    reordered their tabs — or synced a layout to their account — would never see a
    newly added view, and would have no way to find out it exists. `reconcileViews()`
    appends anything the layout has not been reconciled against, tracked in
    `sb-viewsseen`. Two things about it are load-bearing:
    - It is **pure**. Writing the marker inside it looked right and was not: boot
      reconciles the *local* layout first, so the marker was already written by the
      time the account's older layout arrived, and the new view was suppressed
      again. The marker is written in `saveViews()` only — the moment the user
      actually changes their tabs is the moment their intent is real.
    - `VIEWS_KNOWN_BEFORE` bootstraps the marker for layouts that predate it. It
      lists the five views that existed at the time and must not be "tidied" to
      match `VIEW_LABELS`, or hiding an old view would un-hide it once.
    Caught within a minute of adding PICK'EM: the tab vanished on sign-in.

20. **A side-effect-only module import is invisible to reference-based tooling.**
    `components/updatecheck.js` wires itself via an IIFE on load and exports
    nothing, so nothing in `app.js` *references* it by name. The 2026-08-23
    module split was done with a codemod that generated every import from the
    actual reference graph (who calls what), which is exactly why this one got
    dropped on the first pass — there was no call site to find. It needs a bare
    `import './components/updatecheck.js';` that looks unused and is not. Caught
    by clicking the "Reload"/"Dismiss" buttons on the stale-build banner and
    finding no handler, not by any syntax or reference check — the class of bug
    that only shows up in a real click, which is the whole reason
    "Verifying behaviour under the agent" (above) insists on driving the real
    controls rather than trusting a static check.

21. **Inline `onclick="fn()"` HTML needs `fn` on `window` explicitly, post-split.**
    A classic non-module `<script>` puts its top-level function declarations on
    `window`; an ES module never does. `closeModal()` and `closePlayer()` are
    invoked from `onclick=` attributes inside `renderXxxHTML()` template
    strings in `components/modal.js`, which worked before the split by accident
    of the old file being a plain script, and silently stopped working after —
    the modal's close button did nothing, no error thrown anywhere a console
    filter would catch it, since an inline handler's `ReferenceError` doesn't
    surface the way a normal one does. Fixed with
    `window.closeModal = closeModal; window.closePlayer = closePlayer;` at the
    end of `modal.js` — those two lines are load-bearing, not leftover
    debugging. A new inline `onclick="someFn()"` needs the same bridge, or
    should be wired with `.onclick=` from JS instead, which never has this
    problem.

22. **Golf course weather went stale indefinitely.** `ensureGolfCourse()` cached
    by event id with no expiry, so the wind/temp shown were frozen from
    whenever the tab was first opened — par and yardage don't change mid-event,
    but weather does. Fixed with a 10-minute `GOLF_COURSE_TTL`. A naive version
    of that fix then blanked a perfectly good course card (par, yardage, the
    hole-difficulty table) on any single dropped poll; the real fix discards
    the cached card only when there's nothing at all for the current event, so
    a failed refetch just leaves the weather stale rather than losing the
    whole card.

23. **Leaving the Teams tab mid-load wedged team search permanently.**
    `loadAllLeagues()` used to capture the `#brNote` progress element once;
    leaving the tab detaches the node from the document, so every subsequent
    progress write went nowhere, "ready" never appeared, and the `loading`
    guard flag was never released — no retry was possible short of a reload.
    Fixed by re-querying `#brNote` on every iteration instead of capturing it,
    and releasing the loading flag in a `finally`. Releasing it naively on
    success alone was a second bug: it re-ran the full 15-league load on every
    re-render, so in-flight (`allLeaguesLoading`) and completed
    (`allLeaguesDone`) are tracked as two separate flags.

24. **Never smoke-test writes against a pool holding real data.** A test click
    while verifying the pick'em write path overwrote one of Zach's actual picks
    in the live "Moose Group" pool — the prior value was unrecoverable, because
    nothing was checked for existing real picks before testing against that
    pool. Test writes only against a disposable pool created (and deleted)
    for the purpose, never against one anyone is actually using.

25. **A hardcoded list scanning `SOCCER_GROUPS` can silently go stale, the same
    way `sb-views` did (detail 19).** `LIVE_SCAN` used to hand-list seven
    "core" soccer leagues; every domestic cup (FA Cup, EFL Cup, Copa del Rey,
    …) was invisible to LIVE NOW even while live, with no error and no way to
    notice short of already knowing to check that competition directly. The
    Soccer **All** filter had the identical bug from the other direction: it
    silently dropped every non-`core` competition rather than showing "all."
    Fixed by deriving `LIVE_SCAN` from `SOCCER_GROUPS` itself (so a
    competition added there is automatically scanned) and by dropping the
    `core` filter from the All view entirely — "All" now means all. Caught
    only because a specific competition (EFL Cup) was known to be live and
    visibly missing; nothing would have flagged this on its own.

26. **`CREATE TABLE IF NOT EXISTS` does not add a column to a table that
    already exists.** Adding `picks.confidence` to `schema.sql` and re-running
    it against local D1 for testing looked like it worked — no error — but the
    table was already there from an earlier session, so the whole `CREATE
    TABLE` statement was skipped and the column silently never appeared.
    First real symptom was `D1_ERROR: no such column: p.confidence` from
    `weekView()`, on *every* pool regardless of mode, because that query
    always selects `p.confidence` — a schema change to one mode broke every
    other mode's week view too, not just the new one. A new nullable column
    on an existing table needs an explicit one-off `ALTER TABLE ... ADD
    COLUMN`, run once against local (`--local`) and once against remote
    (`--remote`) — `schema.sql`'s `CREATE TABLE IF NOT EXISTS` only ever
    covers a database being set up from nothing.

27. **A per-game lock check cannot see a survivor pool's pick.** Survivor is one
    pick a *week*, and that pick lives on a **different event** from the one
    being submitted — so `game.locked`, which only looks at the event in the
    request, happily passes. The first version of `survivor` therefore let a
    losing Thursday-night pick be abandoned on Sunday: picking any later
    unlocked game deleted the Thursday row outright. Exactly the rule class
    the module comment calls load-bearing, and it passed every test that
    existed because none of them mixed a locked pick with an unlocked one.
    The guard is a separate "is this week already spent" check on the user's
    existing row for that week.
    A second, subtler bug came from the *fix*: the guard read ESPN's live
    state while the accompanying `DELETE` was guarded on the stored
    `locks_at`. When those two disagree, the old row survives the delete
    **and** the new row inserts — two picks in a one-pick-a-week pool, worse
    than the escape being fixed. Both sides must read locked the same way;
    they now treat a pick as locked if **either** signal says so.

28. **ESPN reports a season as under way before that season's stat endpoints
    exist.** Measured 2026-09-07, two days before kickoff: the NFL scoreboard
    already returned `season.year 2026`, `season.type 2` (regular season) and
    `week.number 1`, while
    `.../seasons/2026/types/2/leaders` was still a flat **404**. Anything that
    derives "the season is live" from the scoreboard and then fetches a
    season-scoped stat endpoint will therefore throw for the entire gap between
    those two facts. In the snapshot cron this would have meant a thrown
    scheduled-handler error **every 30 minutes until the first game** — the
    same alert-fatigue failure the off-season guard already existed to prevent,
    arriving through a different door. A 4xx from a season-scoped stat endpoint
    means "not published yet" and must be a quiet skip; only 5xx and network
    failures deserve to throw. Caught by running the deployed cron against live
    ESPN rather than trusting the local test, which passed because it seeded D1
    directly and never called ESPN at all.

29. **ESPN has no historical standings or leaderboard, and one of the two ways
    of asking fails silently.** Both measured 2026-09-07, and worth recording so
    nobody spends the afternoon re-discovering them:
    - `.../seasons/{y}/types/2/weeks/{n}/leaders` — **404**. There is no
      week-scoped leaders endpoint.
    - `standings?season=2025&week=N` — **the `week` parameter is accepted and
      then ignored.** Weeks 3, 8 and 15 all return byte-identical *final*
      records. This is the dangerous one: it returns 200 with plausible data, so
      a "historical" feature built on it would look like it worked and be wrong
      all season.
    What *does* work is `scoreboard?seasontype=2&week=N&dates=YYYY`, which
    returns that week's real games and `teamsOnBye`. So **standings and seeding
    history are reconstructable** by accumulating results week by week, and need
    no storage — but **leaderboard history is not**, which is the entire reason
    `stat_snapshots` and the capture cron exist (see the Worker section).
    Note also `?level=3` is required on the standings endpoint to get
    conference → division → team nesting; without it you get conferences only,
    with no divisions and no per-division grouping.

## Known limitations

- **Soccer player headshots are sparse.** ESPN doesn't license them for most
  non-domestic players; the Wikipedia fallback covers well-known names only. No
  free API fixes this — Sofascore and FM/FIFA databases are not openly
  accessible.
- **College player bios are thin** compared to pros. An ESPN-side gap.
- **Favourites and settings are still per-device by default.** They're
  localStorage; syncing across devices requires signing in (see Account).
  Pick'em is the one genuinely multi-user feature — everything else is still
  single-player.
- **Half of "nobody is watching for errors" is fixed.** A cron trigger (every
  30 min, `runHealthCheck()` in `worker/src/index.js`) now checks D1, required
  secrets, and that an ESPN scoreboard still returns `events[]` — the likelier
  real failure mode is picks quietly not saving behind a clean 200, not a
  crash. What's still missing: a Cloudflare dashboard Worker error-rate email
  alert, so a thrown scheduled-handler error actually reaches anyone. That
  half is a Zach-side dashboard click-through, same as the OAuth consent
  screen.
- **D1's backup window is thin for a season-long pool.** Point-in-time restore
  (Time Travel) is 7 days on the free Workers plan, 30 on the $5/mo plan. A
  mangled week-3 pick not noticed until week 5 is unrecoverable on the free
  tier — upgrade before real picks exist. **This got sharper on 2026-09-07:**
  `stat_snapshots` now accumulates leaderboard history that *cannot be
  regenerated from any upstream* (hard-won detail 29). Losing those rows loses
  the season's movement data permanently, where a lost pick can at least be
  retyped.
- **Betting data is limited** to whatever ESPN's `pickcenter` returns.

## Open decisions and roadmap

Moved to **`DECISIONS.md`** — the data-provider evaluation, the proxy/Worker call,
localStorage vs accounts, what is requested but unbuilt, and the planned order of the
accounts track. Read it before starting anything on that track; it is not needed for
ordinary changes, which is why it is no longer in this file.

## Working style

Zach is a data analyst: strong SQL, growing Python, newer to JS, and recently
switched from Windows to macOS. He tests thoroughly and reports bugs with
screenshots.

Several past fixes failed because they were guesses rather than diagnoses. When
something breaks, **add real error reporting** — actual status codes, per-attempt
failure reasons — rather than layering on another speculative fallback.

Say plainly when something isn't possible (soccer headshots, social feeds)
instead of shipping a workaround that half-works.
