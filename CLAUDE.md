# Fixtura

A single-file sports dashboard. Live scores, favourite teams, F1, and a personal
fixture calendar, all client-side.

Formerly called "Pressbox" — renamed 2026-08-16. The name is provisional.

## Layout

- `index.html` — the entire app. HTML, CSS, and JS in one file, ~1650 lines. No
  build step, no dependencies, no server. Open it in a browser and it runs.
- `old versions/` — manual snapshots kept before git existed. Historical only;
  nothing reads from them.

## Running it

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Structure of index.html

Section banners in the source (`/* ===== NAME ===== */`) mark the boundaries.
In order: LEAGUES, STATE, UTIL, THEME, GAME CARD, SETTINGS PANEL, then the
per-view renderers, then wiring at the bottom.

- **Themes** — five, defined as CSS custom properties on `html[data-theme=...]`
  at the top of the `<style>` block: paper (light, default), midnight, ice,
  terminal, crimson. Any new colour must be added to all five or it breaks a
  theme. Never hardcode a hex outside those blocks.
- **Views** — four tabs: SCORES, TEAMS, F1, CALENDAR. Switched by
  `nav.views button[data-view]`.
- **Leagues** — `LEAGUES` maps a key to an ESPN path. `SOCCER_GROUPS` expands
  into `soc:<espn-code>` entries. `PRIMARY` is the tab row, `DEFAULT_TICKER` the
  ticker, `LIVE_SCAN` the leagues polled for live games.
- **Persistence** — `localStorage` under `sb-*` keys: `sb-favs`, `sb-ticker`,
  `sb-theme`, `sb-teams-<league>`. Keys kept as `sb-` after the rename so
  existing users don't lose their saved teams.
- **Refresh** — clock ticks every 30s; scores and ticker auto-refresh every 60s,
  but only on the scores view with no modal open.

## Data sources

All public, all unauthenticated, all called straight from the browser. No keys.

| What | Endpoint |
|---|---|
| Scores, teams, standings | `site.api.espn.com`, `site.web.api.espn.com`, `sports.core.api.espn.com` |
| Team logos | `a.espncdn.com` |
| F1 | `api.jolpi.ca/ergast/f1` |
| Player photos / bios | `en.wikipedia.org/w/api.php` |
| Venue weather | `open-meteo.com` (+ its geocoding API) |

ESPN's endpoints are undocumented and unversioned. They change shape without
warning, and response fields are often missing rather than null — guard every
access. `BAD_IMG` filters out the crests and placeholders Wikipedia returns
instead of player photos.

## Conventions

- Keep it one file. The single-file property is the point: it opens anywhere,
  needs nothing installed, and can be handed to someone as one attachment.
- Match the existing density. The code is deliberately compact — one-line
  helpers, minimal comments, `$` for `querySelector`.
- Escape anything from an API with `esc()` before it reaches `innerHTML`.
- Test in at least paper and midnight before calling a UI change done.
