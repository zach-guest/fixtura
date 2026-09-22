"""NFL adapter: nflverse processed play-by-play -> normalized EPA payload.

Separate from cfb.py on purpose. The two leagues have different models,
different source schemas and different identity spaces, and the plan is
explicit that they must never share a predicate, a baseline or a leaderboard.
Sharing is limited to the pure helpers in common.py.
"""

import duckdb

from common import (
    ValidationError,
    as_id,
    assert_unique,
    content_hash,
    data_core,
    fetch,
    finite,
    log,
    required_finite,
)
from sources import NFL_PBP, NFL_PLAYERS, NFL_SCHEDULES

# Bump when the predicate or the emitted shape changes meaning. Stored per
# game so a later value can be explained rather than guessed at.
PARSER_VERSION = 1
PREDICATE_VERSION = 1
MODEL = "nflverse/nflfastR expected points"

# nflverse season_type -> ESPN seasontype, stated rather than inferred.
SEASON_TYPE_TO_ESPN = {"REG": 2, "POST": 3, "PRE": 1}

# --- the version-one qualifying-play predicate ----------------------------
#
# Written as SQL so the filter and the aggregation cannot drift apart: every
# count in the payload comes from this one WHERE clause.
#
#   epa present and finite   - a play with no EPA contributes nothing
#   play = 1                 - nflverse's own "this was a real play" flag
#   posteam / defteam        - both sides must be known to attribute anything
#   pass = 1 or rush = 1     - nflverse's classification, not ours.
#                              `pass` includes sacks and scrambles;
#                              `rush` is designed runs and excludes scrambles.
#   kneels, spikes           - excluded; they are clock management
#   aborted, deleted         - excluded; not plays that happened as recorded
#
# Accepted-penalty plays stay in when nflverse still classifies them as a pass
# or a rush and supplies EPA. There is no garbage-time filter in version one.
NFL_QUALIFY_SQL = """
    epa IS NOT NULL AND isfinite(epa)
    AND play = 1
    AND posteam IS NOT NULL AND defteam IS NOT NULL
    AND (pass = 1 OR rush = 1)
    AND coalesce(qb_kneel, 0) = 0
    AND coalesce(qb_spike, 0) = 0
    AND coalesce(aborted_play, 0) = 0
    AND coalesce(play_deleted, 0) = 0
"""

# Reported alongside the qualifying count so an operator can see *why* plays
# were dropped instead of only how many.
# The predicate without its data conditions: "this play is one the model is
# supposed to score". Used only to measure per-drive coverage honestly.
IN_SCOPE_SQL = """
    play = 1
    AND (pass = 1 OR rush = 1)
    AND coalesce(qb_kneel, 0) = 0
    AND coalesce(qb_spike, 0) = 0
    AND coalesce(aborted_play, 0) = 0
    AND coalesce(play_deleted, 0) = 0
"""

EXCLUSION_REASONS = [
    ("epa_missing_or_non_finite", "epa IS NULL OR NOT isfinite(epa)"),
    ("not_a_play", "coalesce(play, 0) <> 1"),
    ("no_possession_teams", "posteam IS NULL OR defteam IS NULL"),
    ("not_pass_or_rush", "coalesce(pass, 0) = 0 AND coalesce(rush, 0) = 0"),
    ("qb_kneel", "qb_kneel = 1"),
    ("qb_spike", "qb_spike = 1"),
    ("aborted_play", "aborted_play = 1"),
    ("play_deleted", "play_deleted = 1"),
]


def _pq(path):
    return f"read_parquet('{path}')"


