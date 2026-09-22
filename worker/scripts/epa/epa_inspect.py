#!/usr/bin/env python3
"""Offline EPA source-and-contract inspection for NFL and college football.

Phase C0 / N0 tooling. This reads public upstream data, prints what it found,
and writes normalized sample payloads to disk. It does NOT touch D1, the
Worker, production, or any frontend file, and it has no write path anywhere.

    python3 epa_inspect.py probe    --league both
    python3 epa_inspect.py extract  --league nfl --season 2025 \
                                    --game 2025_01_MIN_CHI --game 401772921
    python3 epa_inspect.py extract  --league cfb --season 2026 \
                                    --game 401858422 --game 401864495
    python3 epa_inspect.py coverage  --league cfb --season 2026 --week 1
    python3 epa_inspect.py reconcile --league cfb --season 2026 --game 401856634
    python3 epa_inspect.py sizing    --league cfb --season 2025

Setup (once):

    cd worker/scripts/epa
    python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
    ./.venv/bin/python epa_inspect.py probe --league both
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cfb  # noqa: E402
import nfl  # noqa: E402
from common import SourceUnavailable, ValidationError, log, rule, write_json  # noqa: E402
from sources import espn_finals  # noqa: E402

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def cmd_probe(args):
    import sources

    leagues = ["nfl", "cfb"] if args.league == "both" else [args.league]
    report = {}
    if "nfl" in leagues:
        rule("NFL — nflverse asset availability")
        report["nfl"] = sources.probe_nfl(args.seasons or [2024, 2025, 2026])
        for season, a in sorted(report["nfl"]["seasons"].items()):
            status = a["http"].get("http_status")
            print(
                f"  {a['asset']:32s} present={str(a['present_in_release']):5s} "
                f"http={status} size={a.get('size', '-')} updated={a.get('updated_at', '-')}"
            )
        for k, v in report["nfl"]["support"].items():
            print(f"  {k:32s} {json.dumps(v, sort_keys=True)}")
    if "cfb" in leagues:
        rule("CFB — SportsDataverse espn_cfb_pbp asset availability")
        report["cfb"] = sources.probe_cfb(args.seasons or [2024, 2025, 2026])
        for season, a in sorted(report["cfb"]["seasons"].items()):
            status = a["http"].get("http_status")
            print(
                f"  {a['asset']:32s} present={str(a['present_in_release']):5s} "
                f"http={status} size={a.get('size', '-')} updated={a.get('updated_at', '-')}"
            )
        print(f"  release timestamp: {json.dumps(report['cfb']['support']['release_timestamp'])}")
    if args.out:
        print()
        print("wrote", write_json(os.path.join(args.out, "probe.json"), report))
    return 0


def cmd_extract(args):
    out_dir = args.out or DEFAULT_OUT
    failures = []
    payloads = []

    if args.league == "nfl":
        src = nfl.NflSource(args.season, force=args.force)
        build = lambda g: nfl.normalize_game(src, g)  # noqa: E731
    else:
        src = cfb.CfbSource(args.season, force=args.force)
        build = lambda g: cfb.normalize_game(  # noqa: E731
            src, g, allow_incomplete=args.allow_incomplete
        )

    for token in args.game:
        rule(f"{args.league.upper()} {token}")
        try:
            payload = build(token)
        except ValidationError as exc:
            print(f"  REJECTED: {exc}")
            failures.append({"game": token, "error": str(exc)})
            continue
        payloads.append(payload)
        _print_payload_report(payload)
        path = write_json(
            os.path.join(out_dir, f"{args.league}_{args.season}_{payload['event_id']}.json"),
            payload,
        )
        print(f"  wrote {path} ({os.path.getsize(path):,} bytes)")

    rule("Summary")
    print(f"  emitted {len(payloads)} payload(s), rejected {len(failures)}")
    for f in failures:
        print(f"    {f['game']}: {f['error'][:160]}")
    return 1 if failures and not args.keep_going else 0


def _print_payload_report(p):
    c = p["census"]
    print(f"  event_id           {p['event_id']}")
    print(f"  season/week        {p['season']} wk {p['week']} (ESPN seasontype {p['season_type_espn']})")
    print(f"  model              {p['model']}")
    print(f"  parser/predicate   v{p['parser_version']} / v{p['predicate_version']}")
    print(f"  source rows        {c['source_rows']}")
    print(f"  qualifying plays   {c['qualifying_plays']}")
    print("  excluded by (predicate terms; counts overlap):")
    for k, v in sorted(c["excluded_by"].items()):
        if v:
            print(f"    {k:36s} {v}")
    notable = {k: v for k, v in (c.get("included_but_notable") or {}).items() if v}
    if notable:
        print("  INCLUDED but worth knowing (these were NOT excluded):")
        for k, v in sorted(notable.items()):
            print(f"    {k:36s} {v}")
    print("  team-game rows:")
    for t in p["team_games"]:
        label = t.get("team") or t.get("team_id")
        rate = (t["off_epa"] / t["off_plays"]) if t["off_plays"] else float("nan")
        sr = (t["off_success"] / t["off_plays"]) if t["off_plays"] else float("nan")
        print(
            f"    {str(label):26s} off_epa={t['off_epa']:8.3f} plays={t['off_plays']:3d} "
            f"epa/play={rate:6.3f} sr={sr:5.3f} def_epa={t['def_epa']:8.3f}"
        )
    print(f"  player-game rows:  {len(p['player_games'])}")
    for r in p["player_games"][:6]:
        name = r.get("display_name") or r.get("athlete_id") or r.get("gsis_id")
        ident = r.get("espn_athlete_id") or r.get("athlete_id") or "(no ESPN id)"
        print(
            f"    {r['role']:7s} {str(name):22s} espn={str(ident):10s} "
            f"epa={r['epa']:8.3f} opp={r['opportunities']:3d} succ={r['successes']:3d}"
        )
    if len(p["player_games"]) > 6:
        print(f"    ... {len(p['player_games']) - 6} more")
    print(f"  content_hash       {p['content_hash']}")


def cmd_coverage(args):
    if args.league != "cfb":
        rule("NFL coverage")
        src = nfl.NflSource(args.season, force=args.force)
        finals, _ = espn_finals("nfl", args.season, args.season_type, args.week)
        # Filter nflverse by the SAME season type that was asked of ESPN.
        # Hardcoding REG here compared ESPN's postseason finals against
        # regular-season rows, so every playoff game reported as "missing",
        # and a postseason week 1 could silently merge with a regular week 1.
        # ESPN and nflverse do not agree on how to name or number a season
        # type, and the schedules table does not even agree with the pbp table.
        # Measured on 2025: schedules uses PRE / REG / WC / DIV / CON / SB
        # (there is no "POST"), and postseason weeks CONTINUE the regular
        # season's numbering -- ESPN seasontype 3 week 1 is nflverse week 19,
        # not week 1. The pbp table separately uses REG / POST. Mapping this
        # wrong silently compares unrelated games, so it is derived here rather
        # than hardcoded.
        types = {1: ["PRE"], 2: ["REG"], 3: ["WC", "DIV", "CON", "SB"]}.get(args.season_type)
        if types is None:
            log(f"unknown --season-type {args.season_type}; expected 1, 2 or 3")
            return 2
        week = args.week
        if args.season_type == 3:
            last_reg = src.q(
                f"""SELECT max(week) FROM read_parquet('{src.sched_path}')
                     WHERE season = ? AND game_type = 'REG'""",
                [args.season],
            )[0][0]
            if last_reg is None:
                log(f"no regular-season weeks for {args.season}; cannot place postseason")
                return 2
            week = int(last_reg) + args.week
        placeholders = ",".join("?" * len(types))
        rows = src.q(
            f"""SELECT DISTINCT espn FROM read_parquet('{src.sched_path}')
                 WHERE season = ? AND week = ? AND game_type IN ({placeholders})
                   AND espn IS NOT NULL""",
            [args.season, week] + types,
        )
        scheduled = {str(r[0]) for r in rows}
        present = {
            str(r[0])
            for r in src.q(
                f"""SELECT DISTINCT s.espn FROM read_parquet('{src.pbp_path}') p
                     JOIN read_parquet('{src.sched_path}') s ON s.game_id = p.game_id
                    WHERE s.season = ? AND s.week = ? AND s.game_type IN ({placeholders})""",
                [args.season, week] + types,
            )
        }
        print(f"  season type              ESPN {args.season_type} -> nflverse {'/'.join(types)}")
        print(f"  week                     ESPN {args.week} -> nflverse {week}")
        print(f"  ESPN finals              {len(finals)}")
        print(f"  nflverse scheduled       {len(scheduled)}")
        print(f"  nflverse pbp present     {len(present)}")
        print(f"  finals missing from pbp  {sorted(set(finals) - present)}")
        return 0

    rule(f"CFB coverage — season {args.season} week {args.week}, ESPN groups=80")
    src = cfb.CfbSource(args.season, force=args.force)
    finals, all_events = espn_finals("cfb", args.season, args.season_type, args.week)
    cov = src.coverage(finals, week=args.week)
    n = cov["espn_finals"] or 1
    print(f"  ESPN groups=80 finals            {cov['espn_finals']}")
    print(f"  source games for this week       {cov['source_games']}")
    print(
        f"  importable (complete)            {len(cov['importable_complete'])}"
        f"  ({100 * len(cov['importable_complete']) / n:.1f}%)"
    )
    print(f"  present but TRUNCATED            {len(cov['present_but_truncated'])}")
    print(f"  missing entirely                 {len(cov['missing_entirely'])}")
    print(f"  in source, outside ESPN coverage {len(cov['in_source_not_in_espn_coverage'])}")
    if cov["present_but_truncated"]:
        print()
        print("  truncated games (id, rows, max period) — these look like data and are not:")
        for g in cov["present_but_truncated"][:15]:
            d = cov["detail"][g]
            print(f"    {g}  rows={d['rows']:4d}  max_period={d['max_period']}")
        if len(cov["present_but_truncated"]) > 15:
            print(f"    ... {len(cov['present_but_truncated']) - 15} more")
    if cov["missing_entirely"]:
        print(f"  missing: {cov['missing_entirely'][:20]}")
    if args.out:
        print()
        print("wrote", write_json(os.path.join(args.out, f"coverage_cfb_{args.season}_w{args.week}.json"), cov))
    return 0


def cmd_reconcile(args):
    if args.league != "cfb":
        print("reconcile currently compares the two CFB source paths only", file=sys.stderr)
        return 2
    src = cfb.CfbSource(args.season, force=args.force)
    for g in args.game:
        rule(f"CFB reconcile {g} — compiled parquet vs per-game enriched JSON")
        rep = cfb.reconcile_with_game_json(src, g)
        print(f"  game JSON url        {rep['game_json_url']}")
        print(
            f"  game JSON status     state={rep['game_json_status_state']} "
            f"completed={rep['game_json_status_completed']} "
            f"detail={rep['game_json_status_detail']!r}"
        )
        print(f"  game JSON plays      {rep['game_json_total_plays']}")
        for tid in sorted(rep["parquet_team_totals"]):
            a = rep["parquet_team_totals"][tid]
            b = rep["game_json_team_totals"].get(tid, {})
            print(
                f"    team {tid:>6s}  parquet epa={a['epa']:9.4f} plays={a['plays']:3d} | "
                f"json epa={b.get('epa', float('nan')):9.4f} plays={b.get('plays', 0):3d}"
            )
        print(f"  AGREES: {rep['agrees']}")
        for d in rep["differences"]:
            print(f"    DIFF {d}")
        if args.out:
            print("  wrote", write_json(os.path.join(args.out, f"reconcile_cfb_{g}.json"), rep))
    return 0


def cmd_sizing(args):
    """Project normalized storage from a real season, measured not guessed."""
    rule(f"{args.league.upper()} {args.season} — normalized size projection")
    if args.league == "cfb":
        src = cfb.CfbSource(args.season, force=args.force)
        path, pred, key = src.pbp_path, cfb.CFB_QUALIFY_SQL, "game_id"
    else:
        src = nfl.NflSource(args.season, force=args.force)
        path, pred, key = src.pbp_path, nfl.NFL_QUALIFY_SQL, "game_id"
    total, games = src.q(
        f"SELECT count(*), count(DISTINCT {key}) FROM read_parquet('{path}') WHERE {pred}"
    )[0]
    print(f"  qualifying plays  {total:,}")
    print(f"  games             {games:,}")
    print(f"  plays per game    {total / games:.1f}" if games else "  games: 0")
    # Bytes per normalized play row measured from a real emitted payload rather
    # than assumed, in cmd_extract. This is the JSON figure; D1 row overhead
    # differs and must be measured against a local database in Phase 1.
    print()
    print("  NOTE: this counts qualifying plays only. Multiply by the measured")
    print("  bytes-per-play from an emitted payload for a JSON size, and verify")
    print("  actual storage against a local D1 in Phase 1 before any migration.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, league_choices=("nfl", "cfb")):
        p.add_argument("--league", choices=league_choices, required=True)
        p.add_argument("--season", type=int, required=True)
        p.add_argument("--out", default=DEFAULT_OUT)
        p.add_argument("--force", action="store_true", help="re-download cached assets")

    p = sub.add_parser("probe", help="what exists upstream, how big, how fresh")
    p.add_argument("--league", choices=("nfl", "cfb", "both"), default="both")
    p.add_argument("--seasons", type=int, nargs="*")
    p.add_argument("--out", default=DEFAULT_OUT)
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("extract", help="normalize and validate one or more games")
    common(p)
    p.add_argument("--game", action="append", required=True,
                   help="NFL: nflverse game_id or ESPN event id. CFB: ESPN event id.")
    p.add_argument("--allow-incomplete", action="store_true",
                   help="CFB only: emit a game the source says is still in progress")
    p.add_argument("--keep-going", action="store_true",
                   help="exit 0 even when a game is rejected")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("coverage", help="source coverage against ESPN finals")
    common(p)
    p.add_argument("--week", type=int, required=True)
    p.add_argument("--season-type", type=int, default=2)
    p.set_defaults(func=cmd_coverage)

    p = sub.add_parser("reconcile", help="CFB: compiled parquet vs per-game JSON")
    common(p)
    p.add_argument("--game", action="append", required=True)
    p.set_defaults(func=cmd_reconcile)

    p = sub.add_parser("sizing", help="measured storage projection")
    common(p)
    p.set_defaults(func=cmd_sizing)

    args = ap.parse_args()
    try:
        return args.func(args)
    except SourceUnavailable as exc:
        # Exit 3 so a caller can tell "nothing to do yet" apart from "broken".
        log(f"SOURCE UNAVAILABLE: {exc}")
        return 3 if exc.retryable else 0
    except ValidationError as exc:
        log(f"FAILED: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
