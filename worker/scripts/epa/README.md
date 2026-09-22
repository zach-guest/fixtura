# EPA source-and-contract spike — NFL and college football

Offline inspection tooling for Phase C0 (college) and Phase N0 (NFL) of
`NFL-IMPLEMENTATION-PLAN.md`. It probes the upstream sources, normalizes real
games into candidate payloads, and reports coverage and reconciliation.

**It writes nothing anywhere except `cache/` and `out/`, both gitignored.** No
D1 command, no Worker deploy, no schema, no frontend change. There is no write
path to anything else in it.

All findings below were measured on **2026-09-09**. Re-run `probe` and
`coverage` before acting on any of them; the whole point of the tool is that
these are observations, not assumptions.

---

## Setup and commands

Requires Python 3.9+ (verified on the system `python3` 3.9.6 on macOS) and one
dependency, DuckDB, in a local virtualenv. Nothing here is a frontend or
Worker runtime dependency.

```sh
cd worker/scripts/epa
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

```sh
# What exists upstream, how big, how fresh
./.venv/bin/python epa_inspect.py probe --league both --seasons 2025 2026

# NFL: two archived 2025 games (accepts nflverse game_id or ESPN event id)
./.venv/bin/python epa_inspect.py extract --league nfl --season 2025 \
    --game 2025_01_MIN_CHI --game 401772921

# CFB: two completed 2026 games
./.venv/bin/python epa_inspect.py extract --league cfb --season 2026 \
    --game 401858422 --game 401864495

# Source coverage against ESPN's own finals (CFB uses groups=80)
./.venv/bin/python epa_inspect.py coverage --league cfb --season 2026 --week 1
./.venv/bin/python epa_inspect.py coverage --league nfl --season 2025 --week 1

# CFB only: compiled parquet vs the per-game enriched JSON fallback
./.venv/bin/python epa_inspect.py reconcile --league cfb --season 2026 --game 401856634

# Measured storage projection
./.venv/bin/python epa_inspect.py sizing --league cfb --season 2025
```

`--force` re-downloads a cached asset. `--allow-incomplete` (CFB) emits a game
the source says is still in progress, for inspection only.

### Exit codes

`0` success, **or** an upstream asset that is simply not published yet — a
season-scoped asset 404s before that season publishes, and a scheduled
importer must skip rather than fail. This is the same shape as hard-won detail
28, where ESPN's scoreboard advanced to a season whose stat endpoints did not
exist yet, and it is the reason a 4xx here is a legible message rather than a
traceback:

```
SOURCE UNAVAILABLE: .../play_by_play_2026.parquet is not published (404 Not
Found). For a season-scoped asset before that season publishes this is
expected, and a scheduled importer must skip rather than fail.
```

`1` a payload failed a contract check and was refused. `3` an upstream fetch
failed in a way that is worth retrying (5xx or network). Only 4xx is treated
as "nothing to do yet"; nothing globally suppresses upstream errors.

## Source URLs actually read

| League | Asset | URL |
|---|---|---|
| NFL | processed PBP | `github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.parquet` |
| NFL | schedules (ESPN crosswalk) | `.../releases/download/schedules/games.parquet` |
| NFL | players (GSIS→ESPN crosswalk) | `.../releases/download/players/players.parquet` |
| CFB | compiled PBP | `github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_pbp/play_by_play_{season}.parquet` |
| CFB | release freshness | `.../espn_cfb_pbp/timestamp.json` |
| CFB | per-game enriched JSON | `raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-raw/main/cfb/json/final/{event_id}.json` |
| Both | coverage authority | ESPN scoreboard (CFB adds `groups=80`) |

All are public and unauthenticated. The tool holds no credential, so it has
none to leak.

---

## Finding 1 — the compiled 2026 CFB asset exists, and is fresh

The plan recorded that the release page listed compiled seasons only through
2025 and told this spike not to assume a 2026 asset existed. **It does.**

```
play_by_play_2026.parquet   present=True  http=200  size=4,705,572
                            updated=2026-09-09T15:11:59Z