class NflSource:
    """Holds the three nflverse assets and the crosswalks built from them."""

    def __init__(self, season, force=False):
        self.season = season
        self.con = duckdb.connect()
        log(f"NFL source: season {season}")
        self.pbp_path, self.pbp_meta = fetch(NFL_PBP.format(season=season), force=force)
        self.sched_path, self.sched_meta = fetch(NFL_SCHEDULES, force=force)
        self.players_path, self.players_meta = fetch(NFL_PLAYERS, force=force)

    def q(self, sql, params=None):
        return self.con.execute(sql, params or []).fetchall()

    # -- identity ----------------------------------------------------------

    def resolve_game(self, token):
        """Accept either an nflverse game_id or an ESPN event id.

        Fails on an ambiguous or missing mapping rather than picking one.
        """
        rows = self.q(
            f"""SELECT game_id, espn, season, game_type, week, home_team, away_team,
                       gameday, result, overtime
                  FROM {_pq(self.sched_path)}
                 WHERE season = ? AND (game_id = ? OR espn = ?)""",
            [self.season, str(token), str(token)],
        )
        if not rows:
            raise ValidationError(
                f"NFL game {token!r} not found in nflverse schedules for {self.season}"
            )
        if len(rows) > 1:
            raise ValidationError(
                f"NFL game {token!r} is ambiguous: matched {[r[0] for r in rows]}"
            )
        (gid, espn, season, game_type, week, home, away, gameday, result, ot) = rows[0]
        if not espn:
            raise ValidationError(
                f"NFL game {gid} has no ESPN id in nflverse schedules; refusing to "
                "match by date and team names"
            )
        return {
            "nflverse_game_id": gid,
            "event_id": as_id(espn),
            "season": int(season),
            "game_type": game_type,
            "season_type_espn": SEASON_TYPE_TO_ESPN.get(game_type),
            "week": int(week),
            "home_team": home,
            "away_team": away,
            "gameday": gameday,
            "result": result,
            "overtime": int(ot or 0),
        }

    def player_crosswalk(self, gsis_ids):
        """gsis_id -> {espn_athlete_id, display_name}, by ID only.

        A player with no ESPN id keeps their GSIS id and still contributes to
        team EPA; the only thing they lose is the player-popup link.
        """
        ids = sorted({g for g in gsis_ids if g})
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        rows = self.q(
            f"""SELECT gsis_id, espn_id, display_name
                  FROM {_pq(self.players_path)}
                 WHERE gsis_id IN ({placeholders})""",
            ids,
        )
        out = {}
        for gsis, espn, name in rows:
            if gsis in out:
                raise ValidationError(
                    f"ambiguous player crosswalk: gsis_id {gsis} appears twice"
                )
            out[gsis] = {"espn_athlete_id": as_id(espn), "display_name": name}
        return out

    # -- extraction --------------------------------------------------------

    def drives(self, game, plays):
        """Provider drive summaries. Nothing here is inferred.

        `yards` is deliberately absent: nflverse publishes no drive net-yards
        field. It has drive_start_yard_line / drive_end_yard_line as text
        ("MIN 25"), and subtracting those is a field-position delta, which the
        accepted contract forbids. Null is the honest answer.
        """
        gid = game["nflverse_game_id"]
        rows = self.con.execute(
            f"""SELECT fixed_drive,
                       any_value(fixed_drive_result)      AS result,
                       max(drive_play_count)              AS plays,
                       any_value(drive_quarter_start)     AS start_period,
                       any_value(drive_quarter_end)       AS end_period,
                       any_value(drive_game_clock_start)  AS start_clock,
                       any_value(drive_game_clock_end)    AS end_clock,
                       any_value(posteam)                 AS possession_team,
                       -- Coverage is measured against what OUR predicate should
                       -- have scored, not against drive_play_count. The two count
                       -- different things: nflverse excludes accepted-penalty
                       -- plays from drive_play_count while the predicate keeps
                       -- them, so modeled > provider on 18.1% of 2025 drives.
                       -- Comparing them would mark a fifth of the league partial
                       -- for no reason. `in_scope` is the predicate minus its
                       -- data conditions; a shortfall against `scored` means a
                       -- play we should have had was missing EPA or teams.
                       count(*) FILTER (WHERE {IN_SCOPE_SQL})  AS in_scope,
                       count(*) FILTER (WHERE {NFL_QUALIFY_SQL}) AS scored
                  FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND fixed_drive IS NOT NULL AND posteam IS NOT NULL
                 GROUP BY fixed_drive ORDER BY fixed_drive""",
            [gid],
        ).fetchall()
        names = [d[0] for d in self.con.description]
        return [dict(zip(names, r)) for r in rows]

    def eligible_counts(self, game):
        """What the source held for this game, before the predicate."""
        gid = game["nflverse_game_id"]
        plays = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND coalesce(play,0)=1",
            [gid],
        )[0][0]
        drives = self.q(
            f"""SELECT count(DISTINCT fixed_drive) FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND fixed_drive IS NOT NULL AND posteam IS NOT NULL""",
            [gid],
        )[0][0]
        return {"eligible_plays": int(plays), "eligible_drives": int(drives)}

    def plays(self, game):
        gid = game["nflverse_game_id"]
        cols = """play_id, drive, fixed_drive, qtr, time, down, ydstogo, yardline_100,
                  posteam, defteam, play_type, "desc", ep, epa, qb_epa, success,
                  pass, rush, qb_dropback, sack, penalty,
                  passer_player_id, rusher_player_id, receiver_player_id"""
        rows = self.con.execute(
            f"""SELECT {cols} FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND {NFL_QUALIFY_SQL}
                 ORDER BY play_id""",
            [gid],
        ).fetchall()
        names = [d[0] for d in self.con.description]
        return [dict(zip(names, r)) for r in rows]

    def play_census(self, game):
        gid = game["nflverse_game_id"]
        total = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ?", [gid]
        )[0][0]
        if total == 0:
            raise ValidationError(f"no play-by-play rows for NFL game {gid}")
        qualifying = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND {NFL_QUALIFY_SQL}",
            [gid],
        )[0][0]
        reasons = {}
        for label, cond in EXCLUSION_REASONS:
            reasons[label] = self.q(
                f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND ({cond})",
                [gid],
            )[0][0]
        return {"source_rows": total, "qualifying_plays": qualifying, "excluded_by": reasons}


