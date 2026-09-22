#!/usr/bin/env python3
"""Load emitted EPA payloads into a LOCAL SQLite/D1 file, to measure storage.

Phase 1 sizing only. This writes to a local database file you name; it has no
knowledge of Cloudflare, no `--remote` anything, and cannot reach production.
D1 is SQLite, so a local SQLite file measures row and index bytes faithfully;
what it does not measure is D1's own platform overhead.

    ./.venv/bin/python load_local_d1.py --db /tmp/epa.db --payload out/nfl_*.json
    ./.venv/bin/python load_local_d1.py --db /tmp/epa.db --measure
"""

import argparse
import glob
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ValidationError  # noqa: E402

I = lambda v: None if v is None else int(v)  # noqa: E731


def load(con, payload):
    league = payload["league"]
    if league == "nfl":
        return _load_nfl(con, payload)
    if league == "cfb":
        return _load_cfb(con, payload)
    raise ValidationError(f"unknown league {league!r}")


def _replace_children(con, league, event_id):
    """Correction-aware replacement: children go, then are rewritten.

    Cheap here because the FK cascade does it, but done explicitly so the
    behaviour is visible and does not depend on PRAGMA foreign_keys being on.
    """
    for table in (f"{league}_epa_plays", f"{league}_epa_team_games",
                  f"{league}_epa_player_games", f"{league}_epa_drives"):
        con.execute(f"DELETE FROM {table} WHERE event_id = ?", (event_id,))


def _load_nfl(con, p):
    ev = p["event_id"]
    now = 1757462400
    prior = con.execute(
        "SELECT first_imported_at FROM nfl_epa_games WHERE event_id = ?", (ev,)
    ).fetchone()
    first = prior[0] if prior else now
    _replace_children(con, "nfl", ev)
    con.execute(
        """INSERT INTO nfl_epa_games (event_id, nflverse_game_id, season, season_type, week,
             home_team, away_team, gameday, overtime, source_url, source_version,
             source_updated_at, source_hash, parser_version, predicate_version,
             first_imported_at, imported_at, coverage, warnings_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(event_id) DO UPDATE SET
             source_hash=excluded.source_hash, imported_at=excluded.imported_at,
             coverage=excluded.coverage, warnings_json=excluded.warnings_json""",
        (ev, p["nflverse_game_id"], p["season"], p["season_type_espn"], p["week"],
         p["home_team"], p["away_team"], p.get("gameday"), 1 if p.get("overtime") else 0,
         p["source"]["pbp_url"], None, p["source"].get("pbp_last_modified"),
         p["content_hash"], p["parser_version"], p["predicate_version"],
         first, now, "complete", "[]"),
    )
    con.executemany(
        """INSERT INTO nfl_epa_plays (event_id, play_id, drive, quarter, clock, down,
             yards_to_go, yardline_100, possession_team, defense_team, play_type,
             description, ep_before, epa, qb_epa, success, is_pass, is_rush,
             is_dropback, is_sack, is_penalty, passer_gsis_id, rusher_gsis_id,
             receiver_gsis_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, r["play_id"], r["drive"], r["quarter"], r["clock"], r["down"],
          r["yards_to_go"], r["yardline_100"], r["possession_team"], r["defense_team"],
          r["play_type"], r["description"], r["ep_before"], r["epa"], r["qb_epa"],
          I(r["success"]), int(r["is_pass"]), int(r["is_rush"]), int(r["is_dropback"]),
          int(r["is_sack"]), int(r["is_penalty"]), r["passer_gsis_id"],
          r["rusher_gsis_id"], r["receiver_gsis_id"]) for r in p["plays"]],
    )
    con.executemany(
        """INSERT INTO nfl_epa_team_games (event_id, team, opponent, home_away, off_epa,
             off_plays, off_success, off_pass_epa, off_dropbacks, off_pass_success,
             off_rush_epa, off_designed_rushes, off_rush_success, def_epa, def_plays,
             def_pass_epa, def_dropbacks_faced, def_rush_epa, def_designed_rushes_faced,
             def_success_allowed, defense_sign_convention)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, t["team"], t["opponent"], t["home_away"], t["off_epa"], t["off_plays"],
          t["off_success"], t["off_pass_epa"], t["off_dropbacks"], t["off_pass_success"],
          t["off_rush_epa"], t["off_designed_rushes"], t["off_rush_success"], t["def_epa"],
          t["def_plays"], t["def_pass_epa"], t["def_dropbacks_faced"], t["def_rush_epa"],
          t["def_designed_rushes_faced"], t["def_success_allowed"],
          t["defense_sign_convention"]) for t in p["team_games"]],
    )
    con.executemany(
        """INSERT INTO nfl_epa_drives (event_id, drive_id, sequence, possession_team,
             start_period, start_clock, end_period, end_clock, result, plays, yards, epa,
             modeled_plays, coverage)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, r["drive_id"], r["sequence"], r["possession_team"], r["start_period"],
          r["start_clock"], r["end_period"], r["end_clock"], r["result"], r["plays"],
          r["yards"], r["epa"], r["modeled_plays"], r["coverage"]) for r in p.get("drives", [])],
    )
    con.executemany(
        """INSERT INTO nfl_epa_player_games (event_id, gsis_id, espn_athlete_id,
             display_name, team, role, epa, opportunities, successes)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [(ev, r["gsis_id"], r["espn_athlete_id"], r["display_name"], r["team"],
          r["role"], r["epa"], r["opportunities"], r["successes"])
         for r in p["player_games"]],
    )
    return len(p["plays"])


