# Fixtura — agent operating instructions

Applies throughout this repository. Written for Codex with GPT-5.6 Sol Medium
as the default lead model on 2026-09-08,
translated from the persistent instructions in `CLAUDE.md` and checked against
this checkout. Follow the user's current request and approved decisions; dated
handoffs and historical notes are context, not new task authorization.

## Delegation / usage policy

Use **GPT-5.6 Sol at medium reasoning** as the default primary thinker,
architect, integrator, and final reviewer. Preserve Sol usage whenever delegation
will reduce total usage without sacrificing correctness.

Delegate implementation work to **GPT-5.6 Terra**. Give Terra explicit,
implementation-ready instructions: specify the files to modify, exact behavior
required, relevant constraints, architecture decisions, edge cases, and validation
steps. Do not delegate architectural decisions or open-ended problem solving when
you can resolve those decisions yourself first.

Use **GPT-5.6 Luna** instead of Terra for simple, bounded, mechanical tasks where
Luna is sufficient.

When delegation is beneficial, create **at most 2 subagents concurrently**. Keep
each agent's scope narrow and provide only the context necessary for its task.

**Do not delegate automatically.** Before spawning an agent, consider whether the
additional prompt/context and agent overhead will actually save usage. If
delegation is unlikely to reduce total usage, perform the work yourself.

Prefer this hierarchy:

- **Sol Medium:** planning, architecture, difficult reasoning, ambiguous decisions,
  integration, and final review.
- **Terra:** normal coding and implementation from a detailed specification.
- **Luna:** simple edits, searches, repetitive changes, straightforward tests,
  and other tightly bounded work.

Do not have subagents create additional subagents. Reuse an existing agent when
practical rather than creating unnecessary new ones. In tools that require model
IDs, Sol is `gpt-5.6-sol`, Terra is `gpt-5.6-terra`, and Luna is `gpt-5.6-luna`.
Use `medium` reasoning for the Sol lead unless the user requests another level.
Give delegates disjoint file ownership where possible, include the
no-further-delegation instruction, and review their changes before integration.
If a requested model is unavailable, report that and work locally rather than
silently substituting another model.

## Documents and working style

- `AGENTS.md` contains day-to-day operating instructions for Codex.
- `DECISIONS.md` contains rationale, accepted decisions, roadmap, and unresolved
  choices. Read relevant sections before architecture, accounts, Pick’em, or
  stats-storage work. Prefer later dated decisions over superseded proposals.
- `HANDOFF-REDESIGN.md` contains redesign status, preview locations, and next steps.
  Read it before redesign work; a preview is not the deployed app.
- `CLAUDE.md` remains a legacy reference with detailed bug narratives. Consult
  relevant sections when needed, but do not inherit obsolete Claude tool/sandbox
  commands or treat its old implementation status as current. Do not delete it
  without telling the user first.
- Keep history and handoff context separate from these operating rules. Record
  new decisions in `DECISIONS.md` and implementation status in the handoff.
- Zach is strong in SQL, learning Python and JavaScript, and tests with screenshots.
  Explain outcomes plainly, with technical detail where useful. Diagnose using
  actual errors, statuses, and response shapes; do not stack speculative fallbacks.
  State missing data and limitations honestly.

## Architecture and repository map

**Frontend: no build step, bundler, framework, or runtime npm dependency.** Native
ES modules and static files are the architecture. The old single-file restriction
was retired; do not reintroduce it or use it to justify architectural changes.
Fonts and provider-hosted media are already used; the old claim that Google Fonts
is the sole external asset is not an accurate inventory.

- `index.html`: static DOM shell, loading `src/app.js` as a module.
- `styles.css`: one global stylesheet, including theme tokens and responsive rules.
- `src/state.js`: shared mutable state object `S`; add app state as properties.
- `src/config.js`: static configuration, leagues, endpoints; no imports.
- `src/util.js`: generic helpers, including `esc`, `store`, `get`, and `logoOf`.
  Keep it a leaf; no imports from views or components.
- `src/api.js`: calls to Fixtura's Worker, bearer token and JSON handling.
- `src/account.js`: auth lifecycle, settings sync, favorites, tab reconciliation.
- `src/views/`: Scores, Teams, F1, Golf, Calendar, Pick’em.
- `src/components/`: shared cards, game/player modals, drive view, ticker, settings,
  update checking. Preserve `openPlayer` as the in-app player detail experience.
- `worker/`: separate Cloudflare ES-module Worker and D1 database. Wrangler tooling
  and Worker dependencies are allowed here; frontend restrictions do not ban them.
  `worker/package.json`, `worker/wrangler.jsonc`, `worker/schema.sql`, and
  `worker/test.sh` describe tooling, bindings, schema, and integration checks.

Views render HTML and then wire handlers. Preserve intentional module cycles:
functions referenced across cycles stay hoisted function declarations, are not
called during module evaluation, and must not become `const` arrow functions.
Keep the side-effect import of `components/updatecheck.js` in `app.js`.
Keep the `window.closeModal` / `window.closePlayer` bridges while inline handlers
use them. Prefer wiring new events in JavaScript.