release timestamp: {"last_updated": "2026-09-09 11:12:05 EDT"}
```

The release also publishes `timestamp.json`, a machine-readable publication
time for the whole release. That is a real freshness gate for a scheduled
importer, and it is better than inferring freshness from asset mtimes.

## Finding 2 — CFB identity is exact, and needs no crosswalk at all

`game_id` in the compiled asset **is** the ESPN event id, and the player id
columns **are** ESPN athlete ids. Measured against ESPN's own week-1 finals:

- 97 source games, **all 97 inside** ESPN's `groups=80` week-1 final set
- **zero** games in the source that are outside Fixtura's coverage rule

So the proposed FBS coverage rule (`groups=80`) and the source's own scope
agree exactly. No name matching anywhere, and no crosswalk table to maintain.

## Finding 3 — CFB play IDs exceed JavaScript's safe integer range

Largest observed 2026 play id: **401858212104999901**. JavaScript's
`Number.MAX_SAFE_INTEGER` is 9007199254740991 — smaller by four orders of
magnitude. A play id emitted as a JSON *number* would be silently rounded by
the Worker and by the browser, and two different plays could collide on one
id.

Every id this tool emits is therefore a **string**, in both leagues. NFL ids
are small enough not to need it; they are stringified anyway so there is one
rule rather than a per-league exception to remember. The eventual D1 columns
should be `TEXT` for the same reason.

## Finding 4 — the current-season CFB asset is only about half usable, and it looks fine

This is the most important finding in the spike, and it is the one that should
shape the ingestion design.

```
CFB coverage — season 2026 week 1, ESPN groups=80
  ESPN groups=80 finals            99
  source games for this week       97
  importable (complete)            53  (53.5%)
  present but TRUNCATED            44
  missing entirely                  2
  in source, outside ESPN coverage  0
```

The 44 truncated games are ESPN **finals** whose upstream capture was taken
while the game was still being played and never re-taken — three to eleven
days later. They carry real EPA values for the plays they do contain, so they
do not look broken; they look like low-scoring games.

`status_type_completed` identifies them exactly, and is the only safe gate.
**Play count is not a usable proxy**: one truncated game holds 179 rows, more
than a complete game's 161. The adapter refuses to emit unless the source
itself says the capture is of a completed game:

```
REJECTED: CFB ESPN 401856636: the source's own status_type_completed is false,
so this capture is of a game still in progress (22 rows). Refusing to emit.
```

ESPN independently confirms that game is `Final`; the source's own enriched
JSON still says `state=in, completed=False, "8:39 - 1st Quarter"`.

## Finding 5 — the per-game JSON is not an independent fallback

The plan lists the per-game enriched final JSON as fallback candidate 1 if the
compiled asset is missing or stale. Measured, it is not an alternative for
*staleness*, because it is the same capture:

- On a complete game (401856634) the two agree **exactly** — identical
  qualifying play count (120) and identical EPA totals to four decimals for
  both teams.
- On a truncated game (401856636) they also agree exactly — on the truncated
  numbers. The raw JSON one layer further up is frozen at the same
  `"8:39 - 1st Quarter"`.

So the truncation originates at the raw-scrape layer and propagates to
everything built from it. Switching to the per-game JSON would change nothing
about coverage.

It also is not schema-compatible: the compiled parquet flattens possession to
`pos_team_id`, while the JSON nests it as `start.pos_team.id`. Reading the
other one is a code change, not a runtime fallback — which is fortunate, since
the plan forbids a silent fallback anyway.

## Finding 6 — the defect is current-season lag, not a broken source

The same pipeline delivers a **complete** archived season:

```
CFB 2025: 956 games, 956 with status_type_completed = true  (100.0%)
          every week 100% complete
