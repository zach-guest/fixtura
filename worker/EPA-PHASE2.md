# EPA Phase 2 — Worker validation, storage, and routes

Everything here is **local**. No remote migration was applied, no Worker was
deployed, and no frontend file was touched. Phase 1's storage layer is in
`EPA-PHASE1.md`; the source evidence is in `scripts/epa/README.md`; the
decisions are in `DECISIONS.md`.

## What was added

| File | Role |
|---|---|
| `src/epa-validate.js` | Worker-native validation and aggregation. Pure, no I/O. |
| `src/epa-store.js` | Correction-aware atomic D1 writes. |
| `src/epa-import.js` | PRIVATE machine-authenticated import routes. |
| `test/epa-validate.test.js` | 19 unit tests. |
| `test/epa-store.test.js` | 10 tests against real SQLite built from `schema.sql`. |
| `src/epa-read.js` | PUBLIC game / team / player / coverage reads. |
| `test/epa-read.test.js` | 21 read-route tests against real SQLite. |
| `test/fixtures/scoreboard-server.mjs` | Deterministic Pick'em scoreboard fixtures. |
| `migrations/0005_epa_drives_and_coverage.sql` | Drives, split numerators, coverage counts. |
| `test.sh` | 57 HTTP-level assertions. |

`src/index.js` gained an `epa` private prefix, a `stats/:league/epa/...`
dispatch, and one `/health` field. `pools.js`, `auth.js`, `me.js`, `proxy.js`,
`trends.js` and the `game-stats-*` modules are untouched.

## The Worker does not trust the importer

`scripts/epa/` already validates and aggregates, but it runs on someone's
laptop, in Python, outside this Worker. The Pick'em rule applies unchanged: a
rule enforced in the client is not a rule.

So `epa-validate.js` **recomputes every aggregate from the plays** and then
cross-checks the submitted team and player rows against what it derived. A
disagreement is a rejection naming the field and both values — not a silent
correction, because if the two disagree one of them is wrong and storing either
is worse than refusing. There is a test that tampers with one `off_epa` and
expects a 400.

Rejections, all tested: duplicate play ids, non-finite EPA, a team outside the
game's two, possession equal to defense, an NFL play that is neither pass nor
rush, a dropback naming a passer with no `qb_epa`, a play id sent as a JSON
number (it would already have lost precision), a CFB game the source does not
mark completed, and a player credited to both teams in one game.

That last one was found by a failing test during development. Nothing had
prevented one athlete accumulating EPA under two possession teams in a single
game; the code picked whichever team appeared first and silently attributed
half the player's EPA to the wrong side.

## Lane separation

`epa` is a **private prefix**, checked before the proxy table, so an import can
never fall into the cached lane. The module-scope disjointness assertion now
covers it three ways and throws on deploy if a proxy route is ever named `epa`.

Reads live under the existing `stats` local-public prefix as
`/stats/:league/epa/...`. `index.js` dispatches on segment 2, leaving the
existing `/stats/nfl/...` routes byte-identical rather than threading a league
parameter through them.

Every import response uses `priv()` (`no-store`); every read uses `pub()`
(`public, max-age=300`). Both are asserted over real HTTP.

## Import authentication

A dedicated `EPA_IMPORT_TOKEN`, and nothing else:

- **Not a user session.** No user's token can import, and the route never
  touches the sessions table or Google.
- **Constant-time comparison.** A short-circuiting compare on a secret is a
  timing oracle; the fix is six lines.
- **Never logged, echoed, or returned** — not even in an error detail. There is
  a test asserting the token does not appear in `/health`.
- **Unset means 503, not 401.** "The server cannot do this" and "you may not do
  this" are different problems and cost different hours to diagnose. `/health`
  reports `epa_import_configured` as a boolean, by name only.

`POST /epa/import/:league` takes one game or `{games:[...]}` (max 40), supports
`?dryRun=1`, and reports each game independently — one bad game does not
discard the good ones beside it. A partial failure returns **207**, because a
flat 200 would let a workflow treat a half-failed import as success.

## Reads

```
GET /stats/:league/epa/coverage?season&seasonType
GET /stats/:league/epa/games/:eventId
GET /stats/:league/epa/teams[/:teamId]?season&seasonType&throughWeek&metric&split&limit
GET /stats/:league/epa/players[/:playerId]?season&seasonType&role&limit&minOpportunities
```

Two rules shape every response:

1. **Numerators and denominators, never a bare rate.** Every rate is
   `{numerator, denominator, value}`, so a reader can check the arithmetic.
   Season figures sum the totals and divide once; they never average per-game
   rates.
2. **Coverage is stated honestly.** Imported games are not a claim about a
   complete schedule, and the CFB responses carry a note that the source can
   publish a final game whose capture stopped mid-game.

The leagues never merge: separate route trees, separate model labels, separate
role vocabularies (`qb|rusher` vs `passer|rusher`, each rejected on the other's
route), and `epa_basis` on every player row because NFL QB rows aggregate
nflverse `qb_epa` while college passer rows aggregate play EPA.

`minimum_opportunities` is labelled a Fixtura display threshold, not an
authoritative qualification standard.

## Contract-correction pass — 2026-09-10

Phase 2 was brought into line with the accepted contract. What changed:

