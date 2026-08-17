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

macOS system `python3` can't run `http.server` under the agent sandbox, hence
Ruby. Both are fine from a normal terminal.

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
- **Views** — SCORES, TEAMS, F1, CALENDAR.
  - *Scores*: league chips plus a LIVE NOW chip that scans `LIVE_SCAN` and
    filters to in-progress games. Day/Week toggle (week uses ESPN's
    `dates=YYYYMMDD-YYYYMMDD` range syntax), date picker, arrow-key nav.
  - *Teams*: favourites bar, cross-league search, per-team schedule / roster /
    injuries.
  - *F1*: next race with session times, season calendar (click a completed round
    to expand results and qualifying inline), driver and constructor standings.
  - *Calendar*: month grid with favourite teams' logos on days they play.
- **Game detail modal** — tabs for Box Score, Lineups, Rosters, Injuries, Team
  Stats, Plays, Odds, Venue, Info. Team names in the header navigate to the team
  page; player names open a second-level modal with bio and career stats.
- **Config** — `LEAGUES` maps a key to an ESPN path; `SOCCER_GROUPS` expands into
  `soc:<espn-code>` entries; `PRIMARY` is the tab row, `DEFAULT_TICKER` the
  ticker, `DEFAULT_TEAMS` the starting favourites.
- **Persistence** — `localStorage` under `sb-*`: `sb-favs`, `sb-ticker`,
  `sb-theme`, `sb-teams-<league>` (30-day cache). Keys keep the old `sb-` prefix
  deliberately so a rename never wipes saved teams. Don't "tidy" them.
- **Refresh** — clock every 30s; scores and ticker every 60s.

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

## Known limitations

- **Soccer player headshots are sparse.** ESPN doesn't license them for most
  non-domestic players; the Wikipedia fallback covers well-known names only. No
  free API fixes this — Sofascore and FM/FIFA databases are not openly
  accessible.
- **College player bios are thin** compared to pros. An ESPN-side gap.
- **No multi-user anything.** Favourites are localStorage, per-device.
- **Betting data is limited** to whatever ESPN's `pickcenter` returns.

## Open decisions

1. **Data provider.** Currently ESPN. A collaborator prefers `api.thescore.com`
   (undocumented, keyless, reportedly cleaner JSON). **Verify its CORS headers
   before committing to it** — permissive CORS is the only reason the
   no-backend architecture works. Paid options already evaluated: API-Sports
   (free tier, key required, probably best all-round), The Odds API (500 req/mo
   free, no sharp books), SportsGameOdds (scores + settlement, Pinnacle/Betfair,
   $99+/mo), SportsDataIO ($25/mo), Sportradar (enterprise).

2. **Proxy or not.** `worker/` is ready but undeployed. Needed the moment a keyed
   API is added, since a key in a public static file is a public key. Also solves
   rate limits via edge caching (30s scores, 15min F1, 24h team lists). The
   frontend change is three constants. Deploy when odds work starts, not before.

3. **localStorage vs accounts.** Stay on localStorage. Optionally add a "sync
   code" (Cloudflare KV, ~30 lines, no login) for cross-device. Build real
   accounts only when a feature genuinely requires identity — social betting
   would. Do not build auth preemptively.

## Requested but not yet built

- Team social media links. ESPN carries some; recent *posts* are not feasible —
  X and Instagram killed free API access and embeds don't work reliably from a
  local file.
- Richer betting features generally — the collaborator's area.
- Anything multi-user.

## Working style

Zach is a data analyst: strong SQL, growing Python, newer to JS, and recently
switched from Windows to macOS. He tests thoroughly and reports bugs with
screenshots.

Several past fixes failed because they were guesses rather than diagnoses. When
something breaks, **add real error reporting** — actual status codes, per-attempt
failure reasons — rather than layering on another speculative fallback.

Say plainly when something isn't possible (soccer headshots, social feeds)
instead of shipping a workaround that half-works.