def _load_cfb(con, p):
    ev = p["event_id"]
    now = 1757462400
    prior = con.execute(
        "SELECT first_imported_at FROM cfb_epa_games WHERE event_id = ?", (ev,)
    ).fetchone()
    first = prior[0] if prior else now
    _replace_children(con, "cfb", ev)
    rel = p["source"].get("release_timestamp") or {}
    con.execute(
        """INSERT INTO cfb_epa_games (event_id, season, season_type, week, home_team_id,
             away_team_id, source_dataset, source_url, source_release_timestamp,
             source_hash, parser_version, predicate_version, model,
             source_says_completed, first_imported_at, imported_at, coverage,
             warnings_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(event_id) DO UPDATE SET
             source_hash=excluded.source_hash, imported_at=excluded.imported_at,
             coverage=excluded.coverage""",
        (ev, p["season"], p["season_type_espn"], p["week"], p["home_team_id"],
         p["away_team_id"], "compiled_season_parquet", p["source"]["pbp_url"],
         rel.get("last_updated") if isinstance(rel, dict) else None,
         p["content_hash"], p["parser_version"], p["predicate_version"], p["model"],
         1 if p["source_says_completed"] else 0, first, now, "complete", "[]"),
    )
    con.executemany(
        """INSERT INTO cfb_epa_plays (event_id, play_id, play_number, drive_id, period,
             clock, down, yards_to_go, yards_to_endzone, possession_team_id,
             possession_team, defense_team_id, defense_team, play_type, description,
             ep_before, epa, success, is_pass, is_rush, is_sack, is_penalty_no_play,
             passer_athlete_id, rusher_athlete_id, receiver_athlete_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, r["play_id"], r["play_number"], r["drive_id"], r["period"], r["clock"],
          r["down"], r["yards_to_go"], r["yards_to_endzone"], r["possession_team_id"],
          r["possession_team"], r["defense_team_id"], r["defense_team"], r["play_type"],
          r["description"], r["ep_before"], r["epa"], I(r["success"]), int(r["is_pass"]),
          int(r["is_rush"]), int(r["is_sack"]), int(r["is_penalty_no_play"]),
          r["passer_athlete_id"], r["rusher_athlete_id"], r["receiver_athlete_id"])
         for r in p["plays"]],
    )
    con.executemany(
        """INSERT INTO cfb_epa_team_games (event_id, team_id, team, opponent_id, opponent,
             home_away, conference, off_epa, off_plays, off_success, off_pass_epa,
             off_pass_plays, off_pass_success, off_rush_epa, off_rush_plays,
             off_rush_success, def_epa, def_plays, def_pass_epa, def_pass_plays_faced,
             def_rush_epa, def_rush_plays_faced, def_success_allowed,
             defense_sign_convention)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, t["team_id"], t["team"], t["opponent_id"], t["opponent"], t["home_away"],
          None, t["off_epa"], t["off_plays"], t["off_success"], t["off_pass_epa"],
          t["off_pass_plays"], t["off_pass_success"], t["off_rush_epa"],
          t["off_rush_plays"], t["off_rush_success"], t["def_epa"], t["def_plays"],
          t["def_pass_epa"], t["def_pass_plays_faced"], t["def_rush_epa"],
          t["def_rush_plays_faced"], t["def_success_allowed"],
          t["defense_sign_convention"]) for t in p["team_games"]],
    )
    con.executemany(
        """INSERT INTO cfb_epa_drives (event_id, drive_id, sequence, possession_team_id,
             possession_team, start_period, start_clock, end_period, end_clock, result,
             plays, yards, epa, modeled_plays, coverage)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ev, r["drive_id"], r["sequence"], r["possession_team_id"], r.get("possession_team"),
          r["start_period"], r["start_clock"], r["end_period"], r["end_clock"], r["result"],
          r["plays"], r["yards"], r["epa"], r["modeled_plays"], r["coverage"])
         for r in p.get("drives", [])],
    )
    con.executemany(
        """INSERT INTO cfb_epa_player_games (event_id, athlete_id, display_name, team_id,
             team, role, epa, opportunities, successes, epa_basis)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        [(ev, r["athlete_id"], r.get("display_name"), r["team_id"], r["team"], r["role"],
          r["epa"], r["opportunities"], r["successes"], r["epa_basis"])
         for r in p["player_games"]],
    )
    return len(p["plays"])


def measure(con, db_path):
    con.execute("ANALYZE")
    page = con.execute("PRAGMA page_size").fetchone()[0]
    print(f"  database file: {os.path.getsize(db_path):,} bytes (page size {page})")
    rows = con.execute(
        """SELECT name, SUM(pgsize) bytes, SUM(ncell) cells FROM dbstat
            WHERE name LIKE '%epa%' GROUP BY name ORDER BY bytes DESC"""
    ).fetchall()
    total = 0
    print(f"  {'object':40s} {'bytes':>12s} {'cells':>8s}")
    for name, b, c in rows:
        total += b
        print(f"  {name:40s} {b:>12,} {c:>8,}")
    print(f"  {'TOTAL epa objects':40s} {total:>12,}")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="local SQLite/D1 file (never remote)")
    ap.add_argument("--payload", nargs="*", default=[])
    ap.add_argument("--measure", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.execute("PRAGMA foreign_keys = ON")
    plays = 0
    files = []
    for pat in args.payload:
        files.extend(sorted(glob.glob(pat)))
    for path in files:
        with open(path) as fh:
            payload = json.load(fh)
        n = load(con, payload)
        plays += n
        print(f"  loaded {os.path.basename(path):40s} {n:4d} plays")
    con.commit()
    if plays:
        print(f"  {plays} plays from {len(files)} game(s)")
    if args.measure:
        measure(con, args.db)
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