- **Drives are real provider data, never inferred.** Both upstreams publish
  drive summaries directly (nflverse `fixed_drive*`, cfbfastR `drive.*`), so
  the offline normalizers, payloads, validators, migration, storage and
  measurement projection were all extended to carry them. Result, play count
  and yards are the source's own values; only EPA is derived, by summing the
  plays that passed the predicate. `modeled_plays` travels beside the
  provider's `plays` and `coverage` distinguishes them.
- **NFL drive yards are null.** nflverse has no drive net-yards field, and
  subtracting its yard-line strings is the field-position inference the
  contract forbids. The response carries a warning saying so.
- **Split denominators and numerators are correct.** Pass EPA divides by
  dropbacks, rush EPA by designed rushes, on both offence and defence — the
  defensive splits previously divided by *all* defensive plays. Split success
  rates needed numerators the schema did not have, so migration `0005` adds
  `def_pass_success_allowed` / `def_rush_success_allowed` rather than
  approximating them from the all-play count.

### schema.sql versus migration 0005

Two artifacts, deliberately different:

| | `schema.sql` | `migrations/0005_...sql` |
|---|---|---|
| Purpose | canonical final schema, fresh database | one-time upgrade for a database with 0003/0004 |
| Statements | `CREATE ... IF NOT EXISTS` only | `CREATE ... IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` |
| Repeat-safe | **yes** — applying twice is a no-op | **no** — must be applied exactly once |
| Guard | none needed | migration tracking; duplicate-column failure is a backstop |

The columns `0005` adds are written inline in `schema.sql`, positioned after
the last column and before any table constraint — exactly where `ALTER TABLE`
places them — so both routes produce identical table definitions.
`test/epa-schema.test.py` proves it at pragma level across all 24 tables, and
also proves `schema.sql` applies twice, that existing account/pool/pick/
snapshot/EPA rows survive `0005` with the new columns NULL, and that `0005`
applied twice still fails on a duplicate column.
- **Teams return away then home**; `ORDER BY home_away ASC`, not DESC.
- **Impact plays carry `clock` and `driveId`** and sort by descending absolute
  EPA with an explicit `play_id ASC` tiebreaker.
- **Ranking is defined for both leaderboard types.** `side=offense|defense`,
  and the response states `direction` and `better`. Defensive success rate
  ranks ascending because lower is better; everything else descending.
- **Player identity is the latest team by game chronology**, via a correlated
  sub-select ordered by `(week DESC, event_id DESC)`, replacing `MAX(team)` —
  which returned whichever string sorted highest and was meaningless for a
  traded player. All qualifying contributions still aggregate.
- **Coverage and provenance satisfy the contract**: `eligiblePlays`,
  `modeledPlays`, `eligibleDrives`, `completeDrives`, `warnings`, and a
  `provenance` block with model, model version, source, source release time,
  import time, parser version and response version.

## Validation

```
npm run test:stats     # 88 unit tests + 3 python schema tests
npm run dev:test       # terminal 1 — worker in fixture mode
./test.sh              # terminal 2 — starts the fixture server itself
```

**`npm run test:stats`: 88 passed, 0 failed.**
**`./test.sh`: 244 passed, 0 failed.**

The Pick'em suite no longer reads the live scoreboard. It asserted exact lock
states, which made it a function of the calendar — it passed only while the
chosen NFL week had no started games, and broke when Week 1 2026 kicked off.
`ESPN_SCOREBOARD_BASE` now overrides the scoreboard host; it is unset in
production and in `npm run dev`, and `npm run dev:test` points it at
`test/fixtures/scoreboard-server.mjs`. `test.sh` refuses to run against live
data, checking `/health`'s `scoreboard_override` flag first. The Worker is
still the authority on kickoff, eligibility and results; only the address it
reads changes.

Query plans for the three read-path indexes were checked with
`EXPLAIN QUERY PLAN` and all use an index rather than scanning.

### One test whose teeth were checked, and one that has none

The read tests were mutation-checked: reverting the away/home order and the
defensive split denominator each made a test fail, as they should.

The impact-play tiebreaker assertion **cannot** detect removal of the
`play_id ASC` clause. The plays table's primary key is `(event_id, play_id)`,
so a `WHERE event_id = ?` already walks that index and SQLite's stable sort
preserves play-id order among ties without it — measured with ids inserted in
descending order so insertion order differed. The clause stays because the
contract requires deterministic ordering and incidental index behaviour is not
a guarantee, but the test locks in the observable contract rather than policing
the clause. This is recorded in the test itself.

## Measured storage, with drives

| | bytes/play (all EPA objects) | of which drives |
|---|---|---|
| NFL | 345.7 | 26.4 |
| CFB | 424.1 | 30.8 |

Projected for the approved 2025 + 2026 backfill: **125.5 MB**, up from
116.1 MB without drives — about **25% of the 500 MB free-tier cap**.

## Before this can ship

Unchanged from Phase 1, plus:

1. `EPA_IMPORT_TOKEN` must be set as a Wrangler secret in production
   (`npx wrangler secret put EPA_IMPORT_TOKEN`) and given to the ingestion
   workflow. Until then the import routes answer 503 and everything else is
   unaffected.
2. **Public CFB release stays gated on the attribution and data-term review.**
   The routes exist and work locally; shipping college EPA to the live site is
   a separate decision.