def normalize_game(src, token):
    """Build one deterministic, fully validated payload for one NFL game."""
    game = src.resolve_game(token)
    ctx = f"NFL {game['nflverse_game_id']} (ESPN {game['event_id']})"
    raw = src.plays(game)
    if not raw:
        raise ValidationError(f"{ctx}: no qualifying plays")

    valid_teams = {game["home_team"], game["away_team"]}
    plays = []
    for r in raw:
        pos, dfn = r["posteam"], r["defteam"]
        if pos not in valid_teams or dfn not in valid_teams:
            raise ValidationError(
                f"{ctx}: play {r['play_id']} has teams {pos}/{dfn} outside {sorted(valid_teams)}"
            )
        if pos == dfn:
            raise ValidationError(f"{ctx}: play {r['play_id']} has posteam == defteam")
        plays.append(
            {
                "play_id": as_id(r["play_id"]),
                "drive": as_id(r["fixed_drive"] if r["fixed_drive"] is not None else r["drive"]),
                "quarter": _sentinel_zero(r["qtr"]),
                "clock": r["time"],
                "down": _sentinel_zero(r["down"]),
                "yards_to_go": int(r["ydstogo"]) if r["ydstogo"] is not None else None,
                "yardline_100": int(r["yardline_100"]) if r["yardline_100"] is not None else None,
                "possession_team": pos,
                "defense_team": dfn,
                "play_type": r["play_type"],
                "description": r["desc"],
                "ep_before": finite(r["ep"], "ep", ctx),
                "epa": required_finite(r["epa"], "epa", ctx),
                "qb_epa": finite(r["qb_epa"], "qb_epa", ctx),
                "success": int(r["success"]) if r["success"] is not None else None,
                "is_pass": bool(r["pass"]),
                "is_rush": bool(r["rush"]),
                "is_dropback": bool(r["qb_dropback"]),
                "is_sack": bool(r["sack"]),
                "is_penalty": bool(r["penalty"]),
                "passer_gsis_id": as_id(r["passer_player_id"]),
                "rusher_gsis_id": as_id(r["rusher_player_id"]),
                "receiver_gsis_id": as_id(r["receiver_player_id"]),
            }
        )

    assert_unique(plays, ["play_id"], "NFL play")

    crosswalk = src.player_crosswalk(
        [p["passer_gsis_id"] for p in plays] + [p["rusher_gsis_id"] for p in plays]
    )
    team_games = _team_games(game, plays)
    player_games = _player_games(game, plays, crosswalk)
    drives = _drives(game, src.drives(game, plays), plays)
    eligible = src.eligible_counts(game)

    payload = {
        "league": "nfl",
        "model": MODEL,
        "parser_version": PARSER_VERSION,
        "predicate_version": PREDICATE_VERSION,
        "event_id": game["event_id"],
        "nflverse_game_id": game["nflverse_game_id"],
        "season": game["season"],
        "season_type_espn": game["season_type_espn"],
        "season_type_source": game["game_type"],
        "week": game["week"],
        "home_team": game["home_team"],
        "away_team": game["away_team"],
        "gameday": game["gameday"],
        "overtime": bool(game["overtime"]),
        "source": {
            "pbp_url": src.pbp_meta["url"],
            "pbp_sha256": src.pbp_meta["sha256"],
            "pbp_last_modified": src.pbp_meta.get("last_modified"),
            "pbp_etag": src.pbp_meta.get("etag"),
            "schedules_url": src.sched_meta["url"],
            "schedules_last_modified": src.sched_meta.get("last_modified"),
            "players_url": src.players_meta["url"],
            "players_last_modified": src.players_meta.get("last_modified"),
        },
        "census": src.play_census(game),
        "coverage": {
            "eligible_plays": eligible["eligible_plays"],
            "modeled_plays": len(plays),
            "eligible_drives": eligible["eligible_drives"],
            "complete_drives": sum(1 for d in drives if d["coverage"] == "complete"),
        },
        "plays": plays,
        "drives": drives,
        "team_games": team_games,
        "player_games": player_games,
    }
    _check_reconciliation(payload)
    # Hashed over the data core only -- fetch-time metadata (ETags, release
    # timestamps, Last-Modified) is deliberately excluded, or the hash would
    # change whenever upstream republished anything even though every play was
    # identical. See common.VOLATILE_SOURCE_FIELDS.
    payload["content_hash"] = content_hash(data_core(payload))
    return payload


