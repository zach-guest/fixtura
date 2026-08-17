# Pressbox — Project Handoff

Context document for picking up development. Written for an AI coding assistant with
repo access, but readable by a human collaborator too.

---

## What this is

**Pressbox** is a personal multi-sport dashboard. It started as a replacement for
juggling ESPN, Sleeper, and various apps, and grew into a fairly complete scores /
schedules / rosters / stats browser.

**Hard constraint that shaped every decision so far:** it is a *single self-contained
HTML file* with no build step, no dependencies, no backend. Fonts come from Google
Fonts, everything else is inline. It is deployed by dropping one file on GitHub Pages.
Do not introduce a bundler, framework, or npm dependency into the frontend without
explicitly agreeing to abandon that constraint — the zero-friction deploy is a feature,
not an accident.

**Live:** GitHub Pages, served as `index.html` at the repo root.

---

## Files

| File | Purpose | Status |
|---|---|---|
| `pressbox.html` (deploy as `index.html`) | The entire app. ~1,640 lines. | Live |
| `worker.js` | Cloudflare Worker API proxy | Written, **not deployed** |
| `wrangler.toml` | Worker deploy config | Written, **not deployed** |

The Worker is speculative infrastructure for when a keyed odds API gets added. It is
not currently needed and the frontend does not reference it.

---

## Owner / user context

- Zach — data analyst, strong SQL, growing Python, comfortable with technical
  explanation but new to macOS (switched from Windows recently) and newer to JS.
- Teams he actually follows: **San Antonio Spurs, Houston Texans, Texas Longhorns,
  Oklahoma State (football), PSG**. These are the `DEFAULT_TEAMS`.
- Also follows F1. Explicitly **not** interested in college basketball.
- A friend is joining the project, coming from a **betting-focused** build that used
  theScore's API. Betting/odds features are the likely next direction.

---

## Architecture

Single file, four sections:

1. **CSS** — five themes as CSS custom property blocks on `html[data-theme=...]`.
   Default is `paper` (light). Others: midnight, ice, terminal, crimson. Theme
   persists to localStorage. Responsive breakpoint at 700px.
2. **Config constants** — `LEAGUES`, `SOCCER_GROUPS`, `DEFAULT_TEAMS`, etc.
3. **State** — plain module-level `let` variables. No framework, no reactive layer.
   Views re-render by assigning `innerHTML` and re-wiring event handlers.
4. **Functions** — grouped by section with banner comments.

### Data sources

| Source | Used for | Notes |
|---|---|---|
| `site.api.espn.com/apis/site/v2/sports` | scoreboards, schedules, summaries, rosters | Undocumented, keyless, CORS-open |
| `site.web.api.espn.com/apis/common/v3/sports` | athlete profile / bio / stats | Same |
| `sports.core.api.espn.com/v2` | venues, team lists (fallback), athlete core record | Same |
| `api.jolpi.ca/ergast/f1` | all F1 data | **200 req/hour, 4/sec** — real limit |
| `en.wikipedia.org/w/api.php` | venue photos + description, player photo fallback | `origin=*` for CORS |
| `api.open-meteo.com` + `geocoding-api.open-meteo.com` | venue weather | 10k/day free, non-commercial |

ESPN has no documented terms or limits. Treat politely; caching already added partly
for this reason.

### Views

