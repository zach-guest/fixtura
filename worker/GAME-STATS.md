# Player-by-game statistics — capture and read foundation

Implemented and wired into the Worker locally; not migrated or deployed remotely,
backfilled, or connected to the frontend yet. The existing auth, Pick’em, public
proxy, and independent weekly leaderboard capture remain intact.

## Files and contract

- `src/game-stats-normalize.js`: pure final-NFL-summary validator and normalizer;
  exported `STAT_DEFINITIONS` catalog records units and aggregation rules.
- `src/game-stats-store.js`: `prepareNFLGameWrite` and `ingestNFLGame` accept a
  summary with `{expectedEventId, capturedAt}` (Unix seconds). The store accepts a
  D1 binding as its first argument. No public write endpoint is added.
- `migrations/0001_nfl_game_stats.sql`: additive migration for an existing database.
  The identical definitions are appended to `schema.sql` for fresh setup.
- `src/game-stats-capture.js`: bounded final-game discovery, retry bookkeeping,
  correction revisits, and scheduled imports through the existing Worker cron.
- `migrations/0002_nfl_game_capture_state.sql`: additive discovery/attempt state.
- `src/game-stats-read.js`: public, read-only D1 coverage and player game-log APIs.
- `scripts/inspect-game-stats.mjs`: offline, read-only inspection of retained JSON.
- `test/`: real reduced summary fixtures, parser checks, additive migration checks,
  and an isolated Wrangler/D1 harness. The harness is LOCAL TEST CODE ONLY.

Three tables retain event provenance, player/team-at-game identity, and numeric
stat facts with original cell text. Category namespaces keep interceptions thrown
separate from defensive interceptions. Longest plays use max; averages and
percentages must be recomputed; QBR and rating are provider-only values, not sums.
The fixture catalog covers 57 normalized fields across 10 box-score categories.
It includes targets, TFL, QB hits, passes defended, fumbles, and special teams;
it does not establish coverage of pressures, routes, air yards, forced fumbles,
or player first downs. Those need additional field/source verification.

## Ingestion behavior

Validate before preparing any writes. Require a completed NFL game, matching event
ID, sane season/week metadata, both teams, and structurally aligned core box scores.
Use stable source keys rather than labels or column offsets. Omit missing cells;
never invent zero rows for players absent from a sparse stat category. Unknown
fields or missing expected columns/categories mark the capture partial with warnings.

`coverage=complete` means the expected supplied box-score structure was present.
It does not prove all player participation, every possible stat, or a complete
season. Missing numeric cells are partial; absent players in categories such as
interceptions remain unobserved, not individual confirmed zeros.

Each accepted import uses one atomic D1 batch with five statements. Bound JSON is
expanded with SQLite `json_each`, avoiding hundreds of separate inserts. A failed
insert rolls back the event update and deletes as well. Re-importing identical
normalized content is a no-op; its existing capture timestamp stays unchanged.
Corrections replace all facts for that event, remove superseded cells, retain the
first capture time, and store the new source-update time/hash. Old source/capture
timestamps are rejected; a partial refetch cannot replace a complete capture.
Prior correction values are not retained as a separate revision history yet.

Freshness and complete-to-partial guards are repeated in the atomic SQL update,
and child deletes/inserts require the accepted capture hash and timestamp. This
prevents an older concurrent batch from deleting a newer capture after its initial
read. Capture-state updates also reject older overlapping cron results. No
unrestricted public write route is added.

## Scheduled capture and reads

The existing 30-minute scheduled handler now also checks NFL player-game facts.
It discovers completed `post` games only for the current and previous regular- or
postseason week, stores first/last discovery and retry status, and imports at most
eight due summaries per run. Missing games are attempted first. Partial and failed
captures retry after 30 minutes; complete games are revisited after six hours for
the first 72 hours and daily afterward while they remain in the two-week window.
One failed summary does not stop other due games, but the job throws after the run
so monitoring can report the failure.

Two public, 300-second cached reads are wired under the local `stats` route:

```text
GET /stats/nfl/coverage?season=YYYY&seasonType=2|3
GET /stats/nfl/players/:athleteId/games?season=YYYY&seasonType=2|3&limit=25
GET /stats/nfl/leaders?season=YYYY&category=passing&stat=passingYards
GET /stats/nfl/leaders?season=YYYY&category=passing&stat=yardsPerPassAttempt
```