def _sentinel_zero(value):
    """Same reading as the CFB adapter: 0 means "not applicable", not zero."""
    if value is None:
        return None
    n = int(value)
    return n if n > 0 else None


def _drives(game, rows, plays):
    """One row per provider drive, with EPA summed over modeled plays only.

    A drive is `complete` when every play the model was supposed to score
    actually scored -- not when its play count equals the provider's.
    `drive_play_count` excludes accepted-penalty plays while the predicate
    keeps them (a deliberate, recorded choice), so the two counts disagree on
    18.1% of 2025 drives and comparing them would report a fifth of the league
    as partial for no real reason. `partial` here means a play that should have
    carried EPA did not.
    """
    modeled = {}
    for p in plays:
        key = p["drive"]
        if key is None:
            continue
        agg = modeled.setdefault(key, {"epa": 0.0, "n": 0})
        agg["epa"] += p["epa"]
        agg["n"] += 1

    out = []
    for i, r in enumerate(rows, start=1):
        key = as_id(r["fixed_drive"])
        agg = modeled.get(key, {"epa": None, "n": 0})
        provider_plays = int(r["plays"]) if r["plays"] is not None else None
        in_scope = int(r["in_scope"] or 0)
        scored = int(r["scored"] or 0)
        out.append({
            "event_id": game["event_id"],
            "drive_id": key,
            "sequence": i,
            "possession_team": r["possession_team"],
            "start_period": _sentinel_zero(r["start_period"]),
            "start_clock": r["start_clock"],
            "end_period": _sentinel_zero(r["end_period"]),
            "end_clock": r["end_clock"],
            "result": r["result"],
            # The provider's own count, verbatim. NOT comparable with
            # modeled_plays -- see the coverage note above.
            "plays": provider_plays,
            # Always null for the NFL. See NflSource.drives.
            "yards": None,
            "epa": agg["epa"] if agg["n"] else None,
            "modeled_plays": agg["n"],
            "in_scope_plays": in_scope,
            "coverage": "complete" if scored == in_scope else "partial",
        })
    assert_unique(out, ["event_id", "drive_id"], "NFL drive")
    return out