## Frontend invariants

- Escape every dynamic string inserted into HTML with `esc()`; use `textContent`
  for plain text. This includes provider data and user/pool names.
- Preserve all `sb-*` storage keys. Use `store()` so unavailable storage does not
  crash the app. Preserve signed-out usability; Pick’em requires an account.
- Tab navigation remains data-driven and user-reorderable. Do not hide the last
  visible tab; hiding the active tab moves to the first visible view.
  Keep `reconcileViews()` pure, write the seen marker only in `saveViews()`, and
  do not update historical `VIEWS_KNOWN_BEFORE` to mirror the current view list.
  Verify new views appear for existing saved and account-synced layouts.
- Account settings win on load; device changes push afterward using `SYNC_KEYS`.
  A 401 signs out; other failures do not. Sync failure cannot block local changes.
  Auth starts after first paint. Strip OAuth fragment tokens promptly and keep
  bearer handling centralized; do not switch to cross-site cookies casually.
- Add colors through theme tokens for every installed theme. The app currently
  has Paper, Midnight, Ice, Terminal, Crimson; Broadsheet and Retro are preview
  additions until integrated. Do not scatter hardcoded theme colors. Actual team
  brand colors and computed contrasting labels are a deliberate exception.
- Check every new CSS class against the global stylesheet; prefix feature classes
  to avoid collisions. Keep filter chips visually distinct from navigation tabs.
- Design mobile and desktop intentionally. Preserve `viewport-fit=cover`, safe-area
  spacing for the camera cutout/home indicator and landscape edges, reduced-motion
  behavior, and internal scrolling for wide tables. Keep serif type out of numbers.
- Refresh must preserve open player/game modals, scroll, selections, and expanded
  rows. The current global 60-second refresh is paused while a modal is open;
  otherwise it refreshes the ticker on every view, Scores or Golf when active.
  Drive polling is separate: 20 seconds, only on the active live Drive tab, stopped
  on tab change, modal close, or final. Do not restore the obsolete Scores-only rule.
- Preserve build-freshness checks, including the side-effect import, focus/resume
  handling, and loaded-document-versus-server timestamp comparison. A fresh server
  timestamp alone does not establish that the client is fresh.

## Data correctness and known traps

No invented sports data. Missing does not mean zero. Use real provider values or
clearly identified derivations with sufficient inputs. Keep seasons, season types,
source dates, and snapshot capture times explicit. Verify undocumented provider
behavior when changing the relevant path; historical measurements are not guarantees.

- Public sports reads currently go directly to providers through `get()`; Worker
  auth/private calls use `api()`. Add stats ingestion/read APIs deliberately under
  the accepted storage plan, not as a blanket proxy rewrite. Keep API keys/secrets
  server-side. Reuse Worker `getJSON()` for upstream caching and User-Agent handling.
- ESPN fields may be absent, nested differently, or `$ref` URLs. Guard accesses,
  paginate collections, deduplicate, and retain the existing fallback behavior.
  Re-probe before changing the tested Worker User-Agent.
- NFL `standings?week=N` can return 200 while ignoring the week. Never use that as
  historical standings. `level=3` gives conference/division nesting. Historical
  win/loss records can be accumulated from real games; playoff seeding additionally
  requires correct tiebreakers, not just win percentage.
- Week-scoped league leaders have returned 404. A scoreboard can advance to a season
  before its stats are published. Preserve the snapshot job's expected unpublished
  season handling; do not globally suppress 4xx errors such as rate limiting or
  access failures. Surface unexpected failures with useful diagnostics.
- Weekly snapshots record the first capture during the provider's week, not final
  totals through that week. Label movement by capture dates. Lost as-observed
  snapshots cannot be recreated exactly; retained game logs may permit reconstructed
  totals, which must be distinguished from those snapshots.
- Player-by-game storage has a local foundation plus bounded scheduled capture,
  coverage reads, player game-log reads, and a passing full-week archived audit;
  total-stat and qualified recomputed-rate rankings are also integrated locally.
  None is deployed yet; provider-only ratings remain unavailable. See the latest
  handoff for status. Preserve provenance, team-at-game identity,
  corrections, coverage, and stable IDs. Aggregate traded-player stints correctly;
  team ranks use that team's contribution. Define qualification for rate stats and
  calculate rates from underlying totals, not averaged percentages. See decisions.
- Football: dedupe current/previous drives by ID; live drive ends can be null.
  Prefer play `yardsToEndzone` to ambiguous `yardLine`. Scoring-play IDs link to
  drive plays; defensive/return scorers need not belong to the possession team.
  Preserve live probability clamps and undistorted DOM labels over stretched SVG.
  Win probability is not EPA; the current ESPN summary/plays integration has no EPA.
