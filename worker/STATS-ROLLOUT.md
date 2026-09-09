# NFL player-game stats rollout

This runbook prepares the first production release of retained NFL player-game
facts, coverage reads, player game logs, and total/qualified-rate leaderboards.
The first release was authorized and completed on 2026-09-09. Reuse the procedure
for later releases only after reviewing the new source tree and recording fresh
recovery information.

## First release result — 2026-09-09

- Released commit: `7ae8141651a89fb3ada1e9d71649c4457e4a5233`.
- Deployed Worker version: `0fed0268-a8b5-409c-9136-f297ffc2c697`.
- Previous Worker version: `8a86338b-460a-45a1-a3e2-1665ffc2e900`.
- Migrations `0001` and `0002` succeeded before the Worker deployment.
- All five expected stats/trends tables were present afterward. Existing records
  remained present: 2 users, 3 pools, and 22 picks.
- Production health, trends, coverage, total leaders, and qualified-rate leaders
  returned the expected statuses and shapes. Provider-only passer rating remained
  blocked with 400; unsigned `/me` remained private with 401.
- The new public stats responses retained the expected five-minute cache and
  GitHub Pages CORS headers. The existing ESPN proxy still returned 200.

## Audited state — 2026-09-09

- Source branch: `redesign-nfl-dashboards`.
- The live Worker serves `/trends`; the production D1 database contains
  `stat_snapshots`.
- `main` does not contain `worker/src/trends.js`. Deploying `main` as it stands
  would remove the live trends route and weekly capture job.
- The live `/stats/nfl/coverage` route returns 404, as expected before this
  release.
- None of the four new `nfl_*` tables exist in production yet.
- The active Worker version observed during the audit was
  `8a86338b-460a-45a1-a3e2-1665ffc2e900`. Re-read the active deployment before
  release rather than assuming it is still current.
- Production D1 supports Time Travel. A current recovery bookmark was retrieved
  successfully without changing data.
- The dry-run Worker bundle includes `captureLeaderSnapshot`,
  `captureNFLGameStats`, the `nfl_game_capture_state` queries, and qualified rate
  definitions.
- Local validation passes 38/38 focused stats checks and 187/187 full Worker
  integration assertions.

## Release source gate

Release from a clean, reviewed commit that includes both the existing trends
implementation and the new game-stat implementation. Immediately before release:

```sh
git branch --show-current
git status --short
git diff main -- worker/src/index.js worker/src/trends.js worker/schema.sql
node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/fixtura-worker-dry-run
```

Do not continue if `trends.js` is absent, `git status` shows unexpected changes,
or the dry bundle lacks either scheduled capture job.

## Production sequence

From `worker/`, first record the current Worker version and a fresh D1 recovery
bookmark:

```sh
node_modules/.bin/wrangler deployments list
node_modules/.bin/wrangler d1 time-travel info fixtura
```

Apply only the two additive migrations, in order:

```sh
node_modules/.bin/wrangler d1 execute fixtura --remote --file=migrations/0001_nfl_game_stats.sql
node_modules/.bin/wrangler d1 execute fixtura --remote --file=migrations/0002_nfl_game_capture_state.sql
```

Verify all tables exist before deploying code that queries them:

```sql
SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN (
    'stat_snapshots',
    'nfl_stat_games',
    'nfl_player_games',
    'nfl_player_game_stats',
    'nfl_game_capture_state'
  )
ORDER BY name;
```

Then deploy the reviewed Worker tree:

```sh
npm run deploy
```

## Smoke checks

Verify these behaviors against `https://fixtura-api.fixturaapp.workers.dev`:

- `/health` returns 200 with `ok: true`, `db: "ok"`, and no missing config.
- `/trends/leaders?season=2026` still returns 200. An empty snapshot list before
  publication is valid.
- `/stats/nfl/coverage?season=2026` returns 200. Empty weeks before any discovered
  final are valid.
- A valid total leaderboard and qualified-rate leaderboard return 200, even when
  their `rows` lists are empty before captured finals.
- `/stats/nfl/leaders?...&stat=QBRating` remains a 400 because provider-only
  ratings do not have approved season recomputation rules.
- Existing account, settings, pool, pick, and trends routes retain their prior
  cache and authentication behavior.

Allow the scheduled job to run, then inspect its logs and coverage. A normal run
should show independent health, weekly snapshot, and game-stat outcomes. The game
capture is bounded to eight due finals per run, so a full 16-game week can require
more than one scheduled interval.

## Rollback

If the new Worker fails smoke checks, roll back to the exact version recorded at
the start of the release. A Worker rollback leaves the additive D1 tables in place;
the old code ignores them, so dropping tables is unnecessary and would discard
captured facts.

```sh
node_modules/.bin/wrangler rollback <RECORDED_VERSION_ID> --message "Roll back NFL stats release"
```

Use D1 Time Travel only if a database write damaged existing production data.
Restoring overwrites the database in place and can erase legitimate writes made
after the bookmark, so it requires a separate review of the incident and restore
point. Do not use it merely to remove empty additive tables.
