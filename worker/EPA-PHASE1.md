# EPA Phase 1 — local storage foundation

Design and measured results for the local storage layer. Phase 1 is
**local only**: migrations exist as files and have been applied to local
SQLite/D1 copies, and nothing has been applied remotely, deployed, or wired
into the frontend.

Decisions this implements are in `DECISIONS.md` ("EPA spike accepted; storage
contract settled", 2026-09-09). Source evidence is in
`scripts/epa/README.md`.

## Migrations

| File | Adds |
|---|---|
| `migrations/0003_nfl_epa.sql` | `nfl_epa_games`, `nfl_epa_plays`, `nfl_epa_team_games`, `nfl_epa_player_games`, `nfl_epa_import_state` |
| `migrations/0004_cfb_epa.sql` | `cfb_epa_games`, `cfb_epa_plays`, `cfb_epa_team_games`, `cfb_epa_player_games`, `cfb_epa_import_state` |

Both are additive `CREATE TABLE IF NOT EXISTS` only. They add no column to an
existing table, which is the one thing `CREATE TABLE IF NOT EXISTS` silently
cannot do (hard-won detail 26) — so this pair does not need the `ALTER TABLE`
treatment. **If a later revision adds a column to one of these tables, it needs
an explicit `ALTER TABLE` migration**, run against local and remote separately.

Apply order is `0003` then `0004`; each remains a separate approval and
recovery checkpoint at release time.

### Why two files and two table families

Not duplication awaiting a refactor. NFL QB rows aggregate nflverse `qb_epa`;
college has no such field, so CFB passer rows aggregate the play's own EPA and
carry `epa_basis` recording that. The numbers are not comparable even in
principle, and separate tables make "never share a leaderboard" structural
rather than a rule someone has to remember.

### Constraints that are load-bearing

- **All ids are `TEXT`.** The largest observed CFB play id is
  `401858212104999901`; `Number.MAX_SAFE_INTEGER` is `9007199254740991`. As a
  number it would round silently and two plays could collide.
- **`success` is nullable** in both play tables. Missing is not zero.
- **`defense_sign_convention`** is stored per team-game row with a `CHECK`
  pinning its value, so the higher-is-better negation can never be inferred
  wrongly by a reader.
- **`cfb_epa_games.source_dataset`** is constrained to the three known source
  shapes and stored per game, so a future source change is auditable rather
  than invisible.
- **`cfb_epa_games.source_says_completed`** carries the source's own completed
  flag. Only `1` may be served as analysis: 44 of ESPN's 99 week-1 2026 finals
  were present but truncated, and one held 179 plays against a complete game's
  161, so play count is not a substitute check.
- **`cfb_epa_import_state.status` includes `truncated` and `missing` as
  distinct states** from `failed`. A truncated game is present and wrong, which
  is more dangerous than one plainly absent; the three must never collapse into
  one "not imported" number.
- **`cfb_epa_plays.is_penalty_no_play`** is the audit flag that keeps the
  penalty-no-play decision reversible from stored data instead of a re-import.
- **No partition CHECK on the CFB team table.** `off_pass_plays +
  off_rush_plays` is ~1% *less* than `off_plays` and that is correct — the
  college denominator is `scrimmage_play`, which admits fumble recoveries,
  safeties and defensive two-point conversions. The NFL table can assert the
  partition; this one cannot.

## Validation performed (local only)

Run against local SQLite files, which is what D1 is. No `--remote` command was
issued and no production database was contacted.

| Check | Result |
|---|---|
| Fresh database: `schema.sql` + 0001–0004 | applied cleanly |
| Existing pre-EPA schema + seeded rows, then 0003/0004 | applied cleanly |
| Existing data preserved across migration | users, pools, pool_members, picks, `nfl_stat_games` all intact and byte-identical |
| Schema parity, fresh vs migrated | `.schema` diff **identical** |
| Re-applying 0003/0004 repeatedly | clean, no error, no data change |
| Import 69 real games (53 CFB + 16 NFL, 8,804 plays) | loaded |
| Re-import the same 69 games | **idempotent** — row counts unchanged, `first_imported_at` preserved, file grew 16 KB (freelist churn, not duplication) |

`scripts/epa/load_local_d1.py` is the loader used. It takes a local database
path, has no Cloudflare awareness and no remote code path, and does
correction-aware replacement: a game's children are deleted and rewritten while
the parent row's `first_imported_at` survives.

## Measured storage — this replaces the JSON estimate

Measured with `dbstat` over a real load of 53 complete CFB games and 16 NFL
games, including every index.

| | bytes/play, plays table | plays indexes | **all EPA objects** | description text |
|---|---|---|---|---|
| NFL | 211.5 | 56.9 | **319.3** | 98.9 |
| CFB | 282.9 | 70.6 | **392.7** | 116.4 |

Projected for the approved 2025 + 2026 backfill:

| | plays | total | of which description |
|---|---|---|---|
| NFL 2025 | 36,064 | 11.0 MB | 3.4 MB |
| NFL 2026 (est.) | 36,064 | 11.0 MB | 3.4 MB |
| CFB 2025 | 125,706 | 47.1 MB | 14.0 MB |
| CFB 2026 (est. full) | 125,706 | 47.1 MB | 14.0 MB |
| **Total** | **323,540** | **116.1 MB** | **34.7 MB** |

About **23% of the 500 MB free-tier cap**, before whatever the existing
database already holds. Real D1 storage came in materially *cheaper* than the
JSON projection (NFL 319 B/play measured against ~542 B/play of JSON), because
JSON repeats every key name per row.

### Correction to an earlier figure

Descriptions were reported earlier as "~20% of a play row", derived from JSON.
Measured in actual storage they are **41–47% of the plays table** and **30% of
total projected EPA storage** — meaningfully larger. The decision to store them
stands, and 34.7 MB is affordable, but the number that decision was weighed
against was too low and is corrected here.

Dropping descriptions later is a column drop and would recover ~35 MB. Adding
them later would mean re-downloading and reprocessing both seasons.

## What Phase 1 does not include

Storage only. Phase 2 (Worker validation, storage, and routes) is now built on
top of it — see `EPA-PHASE2.md`. Phase 3, the scheduled ingestion pipeline,
remains unbuilt.

## Before any remote application

1. Verify the outgoing tree still contains trends, the ESPN game-stat capture,
   cron wiring, auth and Pick'em routes. `wrangler deploy` ships the working
   directory regardless of branch.
2. Confirm the D1 backup position. Time Travel is 7 days on the free plan, and
   real Pick'em picks plus unbackfillable `stat_snapshots` already live in that
   database. This remains open from §23.
3. Apply `0003`, verify, then `0004`, verify — separately.