- **SCORES** — league chips (NFL, CFB, NBA, WNBA, CBB, MLB, NHL, SOCCER) + a
  **LIVE NOW** chip that scans `LIVE_SCAN` leagues and filters to in-progress games.
  Day/Week toggle (week uses ESPN's `dates=YYYYMMDD-YYYYMMDD` range syntax). Date
  picker, prev/next, arrow-key nav.
- **TEAMS** — favorites bar (editable), cross-league team search, then per-team
  Schedule / Roster / Injuries.
- **F1** — next race with session times, full season calendar (click a completed round
  to expand results + qualifying inline), driver and constructor standings.
- **CALENDAR** — month grid with favorite teams' logos on days they play.

### Game detail modal

Tabs: Box Score · Lineups · Rosters · Injuries · Team Stats · Plays · Odds · Venue · Info.
Team names in the header are clickable and navigate to that team's page.
Player names throughout open a second-level modal with bio + career stats.

---

## Hard-won details — DO NOT REGRESS THESE

Each of these was a real bug found by the user in testing. They are non-obvious and
easy to reintroduce.

### 1. Soccer starter detection
ESPN marks bench players with `formationPlace: "0"`. A truthiness check treats `"0"`
as a starter and flags all 23 players. Use `isStarter()`: explicit boolean first,
then `+formationPlace > 0`. Soccer caps at 11, basketball at 5.

### 2. Soccer pitch layout
Three interlocking pieces in `pitchHTML()` / `parsePos()` / `lineOf()` / `lateral()` /
`attackRank()`:
- Position codes look like `CD-L`, `AM-R`, `RWB`, `LM`. Parse into **base role + flank**.
- `lineOf()` must check midfield (`/M$/`) *before* defense, or `DM` reads as a defender.
  Defense uses **exact** matches (`WB|FB|B|CB|CD|D|SW`) for the same reason.
- `lateral()` must weight **wide roles as further from centre than central ones**
  (fullback = 2, centre-back = 1), or you get LB, CD-L, RB, CD-R instead of
  LB, CD-L, CD-R, RB.
- Midfield is split into formation rows by `attackRank()` (DM=0, CM/LM/RM=1, AM=2),
  **not** by raw `formationPlace`, which produced nonsense pivots.
- The formation string is only trusted when its counts actually match the real
  position counts; otherwise fall back to plain G/D/M/F rows.

### 3. Team schedules across sports
`fetchTeamEvents()` handles three failure modes:
- `seasontype=1|2|3` is a US-sports concept; **never send it for soccer** (every PSG
  request was malformed because of this).
- Only query alternate season years **when the default call returns nothing** —
  querying several years and merging produced 201 "upcoming" Cardinals games.
- Final fallback sweeps the league scoreboard across four date ranges (−60 to +180
  days) and filters for the team. This is what rescues soccer fixtures.

### 4. Team list loading
ESPN's `/teams` endpoint fails in some environments. `ensureTeams()` tries the site
API twice, then falls back to the core API **with pagination** (an earlier 160-team
cap meant Texas Longhorns never loaded — only Texas A&M appeared for "texa").
Results cache to localStorage for 30 days.

### 5. Logos
Soccer responses omit the `logos` array US sports include. `logoOf(team, leagueKey)`
checks both shapes then builds `a.espncdn.com/i/teamlogos/{sport}/500/{id}.png`.
All logo `<img>` tags need `onerror` handlers.

### 6. Ticker
Constant 60 px/sec speed derived from measured width (a fixed duration made it crawl
or fly depending on game count). Content repeats to exceed viewport width, then
duplicates exactly twice for a seamless `-50%` loop. Spacing is padding *inside*
items, not flex `gap`, or the wrap hitches. Repaints are skipped when content is
unchanged so the animation doesn't restart.

### 7. Auto-refresh
Only runs on the Scores view, only when no modal is open, and only reloads the game
list — never the whole page. The user specifically complained about being yanked out
of a player profile.

### 8. Venue images
Wikipedia images are filtered by a `BAD_IMG` regex plus a **≥600px width** and aspect
ratio check. Without this a generic "sports balls and dice" portal graphic appeared.
Filenames containing interior/pitch/field/stand/panorama are scored to the front.

---

## Known limitations

- **Soccer player headshots are sparse.** ESPN doesn't license them for most
  non-domestic players. Wikipedia fallback covers well-known names only. No free API
  fixes this; Sofascore and FM/FIFA databases are not openly accessible.
- **College player bios are thin** compared to pros — ESPN-side gap.
- **No social/team features** — favorites are localStorage only, per-device.
- **Betting data is limited** to whatever ESPN's `pickcenter` returns.

---

## Open decisions

1. **Data provider.** Currently ESPN. The friend prefers `api.thescore.com`
   (undocumented, keyless, reportedly cleaner/more consistent JSON). **Verify its CORS
   headers before committing** — permissive CORS is the only reason the no-backend
   architecture works. Paid options evaluated: API-Sports (free tier, key required,
   probably best all-round), The Odds API (500 req/mo free, credit-per-market-per-region
   billing, no sharp books), SportsGameOdds (includes scores + settlement, covers
   Pinnacle/Betfair, $99+/mo), SportsDataIO ($25/mo), Sportradar (enterprise).

2. **Proxy or not.** `worker.js` exists and is ready. Needed the moment a keyed API is
   added, since a key in a public Pages file is a public key. Also solves rate limits
   via edge caching (per-route TTLs: 30s scores, 15min F1, 24h team lists). Frontend
   change is three constants. Recommendation: deploy when odds work starts, not before.

3. **localStorage vs accounts.** Discussed at length. Recommendation was: stay on
   localStorage, optionally add a "sync code" (Cloudflare KV, ~30 lines, no login) for
   cross-device, and only build real accounts when a feature genuinely requires
   identity — which social betting features would. Do not build auth preemptively.

4. **Name / domain.** "Pressbox" is in use as a domain. Alternatives floated:
   pressbox.gg / .live / .app, or Sideline, Matchday, Full Time, Touchline, Scorely.
   Not urgent — GitHub Pages URL works fine.

---

## Requested but not yet built

- Team social media links (ESPN carries some; recent *posts* are not feasible — X and
  Instagram killed free API access and embeds don't work reliably in a local file)
- Richer betting features generally — this is the friend's area
- Anything multi-user

---

## Working style notes

The user tests thoroughly and reports bugs with screenshots. Several past fixes failed
because they were guesses rather than diagnoses — when something breaks, add real error
reporting (actual status codes, per-attempt failure reasons) rather than layering on
another speculative fallback. He responds well to being told plainly when something
isn't possible (e.g. soccer headshots, social feeds) rather than being given a
workaround that half-works.