```

So the compiled asset is fully trustworthy for backfill and validation, and
the problem is confined to how quickly the current season heals.

**What is not yet known:** whether a truncated current-season game heals in
days, at some weekly reprocess, or only in an end-of-season rebuild. The
week-1 games have been stale for three to eleven days and were still stale
after a rebuild of the release on 2026-09-07. This is cheap to resolve by
re-running `coverage --league cfb --season 2026 --week 1` in a few days and
comparing the numbers; the answer decides the recheck window for the scheduled
job.

## Finding 7 — NFL identity is exact, both ways

- **Games:** all 272 of the 2025 regular season have a unique, populated
  `espn` value in nflverse schedules. Nothing is matched on date and team.
- **Players:** every one of the **345** distinct passers and rushers in the
  2025 regular season resolves through `players.parquet` to an ESPN athlete
  id — 345/345, zero unmatched GSIS ids, zero duplicate `gsis_id`. Spot-checked
  against ESPN: gsis `00-0033077` → espn `2577417` → "Dak Prescott, QB".

The adapter still keeps the GSIS id when no ESPN id exists. A missing ESPN id
should cost a player-popup link, not a team's EPA.

- **Season:** `play_by_play_2026.parquet` is a 404 as of 2026-09-09, which is
  correct — the season opens tonight. This is the same shape as hard-won
  detail 28: a 4xx on a not-yet-published season asset means "not published
  yet" and must be a quiet skip, not a thrown scheduled-handler error.

## Finding 8 — the predicates, and what they exclude

Both predicates are exported, versioned (`PREDICATE_VERSION = 1`) and
**separate**. They are written as SQL so the filter and the aggregation cannot
drift apart — every count in a payload comes from the one `WHERE` clause.

NFL (`nfl.NFL_QUALIFY_SQL`) is the plan's contract verbatim: finite `epa`,
`play = 1`, both teams present, `pass = 1 OR rush = 1`, and kneels, spikes,
aborted and deleted plays excluded. nflverse's own `pass` includes sacks and
scrambles; its `rush` is designed runs only.

CFB (`cfb.CFB_QUALIFY_SQL`) is deliberately *not* the same clause. cfbfastR
publishes `scrimmage_play`, which is the college taxonomy's own answer, and
its pass/rush flags are real booleans rather than nflverse's 0/1 doubles.

Kneels and spikes are handled differently from the NFL, measured rather than
assumed:

- **Kneels** have a `kneel_down` flag. All 48 in the 2026 asset are already
  outside `scrimmage_play`, so none qualify. The flag is named in the predicate
  anyway, so the contract is explicit and a future capture that marks a kneel
  as a scrimmage play cannot slip through.
- **Spikes have no flag at all.** All 3 in week 1 are classified
  `Pass Incompletion` with `scrimmage_play = true`, and they **do** qualify.
  That is a real divergence from the NFL predicate, which excludes spikes
  explicitly. They are left in deliberately: 3 plays in 8,895 (0.03%) move
  nothing, and the only way to exclude them would be to pattern-match the
  description text. Recorded as a known difference for schema review rather
  than fixed with a guess.

Two other things are **included** that a reader might expect to be excluded,
and the census reports them under "INCLUDED but worth knowing" rather than
under exclusions:

- **Penalty-no-play snaps.** 610 of the 621 in week 1 fall out via
  `scrimmage_play`; 11 still qualify, including a 63-yard rush whose touchdown
  was nullified (EPA −1.10, which is the offence correctly losing value). These
  are inconsistent from our side and are an open contract question.
- **Scrimmage plays that are neither pass nor rush** — see below.

One consequence is easy to trip over later: the CFB predicate does **not**
require pass or rush, because `scrimmage_play` is the college denominator and
the plan's CFB contract is "EPA per scrimmage play". Measured on the 2026
asset, 88 of 8,895 qualifying plays (1.0%) are scrimmage plays that are
neither — fumble recoveries, safeties, a defensive two-point conversion. They
carry real EPA and belong in the team total. So for CFB
`pass_plays + rush_plays` is about 1% short of `plays`, while for the NFL the
two partition exactly, and the CFB reconciliation check deliberately omits the
partition assertion the NFL one makes.

Measured exclusions on the four sample games:

| Game | source rows | qualifying | largest exclusions |
|---|---|---|---|
| NFL 401772810 (MIN@CHI, defensive TD) | 176 | 122 | not_pass_or_rush 53, not_a_play 46 |
| NFL 401772921 (GB@DAL, OT tie) | 211 | 151 | not_pass_or_rush 60, not_a_play 53, kneel 1 |
| CFB 401858422 (MINN vs E. Illinois, FBS–FCS) | 156 | 113 | not_scrimmage 43, penalty_no_play 7 |
| CFB 401864495 (SJSU@EMU, 15 no-play penalties) | 208 | 142 | not_scrimmage 66, not_pass_or_rush 64 |

### Edge cases deliberately included in the samples

- **NFL 401772810** has a return touchdown scored by the team that did *not*
  have possession. As with hard-won detail 11, that is correct and must not be
  "fixed" — the EPA still belongs to the possession team.
- **NFL 401772921** went to overtime and ended in a **tie** (`result = 0`),
  which exercises the schedule fields most likely to be assumed non-zero.
- **CFB 401858422** is an FBS team against an FCS opponent, which the plan
  says to include because ESPN includes it.
- **CFB 401864495** has 15 no-play penalties and the largest play count in the
  complete set.

**What could not be covered:** the CFB overtime path is **untested**, because
the source contains no overtime game to test it against. Not one of the 97
games in the 2026 asset reaches a fifth period. ESPN's week 1 did have at least
one — Charlotte vs The Citadel (`401862694`) finished `Final/3OT` — and it is
one of the two games missing from the source entirely. So college overtime
handling is unverified, and must be verified against a real OT game before the
college UI ships rather than assumed to work because the NFL OT game did.

## Finding 9 — one mismatch worth not conflating

A team's dropback count and a quarterback's dropback count are **different
numbers** and the payload keeps them separate. For MIN@CHI, Chicago has 46
qualifying `pass` plays but Caleb Williams has 37 QB dropbacks: team
dropbacks include sacks and scrambles with no named passer. Any UI that shows
"dropbacks" has to say whose.

Relatedly, NFL QB rows use nflverse's own `qb_epa`, while CFB passer rows can
only use the play's `EPA` — college has no `qb_epa` equivalent. Every CFB
player row therefore carries `epa_basis`, so nobody has to infer it, and the
two leagues' passer numbers are not comparable even in principle.

## Finding 10 — measured size

| League | season | qualifying plays | games | plays/game |
|---|---|---|---|---|
| NFL | 2025 (REG+POST) | 36,064 | 285 | 126.5 |
| CFB | 2025 | 125,706 | 956 | 131.5 |

Measured from the emitted payloads, compact JSON:

| League | bytes per play row | without `description` |
|---|---|---|
| NFL | ~542 | ~427 |
| CFB | ~669–753 | ~534–611 |

So one full CFB season of slim play rows is roughly **85–95 MB of JSON**, and
one NFL season roughly **20 MB**. D1 storage will differ from the JSON figure
in both directions (no repeated key names, but index overhead), so this is a
planning number and **not** a substitute for measuring a real local D1 in
Phase 1.

Two consequences worth deciding before the migration:

1. The compact-JSON estimate put `description` near 20% of a serialized play
   row. Phase 1's real `dbstat` measurement supersedes that estimate: it is
   41–47% of the plays table and 30% of projected EPA storage. Whether to store
   it is a real schema decision, not a detail — impact-play explanations need
   it, rankings do not.
2. D1's free plan caps a database at 500 MB. One CFB season plus one NFL
   season plus indexes is comfortable; multi-season CFB backfill is not
   obviously comfortable. This compounds the existing open item about moving
   to the paid plan for Time Travel retention.

---

## Recommendation

**Select the compiled `espn_cfb_pbp` season Parquet as the canonical CFB
source.** It has the right identity space, the right coverage scope, the
model output, a machine-readable freshness gate, and it reconciles exactly
with the only other available path. The alternatives do not improve on it:
the per-game JSON is the same capture, and running cfbfastR locally could not
be tested here because **R is not installed on this machine** (`Rscript` not
found), so Phase C0 step 4 is genuinely unexecuted rather than skipped.

Adopt it **with the completeness gate as a first-class part of the design**,
not as a validation detail:

- Import only games where the source says the capture is complete.
- Treat *complete*, *truncated* and *missing* as three distinct coverage
  states in storage and in every API response. A truncated game is present and
  wrong, which is more dangerous than one that is plainly absent.
- Do not fix the recheck window at "the previous two weeks" until the healing
  question in Finding 6 is answered by observation.
- Expect the college UI to show partial weekly coverage for some days after
  each week, and label it honestly. This is exactly why the plan requires
  coverage counts in every response.

**Select nflverse processed play-by-play for NFL**, unchanged from the plan.
Nothing measured here argues against it: identity is exact in both directions,
every predicate column exists, and both sample games normalize and reconcile.

## Proposed payload shapes

Deliberately **two shapes, not one**. The overlap is real but the differences
are meaningful, and a shared shape would invite a shared leaderboard.

Common to both: `league`, `model`, `parser_version`, `predicate_version`,
`event_id`, `season`, `season_type_espn`, `week`, `source{...}`, `census{...}`,
`content_hash`, and `plays` / `team_games` / `player_games` arrays. Every id is
a string. Every rate is absent — only numerators and denominators are stored.

**NFL**, additionally: `nflverse_game_id`, `home_team`/`away_team` as nflverse
abbreviations, `overtime`, `gameday`. Play rows carry `qb_epa`, `is_dropback`,
and `passer/rusher/receiver_gsis_id`. Player rows are keyed
`(event_id, gsis_id, role)` with `role` in `qb | rusher`, carry
`espn_athlete_id` (nullable), and QB rows aggregate `qb_epa`.

**CFB**, additionally: `home_team_id`/`away_team_id` as ESPN team ids,
`source_says_completed`. Play rows carry `play_number`, `drive_id`,
`yards_to_endzone`, and `passer/rusher/receiver_athlete_id` as ESPN ids.
Player rows are keyed `(event_id, athlete_id, role)` with `role` in
`passer | rusher`, and carry `epa_basis` because college EPA is not `qb_epa`.

Team rows in both: offensive EPA/plays/successes plus pass and rush splits,
the negated defensive mirror of the opponent, and an explicit
`defense_sign_convention` string.

Sample payloads for all four games are written to `out/` by the commands
above; they are gitignored, so regenerate rather than expecting them in the
repository.

## Defects found and fixed during review

A Sonnet subagent reviewed the tool read-only against the invariants above.
Its confirmed findings, all fixed and re-verified:

1. **`content_hash` was not stable.** The CFB adapter fetched the release
   `timestamp.json` live and folded it into the hashed payload, so the hash
   changed whenever upstream republished *anything*, even when every play was
   byte-identical. That defeats the only purpose the hash has — letting a
   scheduled importer skip unchanged games. The hash is now computed over a
   data core that excludes fetch-time metadata (`common.VOLATILE_SOURCE_FIELDS`),
   and is verified stable across a simulated republish.
2. **The CFB census mislabelled non-exclusions as exclusions.** It printed
   `penalty_no_play` and `kickoff_play` under "excluded by" when those are not
   terms of the CFB predicate — the report claimed rows had been dropped that
   had not been. Split into predicate terms and informational counts.
3. **NFL coverage ignored `--season-type`,** hardcoding `game_type = 'REG'`.
   Every postseason game reported as "missing from pbp". Fixing it exposed a
   second trap: nflverse schedules have **no `POST` value** — they use `WC`,
   `DIV`, `CON`, `SB`, and postseason weeks *continue* the regular season's
   numbering, so ESPN seasontype 3 week 1 is nflverse **week 19**. The pbp
   table separately uses `REG`/`POST`. The mapping is now derived from the
   data. Postseason coverage now reports 6/6 rather than 0/6.
4. **`fetch_json` had none of `fetch`'s error handling**, so a GitHub API rate
   limit (60/hour unauthenticated), an ESPN hiccup, or a missing per-game JSON
   crashed `probe`, `coverage` or `reconcile` with a raw traceback.
5. **`EPA_success` NULL was coerced to 0**, against this project's own
   "missing is not zero" rule and inconsistent with the NFL adapter, which
   preserves it. Never observed NULL in current data; fixed as a latent bug.
6. **`game_header()` collapsed rows with `any_value()`** with no check that
   they agreed — precisely the partial-recapture scenario the adapter warns
   about elsewhere. Now raises if any header field disagrees across a game's
   rows.
7. **A non-numeric `--game` token raised a raw `ValueError`** instead of the
   tool's normal clean rejection.

One reviewer claim did **not** survive checking: that the file's comment about
kneels was disproven. Measured, kneels are correctly excluded (48 rows, 0
qualifying) — the reviewer's evidence was about penalty-no-play snaps, which
say nothing about kneels. Spikes were the real gap, and an earlier text search
of mine had also been contaminated by a player name containing "kneel".
Both claims were re-measured against the source before anything was changed.

## Question ledger

One canonical list. `HANDOFF-REDESIGN.md` §25/§26 point here rather than
keeping a second, shorter copy that could drift out of step with this one —
the two lists disagreed once already.

### Settled 2026-09-09 (see `DECISIONS.md`)

| # | Question | Decision |
|---|---|---|
| 1 | Store play `description`? | **Yes, from the start.** Measured at 41–47% of the plays table and 30% of projected EPA storage; impact-play explanations need it, and adding it later means reprocessing a season. |
| 2 | How far back to backfill? | **2025 and 2026 only.** Older seasons stay upstream and can be added deliberately. |
| 3 | Keep the 11 qualifying penalty-no-play snaps? | **Yes, with `is_penalty_no_play` retained per play.** The source assigned them EPA; Fixtura does not overrule the model it imports, and the flag keeps the call reversible from stored data. |
| 4 | Exclude the 3 CFB spikes? | **No.** The college schema has no spike flag, it is 0.03% of plays, and the only "fix" is pattern-matching description text. Recorded as a league divergence. |
| 5 | Separate NFL/CFB shapes, or unify? | **Separate** — tables, routes, predicates and payloads. Confirmed, not to be tidied together later. |

### Still open — none of these blocks Phase 1 local work

1. **Does a truncated current-season CFB game heal, and how fast?** Decides the
   scheduled job's recheck window, which is a Phase 3 input, not a Phase 1 one.
   Re-measured ~13.5 hours after the first reading: the asset was byte-identical
   (same sha256) and coverage was unchanged at 53/99, so the source had simply
   not republished. That is **not** evidence either way. The measurement that
   answers this has to be taken after an actual upstream rebuild.
2. **Attribution wording, and the CFB data terms.** This gates the **public CFB
   release**, not Phase 1 and not local work. nflverse is CC BY 4.0 and
   understood; the SportsDataverse code licences are permissive but the data
   derives from ESPN, and the applicable data terms are unresolved. NFL is not
   blocked by this.
3. **The two absent CFB week-1 finals** — `401858209` (Duke–Tulane) and
   `401862694` (Charlotte–The Citadel, `Final/3OT`). Permanent gap or another
   lag case is unknown. The second is the only known week-1 overtime game,
   which is why **the CFB overtime path remains untested** and must be verified
   against a real overtime game before the college UI ships.
