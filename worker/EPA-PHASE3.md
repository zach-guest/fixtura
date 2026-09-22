# EPA Phase 3 — scheduled ingestion pipeline

The offline runner, the workflows, and the replay/recovery procedures.
Everything here is **local**: no production secret was set, no remote migration
applied, nothing deployed, committed or pushed. The workflow file exists but is
**gated off** and does nothing until someone enables it.

Phase 1 (storage) is in `EPA-PHASE1.md`, Phase 2 (Worker validation, storage
and routes) in `EPA-PHASE2.md`, the source evidence in `scripts/epa/README.md`,
and the decisions in `DECISIONS.md`.

## What was added

| File | Role |
|---|---|
| `scripts/epa/ingest.py` | The shipping runner: discover, normalize, upload, report. |
| `scripts/epa/verify-determinism.sh` | Proves a dry run is byte-reproducible. |
| `scripts/epa/requirements.txt` | Now hash-pinned, installed with `--require-hashes`. |
| `.github/workflows/epa-ingest.yml` | Two independent jobs, gated off by default. |

`epa_inspect.py` remains the inspection tool. `ingest.py` is what a schedule
runs.

## Modes

```sh
cd worker/scripts/epa
python3 -m venv .venv
./.venv/bin/pip install --require-hashes -r requirements.txt

# dry run: normalize and report, upload nothing (the default without --target)
./.venv/bin/python ingest.py --league nfl --season 2025 --mode season --dry-run

# one week
./.venv/bin/python ingest.py --league nfl --season 2025 --mode week --week 1 \
    --target http://127.0.0.1:8787

# one game
./.venv/bin/python ingest.py --league cfb --season 2026 --mode game \
    --game 401858422 --target http://127.0.0.1:8787

# validate against the Worker without storing anything
./.venv/bin/python ingest.py --league cfb --season 2026 --mode week --week 1 \
    --target http://127.0.0.1:8787 --server-dry-run
```

The token comes from `EPA_IMPORT_TOKEN` in the environment, never a flag, so it
cannot land in a shell history or a process listing. It is never logged and
never appears in a report. With the variable unset, the runner refuses to
upload and exits 2 rather than silently doing nothing.

**Exit codes** are the workflow's signal: `0` success, `1` at least one game
failed to normalize or upload, `2` refused to run (no token), `3` nothing to
ingest. `3` is not a failure — an unpublished season asset before kickoff is
the normal state of the world, and the workflow maps it to success so it cannot
page anyone out of season.

## Determinism

```
$ ./verify-determinism.sh nfl 2025 season
  report:   byte-identical
  payloads: byte-identical (272 files)
DETERMINISTIC: nfl 2025 season
```

This is the Phase 3 exit criterion, and it is load-bearing rather than tidy:
the pipeline skips unchanged games by comparing content hashes, so if
normalization were non-deterministic every run would look like a correction and
rewrite the whole season. Verified for a full archived NFL season (272 games)
and a CFB week (53 games).

## Batching and retries

The Worker caps a request at 40 games and 4 MB. The runner chunks by **both**
count and serialized size (8 games / 2 MB by default), because a college game
is roughly 100 KB and 40 of them would sit on the body limit — one unusually
long game could otherwise tip a batch over it.

Retries are bounded and exponential (4 attempts, capped at 30s) and apply only
to 429 and 5xx and network failures. **A 4xx is never retried**: a rejected
payload is a contract failure, and repeating it helps nobody. A 207 is a
partial success — reported per game, not retried.

## The CFB truncated-game recheck window is deliberately unresolved

`--recheck-weeks` exists and is **unset by default**, and the workflow input is
documented as "leave blank".

With it unset, a CFB season run revisits **every** week that still has an
incomplete game. That is bounded by the season and is the conservative choice,
because **the upstream healing behaviour has not been measured**: week-1 2026
games were still truncated three to eleven days after kickoff, and the source
had not republished when re-checked (handoff §26, `DECISIONS.md`). A fixed
"previous two weeks" window would silently stop retrying a game that heals on
day twelve.

Set a number only after someone has measured when truncated games actually
heal. Until then the policy string in every report says which rule was used:
`all-incomplete-weeks (healing behaviour unmeasured)`.

## Coverage artifacts

Every run writes a JSON report and the workflow uploads it as an artifact
(30-day retention, uploaded even when the job fails). It carries the source URL
and **sha256**, the source's own release timestamp, discovered/normalized/
rejected counts, per-game play and drive counts with content hashes, per-batch
HTTP status and attempt counts, every failure with its stage and reason, and
for CFB the recheck policy that was applied.

The source sha256 is what makes a report worth keeping: it identifies exactly
which upstream bytes produced a given import, so a later discrepancy can be
traced to a specific asset rather than guessed at.

## Replay and recovery

**Re-import one game** (after a correction, or a failure):

```sh
./.venv/bin/python ingest.py --league cfb --season 2026 --mode game \
    --game 401858422 --target "$API" --report artifacts/replay.json
```

Safe to repeat. The Worker replaces a game's children atomically and keeps
`first_imported_at`; an identical payload returns `unchanged` and writes
nothing.

**Re-import a week**: same with `--mode week --week N`.

**Rebuild a season from scratch**: `--mode season`. Every game is re-sent;
unchanged ones cost one hash comparison each and are reported as `unchanged`.
There is no need to clear anything first, and clearing first would be worse —
it would drop `first_imported_at` for every game.

**A game that will not validate**: run it with `--server-dry-run` to get the
Worker's rejection reason without storing anything, then look at
`upload.results[].detail` in the report, which names the field and both values.
`epa_inspect.py extract --league <l> --season <s> --game <id>` shows the same
payload locally.

**Upstream not published yet**: exit code 3. Nothing to do; the next run picks
it up.

**Recovering from a bad import**: there is no delete route, deliberately —
nothing in this pipeline can destroy data through the API. If a game must be
removed rather than corrected, that is a manual D1 statement against the
`*_epa_games` row, which cascades to plays, drives, team and player rows. Take
a backup first; D1 Time Travel is 7 days on the free plan (see the open item in
handoff §23).

**What a failed run leaves behind**: nothing partial. Each batch is one atomic
`db.batch` per game, so a game is either fully stored or not stored at all. A
run that dies halfway leaves the games it already sent and none of the rest;
re-running is the fix.

## Before this can ship

1. `EPA_IMPORT_TOKEN` as a Wrangler secret **and** a GitHub Actions secret.
2. Repository variables `EPA_API_BASE` and `EPA_INGEST_ENABLED=true`.
3. The Worker deployed with the EPA routes (Phase 2 is local-only so far).
4. Migrations `0003`, `0004`, `0005` applied remotely, in order, each a
   separate approval and recovery checkpoint. `0005` exactly once.
5. **Public CFB release remains gated on the attribution and data-term
   review.** The pipeline works; shipping college EPA to the live site is a
   separate decision.
