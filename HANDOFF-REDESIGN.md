# Handoff — redesign + NFL dashboards

Written 2026-09-07, at the end of the planning/prototype session that opened this
track. Everything here is either a fact verified that day or a decision Zach
actually made. **Nothing visual is approved** — the prototype is a draft.

Read `CLAUDE.md` first for the project's hard constraints; this document assumes
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