Coverage means captured games among finals that the coordinator discovered. It
does not claim a complete schedule or season. The player response preserves game
coverage, warnings, raw values, aggregation rules, and missing cells. Total-stat
rankings support league/team scope, optional through-week cutoffs,
competition ties, top-32/default bounded results, traded-player stints, and an
optional one-player-per-team league view. Every response carries discovered-final
coverage.

Seven rate fields are recomputed from retained season component totals; stored
weekly averages are never averaged. NFL-qualified averages use the 2025 Guide for
Statisticians' published full-season minimums and a transparent live threshold
prorated from their 16-game pace, capped at the published minimum. Each returned
row carries its numerator, denominator, represented-team game count, required
minimum, and qualification result. Field-goal percentage has no published minimum
in that guide, so it requires a positive denominator and is labeled
`none_published`. Adjusted QBR and provider passer rating remain unavailable.

## Reproduce locally

From `worker/`, with existing development dependencies installed:

```sh
npm run test:stats
node scripts/inspect-game-stats.mjs test/fixtures/nfl-401772723.json 401772723
```

For real local D1 transaction tests, start a disposable harness in one terminal:

```sh
npm run dev:stats-test
```

In another terminal:

```sh
npm run test:stats:d1
```

The test uses port 8791 and an explicitly separate local-only database identifier.
It resets only its own test tables. Never deploy its Worker/configuration. The
normal production deployment entrypoint remains `src/index.js`. Existing Worker
regression checks remain `npm run dev` and `./test.sh` against disposable LOCAL D1.

Both migrations have been tested on fresh SQLite and over an existing schema
with disposable account, pool, pick, and weekly snapshot records. It is safe to
reapply. No remote migration command was run. Existing deployments need migrations
`0001` and `0002`, in order, before this Worker version can be deployed; otherwise
the new scheduled task and read routes would reference tables that do not exist.
The verified production sequence, smoke checks, and rollback procedure are in
`STATS-ROLLOUT.md`.

## Verified samples and scope

ESPN final summaries: Houston at Los Angeles, event 401772723, and Tampa Bay at
Atlanta, event 401772830, both September 7, 2025. Fixtures preserve header, boxscore,
and source meta from public summary responses captured for this project on
September 7–8, 2026. Other response sections were removed. Synthetic edge-case
mutations live only in tests, not the stored source fixtures.

Parser tests cover reordered columns, composites, decimals, negative yards,
missing/zero distinctions, unknown fields, invalid IDs and dates, duplicate cells,
wrong teams, nonfinal games, and both real samples. Local D1 tests cover reruns,
corrections, stale/partial rejection, two-game coexistence, concurrent freshness, and forced late-write
failure rollback. Capture/read/ranking/rate/audit unit and migration checks pass 38/38, the isolated
D1 ingestion test passes, and the full Worker suite passes 187/187 assertions.
A local scheduled-event smoke test ran all three independent jobs successfully;
there were no current completed games due for import during that check.

## Archived-week audit

`scripts/audit-nfl-week.mjs` is a fail-closed local tool. It accepts only a root
HTTP loopback Worker URL, resets only the isolated stats-test tables, imports an
exact archived NFL week, and exits nonzero for fetch/import failures, partial
coverage, game-ID differences, or any available team-total mismatch.

The 2025 regular-season Week 1 audit passed all 16 finals: 1,006 player-game rows,
7,979 numeric cells, all 57 catalog fields observed, and no partial games. All 247
available team comparisons matched. Nine fumbles-lost comparisons were unavailable
because ESPN supplied a team zero while omitting individual fumble rows; those
cells remain missing instead of becoming invented player zeroes. Forty-six fields
appeared in every game. The 11 sparse fields were interception returns (9 games),
fumbles (13), and punt returns (14), consistent with event-driven categories.
Real-data ranking samples also produced plausible ordered leaders with competition
ties, including Josh Allen in passing yards, Derrick Henry in rushing yards, Zay
Flowers in receiving yards, and Harold Landry III in sacks for that week.

D1 batch behavior reference:
https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

## Next integration slice

1. Reconcile individual facts against team/game totals where their definitions
   match; inventory any additional full player-stat fields and coverage gaps.
2. Define and test eligibility plus numerator/denominator formulas before adding
   rate-stat rankings.
3. Review migration/deployment ordering and monitoring before enabling production
   capture. Connect the approved UI and existing player
   popup after API behavior and coverage are established.