- Soccer: `formationPlace: "0"` is a bench player, not a truthy starter. Preserve
  position parsing/formation guards. Do not send US `seasontype` parameters for
  soccer schedules. Try alternate years only when the default schedule is empty.
  Preserve paginated team loading, scoreboard fallbacks, and dynamic `SOCCER_GROUPS`
  coverage for LIVE NOW and All. Re-query progress DOM after navigation; release
  loading flags in `finally` and distinguish in-flight from completed loads.
- Golf: use `activeRounds()` rather than padded linescore length; rank by score to
  par, respecting ties, not running strokes. Gate hole detail on real hole data.
  Fetch player summaries lazily. Preserve weather expiry and valid cached course
  data after failed refreshes. Never invent shot locations from hole totals.
- Media: use `logoOf()` and image-error handling; retain Wikipedia quality filters.
  Ticker width/constant-speed logic, seamless duplication, and repaint avoidance
  are intentional. Respect upstream request limits and use caching/bounded requests.

## Worker, auth, and Pick’em safety

- Keep public proxy, private account/pool, and local public D1 stats routes distinct.
  Use `pub()` and `priv()` response constructors. Private responses are never cached.
  Preserve private-first routing, prefix-disjointness assertions, and disabled
  automatic Workers caching. Strip CORS before caching public responses and stamp
  allowed-origin headers on return; never replay another origin's CORS headers.
- Preserve hashed session tokens, signed OAuth state, return-URL allowlists, and
  identity based on Google's stable subject ID. Secrets go in Wrangler secrets or
  gitignored `.dev.vars`, never source/config/output logs. Do not replace OAuth
  with a display-name/join-code identity shortcut.
- Worker data is authoritative for pick eligibility, kickoff locks, opponents, and
  results. Hide others' unlocked picks in the API response, not only in the UI.
  Keep results separate from picks and score only final games. Odds are display-only
  and off by default for straight-up scoring.
- Current supported modes are `su`, `confidence`, and `survivor`; preserve all three.
  Pool league/season/mode are immutable; owner rename changes only the name.
  Survivor checks the existing pick for the entire week, not only the submitted
  game's lock. Checks and mutation guards must agree: either stored kickoff or live
  status can establish a lock. Preserve one-pick-per-week and no-team-reuse rules.
- Never test writes against real pools, picks, users, or settings. Use disposable
  test data. The integration suite deletes/seeds LOCAL D1 data; never point it at
  production or change its database operations to `--remote`.
- Schema setup is not migration: `CREATE TABLE IF NOT EXISTS` does not add columns
  to existing tables. Plan explicit migrations and test both fresh and existing
  databases. A remote schema command is a production write, not a routine test.

## Running and validation

Serve the frontend over HTTP; `file://` does not run the ES modules. From the repo:

```sh
python3 -m http.server 8123 --bind 127.0.0.1 --directory .
```

Check whether that port is already serving a preview before starting another
server. Use the appropriate allowed origin for auth tests. Manage only the server
process you started; do not use broad `pkill` commands. Use current Codex browser
APIs and their documented capabilities, not legacy `javascript_exec` instructions.
Exercise real UI controls and wait for actual state changes. Screenshots verify
appearance; DOM/behavior checks verify interactions. Account for cached modules
when checking edited code; a page query alone may not refresh child modules.

For each changed JavaScript file, syntax-check it, for example:

```sh
node --input-type=module --check < src/views/scores.js
```

For structural module changes, also load the app and inspect import/console errors.
Test affected flows in a real browser, including mobile and relevant themes. Do not
claim live testing when only pregame or archived data was available. Documentation
changes need content/link/diff checks, not application or database test runs.

For Worker changes, use two terminals in `worker/`:

```sh
npm run dev
# Other terminal, against the disposable local Worker/D1:
./test.sh
# Retain response bodies while investigating a failure:
KEEP=1 ./test.sh
```

Inspect `worker/package.json` and the test script before running setup; do not
assume historical assertion counts. `npm run db:schema:local` targets local D1;
`npm run db:schema` targets REMOTE D1 and must not be used as local setup.

## Deployment and preservation

The documented frontend host is GitHub Pages at
`https://zach-guest.github.io/fixtura/`, from `main` at the repo root. The Worker is
separately deployed at `https://fixtura-api.fixturaapp.workers.dev`. Verify branch,
remote, diff, and actual deployment configuration before release. A push to the
Pages branch or `npm run deploy` is a release action, not validation. Do not claim
instant propagation; check the served build and client freshness afterward.

**Critical handoff hazard:** the 2026-09-07 documentation reports production
running `worker/src/trends.js` from `redesign-nfl-dashboards`, absent from `main`.
Wrangler deploys the working directory, regardless of branch. Before any Worker
release, verify the outgoing tree preserves the trends route, schema, capture job,
and cron wiring. Do not deploy an older tree that stops capture. Check current git
state rather than assuming this branch relationship lasts forever; merging is a
separate task, not automatic authorization from this warning.

After an authorized Worker deploy, check `/health` and affected routes. Preserve
existing picks and snapshot history through migrations and releases; verify backup
and recovery arrangements for data work rather than relying on old pricing or
retention claims in historical notes. Never print secret values while diagnosing.
