#!/usr/bin/env bash
#
# Prove that a dry run is deterministic: same source asset in, byte-identical
# payloads and report out.
#
# This is the Phase 3 exit criterion. It matters because the scheduled job
# skips unchanged games by comparing content hashes — if normalization were
# non-deterministic, every run would look like a correction and rewrite the
# whole season.
#
#   ./verify-determinism.sh nfl 2025 season     # the full archived season
#   ./verify-determinism.sh cfb 2026 week 1     # faster, for a quick check
#
# Timing fields are excluded from the comparison; nothing else is.
set -euo pipefail
cd "$(dirname "$0")"

LEAGUE=${1:-nfl}
SEASON=${2:-2025}
MODE=${3:-season}
WEEK=${4:-}

PY=./.venv/bin/python
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

args=(--league "$LEAGUE" --season "$SEASON" --mode "$MODE" --dry-run)
[ -n "$WEEK" ] && args+=(--week "$WEEK")

for run in a b; do
  $PY ingest.py "${args[@]}" --report "$TMP/$run.json" --payload-dir "$TMP/$run" >/dev/null 2>&1
done

fail=0
if diff -q "$TMP/a.json" "$TMP/b.json" >/dev/null; then
  echo "  report:   byte-identical"
else
  echo "  report:   DIFFERS"; diff "$TMP/a.json" "$TMP/b.json" | head -20; fail=1
fi
if diff -rq "$TMP/a" "$TMP/b" >/dev/null; then
  echo "  payloads: byte-identical ($(ls "$TMP/a" | wc -l | tr -d ' ') files)"
else
  echo "  payloads: DIFFER"; diff -rq "$TMP/a" "$TMP/b" | head -10; fail=1
fi

if [ $fail -eq 0 ]; then
  echo "DETERMINISTIC: $LEAGUE $SEASON $MODE${WEEK:+ $WEEK}"
else
  echo "NOT DETERMINISTIC: $LEAGUE $SEASON $MODE${WEEK:+ $WEEK}"; exit 1
fi