def _team_games(game, plays):
    """Two rows. Defense is the negation of the opponent's offense.

    Numerators and denominators are stored, never a pre-divided rate: a season
    rate has to be recomputed from summed totals, not averaged from games.
    """
    out = {}
    for team in (game["home_team"], game["away_team"]):
        out[team] = {
            "event_id": game["event_id"],
            "team": team,
            "opponent": game["away_team"] if team == game["home_team"] else game["home_team"],
            "home_away": "home" if team == game["home_team"] else "away",
            "off_epa": 0.0,
            "off_plays": 0,
            "off_success": 0,
            "off_pass_epa": 0.0,
            "off_dropbacks": 0,
            "off_pass_success": 0,
            "off_rush_epa": 0.0,
            "off_designed_rushes": 0,
            "off_rush_success": 0,
        }
    for p in plays:
        t = out[p["possession_team"]]
        t["off_epa"] += p["epa"]
        t["off_plays"] += 1
        t["off_success"] += p["success"] or 0
        if p["is_pass"]:
            t["off_pass_epa"] += p["epa"]
            t["off_dropbacks"] += 1
            t["off_pass_success"] += p["success"] or 0
        if p["is_rush"]:
            t["off_rush_epa"] += p["epa"]
            t["off_designed_rushes"] += 1
            t["off_rush_success"] += p["success"] or 0

    rows = []
    for team, row in out.items():
        opp = out[row["opponent"]]
        # Sign convention: higher is better for defense too, so defensive EPA
        # is the negation of what the offense gained. Recorded explicitly in
        # the payload so no reader has to infer it.
        row["def_epa"] = -opp["off_epa"]
        row["def_plays"] = opp["off_plays"]
        row["def_pass_epa"] = -opp["off_pass_epa"]
        row["def_dropbacks_faced"] = opp["off_dropbacks"]
        row["def_rush_epa"] = -opp["off_rush_epa"]
        row["def_designed_rushes_faced"] = opp["off_designed_rushes"]
        row["def_success_allowed"] = opp["off_success"]
        row["defense_sign_convention"] = "negated_opponent_offense_higher_is_better"
        rows.append(row)
    rows.sort(key=lambda r: r["team"])
    assert_unique(rows, ["event_id", "team"], "NFL team-game")
    return rows


def _player_games(game, plays, crosswalk):
    """QB rows use nflverse `qb_epa`; rusher rows use designed-rush `epa`.

    A QB's dropback count here is NOT the same number as a team's dropback
    count. Team dropbacks are every qualifying `pass` play, which includes
    sacks and scrambles with no named passer; a QB row counts only plays with
    qb_dropback set and that QB named. The two are reported separately and
    must not be conflated.
    """
    rows = {}

    def bucket(gsis, role, team):
        key = (gsis, role)
        if key not in rows:
            info = crosswalk.get(gsis, {})
            rows[key] = {
                "event_id": game["event_id"],
                "gsis_id": gsis,
                "espn_athlete_id": info.get("espn_athlete_id"),
                "display_name": info.get("display_name"),
                "team": team,
                "role": role,
                "epa": 0.0,
                "opportunities": 0,
                "successes": 0,
            }
        return rows[key]

    for p in plays:
        if p["is_dropback"] and p["passer_gsis_id"]:
            if p["qb_epa"] is None:
                raise ValidationError(
                    f"NFL {game['event_id']}: dropback play {p['play_id']} has a named "
                    "passer but no qb_epa"
                )
            r = bucket(p["passer_gsis_id"], "qb", p["possession_team"])
            r["epa"] += p["qb_epa"]
            r["opportunities"] += 1
            r["successes"] += p["success"] or 0
        if p["is_rush"] and p["rusher_gsis_id"]:
            r = bucket(p["rusher_gsis_id"], "rusher", p["possession_team"])
            r["epa"] += p["epa"]
            r["opportunities"] += 1
            r["successes"] += p["success"] or 0

    out = sorted(rows.values(), key=lambda r: (r["role"], r["gsis_id"]))
    assert_unique(out, ["event_id", "gsis_id", "role"], "NFL player-game")
    return out


def _check_reconciliation(payload):
    """Team rows must add back up to the play rows they came from."""
    ctx = f"NFL {payload['event_id']}"
    total_plays = sum(t["off_plays"] for t in payload["team_games"])
    if total_plays != len(payload["plays"]):
        raise ValidationError(
            f"{ctx}: team offensive play counts sum to {total_plays}, "
            f"but {len(payload['plays'])} qualifying plays were emitted"
        )
    play_epa = sum(p["epa"] for p in payload["plays"])
    team_epa = sum(t["off_epa"] for t in payload["team_games"])
    if abs(play_epa - team_epa) > 1e-6:
        raise ValidationError(
            f"{ctx}: play EPA {play_epa!r} != summed team offensive EPA {team_epa!r}"
        )
    for t in payload["team_games"]:
        if t["off_dropbacks"] + t["off_designed_rushes"] != t["off_plays"]:
            raise ValidationError(
                f"{ctx}: {t['team']} pass+rush splits do not partition its plays"
            )
