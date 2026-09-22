"""CFB adapter: SportsDataverse / cfbfastR ESPN-derived play-by-play.

A separate file from nfl.py, and separate on purpose. The college model is a
different model, the schema is a different schema, and the identity space is
ESPN's rather than nflverse's. Nothing here may be merged into an NFL
leaderboard, baseline or percentile.

Two things measured on 2026-09-09 drive the shape of this adapter:

1. `game_id` is the ESPN event id and the player id columns are ESPN athlete
   ids, so college needs no crosswalk. Verified: all 97 games in the 2026
   asset are inside ESPN's own groups=80 week-1 final set, with no extras.

2. The current-season asset carries games that were captured mid-game and
   never re-captured. 44 of 99 ESPN week-1 finals were still truncated three
   to eleven days later. `status_type_completed` identifies them exactly, and
   is the only safe gate -- one truncated game held 179 plays, MORE than a
   complete game's 161, so a play-count plausibility check would have passed
   it. See COMPLETENESS_GATE below.
"""

import duckdb

from common import (
    ValidationError,
    as_id,
    assert_unique,
    content_hash,
    data_core,
    fetch,
    fetch_json,
    finite,
    log,
    required_finite,
)
from sources import CFB_GAME_JSON, CFB_PBP, CFB_TIMESTAMP

PARSER_VERSION = 1
PREDICATE_VERSION = 1
MODEL = "cfbfastR/SportsDataverse college expected points"

# The gate, named so it cannot be quietly removed. A game is importable only
# when the source itself says the capture is of a completed game.
COMPLETENESS_GATE = "status_type_completed = true"

# --- the version-one CFB qualifying-play predicate ------------------------
#
# Deliberately NOT the NFL predicate. cfbfastR publishes its own
# `scrimmage_play` flag, which is the college taxonomy's own answer to "was
# this a play from scrimmage", and the pass/rush booleans are real booleans
# rather than nflverse's 0/1 doubles.
#
#   EPA present and finite  - no EPA, no contribution
#   scrimmage_play          - the source's own scrimmage classification
#   pos/def team ids        - both sides known, so EPA can be attributed
#
# Kneels and spikes, measured on the 2026 asset rather than assumed:
#
#   kneels  -- the source has a `kneel_down` flag. 48 rows carry it and all 48
#              are already outside `scrimmage_play`, so zero reach the
#              qualifying set. The flag is named in the predicate anyway so the
#              contract is explicit rather than incidental, and so a future
#              capture that marks a kneel as a scrimmage play cannot slip in.
#   spikes  -- there is NO spike flag in this schema. All 3 spikes in week 1
#              are classified `Pass Incompletion` with `scrimmage_play = true`
#              and DO qualify. That is a real divergence from the NFL
#              predicate, which excludes spikes explicitly.
#
# The spikes are left in deliberately. At 3 plays in 8,895 (0.03%) they move
# nothing, and the only way to exclude them here would be to pattern-match the
# description text, which is exactly the kind of speculative fix this project
# has been bitten by before. Recorded as a known difference for the schema
# review instead. If it ever needs fixing, ask the source for a flag rather
# than inventing one.
#
# NOTE, and do not "fix" this: unlike the NFL predicate, this one does NOT
# require pass or rush. `scrimmage_play` is the college taxonomy's own
# denominator, and the plan's CFB contract is built on "EPA per scrimmage
# play". Measured on the 2026 asset, 88 of 8,895 qualifying plays (1.0%) are
# scrimmage plays that are neither: fumble recoveries, safeties, and a
# defensive two-point conversion. They carry real EPA and belong in the team
# total.
#
# The consequence is that for CFB, off_pass_plays + off_rush_plays is about 1%
# LESS than off_plays, while for the NFL the two sides partition exactly.
# _check_reconciliation therefore deliberately omits the partition assertion
# that nfl.py makes. Adding one here would fail on every game with a fumble
# recovery.
CFB_QUALIFY_SQL = """
    EPA IS NOT NULL AND isfinite(EPA)
    AND scrimmage_play = true
    AND pos_team_id IS NOT NULL AND def_pos_team_id IS NOT NULL
    AND coalesce(kneel_down, false) = false
"""

# Conditions that ARE terms of the predicate above. Counted over all rows, so
# they overlap; each says "this many rows meet this exclusion", not "this many
# were excluded only by this".
# The predicate without its data conditions: plays the model is supposed to
# score. Used only to measure per-drive coverage, so a drive is judged against
# what we should have scored rather than against the provider's own play count,
# which counts something different.
IN_SCOPE_SQL = """
    scrimmage_play = true
    AND coalesce(kneel_down, false) = false
"""

EXCLUSION_REASONS = [
    ("epa_missing_or_non_finite", "EPA IS NULL OR NOT isfinite(EPA)"),
    ("not_scrimmage_play", "coalesce(scrimmage_play, false) = false"),
    ("no_possession_teams", "pos_team_id IS NULL OR def_pos_team_id IS NULL"),
    ("kneel_down", "kneel_down = true"),
]

# Conditions that are NOT terms of the predicate. These are reported separately
# and labelled as such, because printing them under "excluded by" said rows had
# been dropped when they had not. Measured week 1 2026: of 621 penalty-no-play
# rows, 610 fall out via `scrimmage_play` and 11 still qualify; every kickoff
# is already excluded; ~1% of qualifying plays are neither pass nor rush.
INFORMATIONAL_COUNTS = [
    ("qualifying_but_penalty_no_play", "penalty_no_play = true AND " + CFB_QUALIFY_SQL),
    ("qualifying_but_neither_pass_nor_rush",
     "coalesce(pass, false) = false AND coalesce(rush, false) = false AND " + CFB_QUALIFY_SQL),
]


def _pq(path):
    return f"read_parquet('{path}')"


def _sentinel_zero(value):
    """The source writes 0 where a field does not apply. Measured on the 2026
    asset: 5 qualifying plays carry `down = 0` and 20 drives carry
    `drive.end.period.number = 0`. Zero is not a real down or period -- it is
    the provider's way of saying "not applicable" -- so it becomes null, which
    is what it means. Storing 0 would render as "0th down"."""
    if value is None:
        return None
    n = int(value)
    return n if n > 0 else None


def _athlete_id(value):
    """cfbfastR uses NEGATIVE ids for unidentified participants -- 5 qualifying
    plays in 2026 week 1 (three passers, two rushers). They are not ESPN
    athlete ids and can never link to a player, so they are dropped rather than
    stored as identity. The play and its EPA are kept; only the attribution is
    absent, which is the honest reading."""
    if value is None:
        return None
    try:
        if int(value) <= 0:
            return None
    except (TypeError, ValueError):
        return None
    return as_id(value)


def _event_id(token):
    """ESPN event ids are numeric. Reject anything else as a contract error."""
    text = str(token).strip()
    if not text.isdigit():
        raise ValidationError(
            f"CFB game token {token!r} is not an ESPN event id. College takes ESPN "
            "event ids only -- there is no other id space in this source."
        )
    return int(text)


class CfbSource:
    def __init__(self, season, force=False):
        self.season = season
        self.con = duckdb.connect()
        log(f"CFB source: season {season}")
        self.pbp_path, self.pbp_meta = fetch(CFB_PBP.format(season=season), force=force)
        try:
            self.release_timestamp = fetch_json(CFB_TIMESTAMP)
        except Exception as exc:  # noqa: BLE001
            self.release_timestamp = {"error": str(exc)}

    def q(self, sql, params=None):
        return self.con.execute(sql, params or []).fetchall()

    def game_header(self, event_id):
        rows = self.q(
            f"""SELECT any_value(season), any_value(week), any_value(seasonType),
                       any_value(homeTeamId), any_value(awayTeamId),
                       any_value(status_type_completed), count(*)
                  FROM {_pq(self.pbp_path)} WHERE game_id = ?""",
            [_event_id(event_id)],
        )
        spread = self.q(
            f"""SELECT count(DISTINCT season), count(DISTINCT week),
                       count(DISTINCT seasonType), count(DISTINCT homeTeamId),
                       count(DISTINCT awayTeamId), count(DISTINCT status_type_completed)
                  FROM {_pq(self.pbp_path)} WHERE game_id = ?""",
            [_event_id(event_id)],
        )
        if spread and spread[0][0] and max(spread[0]) > 1:
            raise ValidationError(
                f"CFB event {event_id}: rows disagree on the game's own header fields "
                f"(distinct counts season/week/type/home/away/completed = {spread[0]}). "
                "A partial re-capture may have written inconsistent values; refusing to "
                "collapse them with any_value()."
            )
        if not rows or rows[0][6] == 0:
            raise ValidationError(
                f"CFB event {event_id} is absent from {self.pbp_meta['url']}. "
                "This is a coverage gap, not a reason to fall back to another source."
            )
        season, week, stype, home, away, completed, n = rows[0]
        return {
            "event_id": as_id(event_id),
            "season": int(season),
            "week": int(week),
            "season_type_espn": int(stype),
            "home_team_id": as_id(home),
            "away_team_id": as_id(away),
            "source_says_completed": bool(completed),
            "source_rows": int(n),
        }

    def plays(self, event_id):
        cols = """id, game_play_number, "drive.id", period, "clock.displayValue",
                  down, distance, "start.yardsToEndzone",
                  pos_team_id, pos_team, def_pos_team_id, def_pos_team,
                  "type.text", text, EP_start, EPA, def_EPA, EPA_success,
                  pass, rush, sack, penalty_no_play,
                  passer_player_id, rusher_player_id, receiver_player_id,
                  passer_player_name, rusher_player_name, receiver_player_name"""
        rows = self.con.execute(
            f"""SELECT {cols} FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND {CFB_QUALIFY_SQL}
                 ORDER BY game_play_number, id""",
            [_event_id(event_id)],
        ).fetchall()
        names = [d[0] for d in self.con.description]
        return [dict(zip(names, r)) for r in rows]

    def drives(self, event_id):
        """Provider drive summaries. cfbfastR publishes all of these directly,
        including real net yards (`drive.yards`), which the NFL source does not."""
        rows = self.con.execute(
            f"""SELECT "drive.id"                          AS drive_id,
                       any_value("drive.result")           AS result,
                       any_value("drive.offensivePlays")   AS plays,
                       any_value("drive.yards")            AS yards,
                       any_value("drive.start.period.number")        AS start_period,
                       any_value("drive.start.clock.displayValue")   AS start_clock,
                       any_value("drive.end.period.number")          AS end_period,
                       any_value("drive.end.clock.displayValue")     AS end_clock,
                       any_value(pos_team_id)              AS possession_team_id,
                       any_value(pos_team)                 AS possession_team,
                       count(*) FILTER (WHERE {IN_SCOPE_SQL})    AS in_scope,
                       count(*) FILTER (WHERE {CFB_QUALIFY_SQL}) AS scored,
                       min(game_play_number)               AS first_play
                  FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND "drive.id" IS NOT NULL AND pos_team_id IS NOT NULL
                 GROUP BY "drive.id" ORDER BY min(game_play_number)""",
            [_event_id(event_id)],
        ).fetchall()
        names = [d[0] for d in self.con.description]
        return [dict(zip(names, r)) for r in rows]

    def eligible_counts(self, event_id):
        eid = _event_id(event_id)
        plays = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND coalesce(play,false)=true",
            [eid],
        )[0][0]
        drives = self.q(
            f"""SELECT count(DISTINCT "drive.id") FROM {_pq(self.pbp_path)}
                 WHERE game_id = ? AND "drive.id" IS NOT NULL AND pos_team_id IS NOT NULL""",
            [eid],
        )[0][0]
        return {"eligible_plays": int(plays), "eligible_drives": int(drives)}

    def census(self, event_id):
        total = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ?", [int(event_id)]
        )[0][0]
        qualifying = self.q(
            f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND {CFB_QUALIFY_SQL}",
            [_event_id(event_id)],
        )[0][0]
        reasons, info = {}, {}
        for target, pairs in ((reasons, EXCLUSION_REASONS), (info, INFORMATIONAL_COUNTS)):
            for label, cond in pairs:
                target[label] = self.q(
                    f"SELECT count(*) FROM {_pq(self.pbp_path)} WHERE game_id = ? AND ({cond})",
                    [_event_id(event_id)],
                )[0][0]
        return {
            "source_rows": total,
            "qualifying_plays": qualifying,
            "excluded_by": reasons,
            "included_but_notable": info,
        }

    def coverage(self, espn_final_ids, week=None):
        """Split ESPN's finals into complete / truncated / missing.

        These three are different states and are never collapsed into one
        "imported" number: a truncated game is present and wrong, which is
        more dangerous than one that is plainly absent.
        """
        where = "WHERE 1=1" + (" AND week = ?" if week is not None else "")
        params = [week] if week is not None else []
        rows = self.q(
            f"""SELECT game_id, any_value(status_type_completed), count(*), max(period)
                  FROM {_pq(self.pbp_path)} {where} GROUP BY 1""",
            params,
        )
        present = {as_id(g): {"completed": bool(c), "rows": n, "max_period": p} for g, c, n, p in rows}
        espn = set(espn_final_ids)
        complete = sorted(g for g, v in present.items() if v["completed"] and g in espn)
        truncated = sorted(g for g, v in present.items() if not v["completed"] and g in espn)
        missing = sorted(espn - set(present))
        extra = sorted(set(present) - espn)
        return {
            "espn_finals": len(espn),
            "source_games": len(present),
            "importable_complete": complete,
            "present_but_truncated": truncated,
            "missing_entirely": missing,
            "in_source_not_in_espn_coverage": extra,
            "detail": present,
        }


def normalize_game(src, event_id, allow_incomplete=False):
    header = src.game_header(event_id)
    ctx = f"CFB ESPN {header['event_id']}"

    if not header["source_says_completed"] and not allow_incomplete:
        raise ValidationError(
            f"{ctx}: the source's own status_type_completed is false, so this capture "
            f"is of a game still in progress ({header['source_rows']} rows). Refusing to "
            "emit. Play count is not a substitute check -- a truncated 2026 game was "
            "observed with 179 rows, more than a complete game's 161. Re-run when the "
            "upstream re-captures the game, or pass --allow-incomplete to inspect it."
        )

    raw = src.plays(event_id)
    if not raw:
        raise ValidationError(f"{ctx}: no qualifying plays")

    valid_teams = {header["home_team_id"], header["away_team_id"]}
    plays = []
    for r in raw:
        pos, dfn = as_id(r["pos_team_id"]), as_id(r["def_pos_team_id"])
        if pos not in valid_teams or dfn not in valid_teams:
            raise ValidationError(
                f"{ctx}: play {r['id']} has team ids {pos}/{dfn} outside "
                f"{sorted(valid_teams)}"
            )
        if pos == dfn:
            raise ValidationError(f"{ctx}: play {r['id']} has possession == defense")
        epa = required_finite(r["EPA"], "EPA", ctx)
        def_epa = finite(r["def_EPA"], "def_EPA", ctx)
        # The source publishes def_EPA as the negation of EPA. Verified rather
        # than assumed, per play, because the whole defensive sign convention
        # rests on it.
        if def_epa is not None and abs(def_epa + epa) > 1e-6:
            raise ValidationError(
                f"{ctx}: play {r['id']} def_EPA {def_epa!r} is not the negation of "
                f"EPA {epa!r}; the assumed sign convention does not hold"
            )
        plays.append(
            {
                # String, always. The largest observed 2026 play id is
                # 401858212104999901, far past JavaScript's 2**53-1.
                "play_id": as_id(r["id"]),
                "play_number": int(r["game_play_number"]) if r["game_play_number"] is not None else None,
                "drive_id": as_id(r["drive.id"]),
                "period": _sentinel_zero(r["period"]),
                "clock": r["clock.displayValue"],
                "down": _sentinel_zero(r["down"]),
                "yards_to_go": int(r["distance"]) if r["distance"] is not None else None,
                "yards_to_endzone": (
                    int(r["start.yardsToEndzone"]) if r["start.yardsToEndzone"] is not None else None
                ),
                "possession_team_id": pos,
                "possession_team": r["pos_team"],
                "defense_team_id": dfn,
                "defense_team": r["def_pos_team"],
                "play_type": r["type.text"],
                "description": r["text"],
                "ep_before": finite(r["EP_start"], "EP_start", ctx),
                "epa": epa,
                # NULL stays NULL. Missing is not zero -- matching nfl.py, which
                # preserves it. (Never observed NULL in the 2026 data, but the
                # two adapters must not disagree on a rule this basic.)
                "success": None if r["EPA_success"] is None else (1 if r["EPA_success"] else 0),
                "is_pass": bool(r["pass"]),
                "is_rush": bool(r["rush"]),
                "is_sack": bool(r["sack"]),
                "is_penalty_no_play": bool(r["penalty_no_play"]),
                "passer_athlete_id": _athlete_id(r["passer_player_id"]),
                "passer_name": r["passer_player_name"],
                "rusher_athlete_id": _athlete_id(r["rusher_player_id"]),
                "rusher_name": r["rusher_player_name"],
                "receiver_athlete_id": _athlete_id(r["receiver_player_id"]),
                "receiver_name": r["receiver_player_name"],
            }
        )

    assert_unique(plays, ["play_id"], "CFB play")

    drives = _drives(header, src.drives(event_id), plays)
    eligible = src.eligible_counts(event_id)

    payload = {
        "league": "cfb",
        "model": MODEL,
        "parser_version": PARSER_VERSION,
        "predicate_version": PREDICATE_VERSION,
        "event_id": header["event_id"],
        "season": header["season"],
        "season_type_espn": header["season_type_espn"],
        "week": header["week"],
        "home_team_id": header["home_team_id"],
        "away_team_id": header["away_team_id"],
        "source": {
            "dataset": "sportsdataverse-data espn_cfb_pbp compiled season parquet",
            "pbp_url": src.pbp_meta["url"],
            "pbp_sha256": src.pbp_meta["sha256"],
            "pbp_last_modified": src.pbp_meta.get("last_modified"),
            "pbp_etag": src.pbp_meta.get("etag"),
            "release_timestamp": src.release_timestamp,
        },
        "source_says_completed": header["source_says_completed"],
        "census": src.census(event_id),
        "coverage": {
            "eligible_plays": eligible["eligible_plays"],
            "modeled_plays": len(plays),
            "eligible_drives": eligible["eligible_drives"],
            "complete_drives": sum(1 for d in drives if d["coverage"] == "complete"),
        },
        "plays": plays,
        "drives": drives,
        "team_games": _team_games(header, plays),
        "player_games": _player_games(header, plays),
    }
    _check_reconciliation(payload)
    # Hashed over the data core only -- fetch-time metadata (ETags, release
    # timestamps, Last-Modified) is deliberately excluded, or the hash would
    # change whenever upstream republished anything even though every play was
    # identical. See common.VOLATILE_SOURCE_FIELDS.
    payload["content_hash"] = content_hash(data_core(payload))
    return payload


def _drives(header, rows, plays):
    """One row per provider drive. Result, play count and yards are the
    source's own values; only EPA is derived, by summing the plays that passed
    the qualifying predicate.

    `coverage` compares what the model should have scored against what it did,
    NOT the provider's play count against ours. The two count different things
    (see the NFL adapter, where the same comparison would mark 18.1% of drives
    partial for no reason), so provider `plays` is kept verbatim beside our
    `modeled_plays` and neither stands in for the other."""
    modeled = {}
    for p in plays:
        key = p["drive_id"]
        if key is None:
            continue
        agg = modeled.setdefault(key, {"epa": 0.0, "n": 0})
        agg["epa"] += p["epa"]
        agg["n"] += 1

    out = []
    for i, r in enumerate(rows, start=1):
        key = as_id(r["drive_id"])
        agg = modeled.get(key, {"epa": None, "n": 0})
        provider_plays = int(r["plays"]) if r["plays"] is not None else None
        in_scope = int(r["in_scope"] or 0)
        scored = int(r["scored"] or 0)
        out.append({
            "event_id": header["event_id"],
            "drive_id": key,
            "sequence": i,
            "possession_team_id": as_id(r["possession_team_id"]),
            "possession_team": r["possession_team"],
            "start_period": _sentinel_zero(r["start_period"]),
            "start_clock": r["start_clock"],
            "end_period": _sentinel_zero(r["end_period"]),
            "end_clock": r["end_clock"],
            "result": r["result"],
            # The provider's own count, verbatim. NOT comparable with
            # modeled_plays -- see the coverage note above.
            "plays": provider_plays,
            "yards": int(r["yards"]) if r["yards"] is not None else None,
            "epa": agg["epa"] if agg["n"] else None,
            "modeled_plays": agg["n"],
            "in_scope_plays": in_scope,
            "coverage": "complete" if scored == in_scope else "partial",
        })
    assert_unique(out, ["event_id", "drive_id"], "CFB drive")
    return out


def _team_games(header, plays):
    out = {}
    for tid in (header["home_team_id"], header["away_team_id"]):
        out[tid] = {
            "event_id": header["event_id"],
            "team_id": tid,
            "team": None,
            "opponent_id": header["away_team_id"] if tid == header["home_team_id"] else header["home_team_id"],
            "home_away": "home" if tid == header["home_team_id"] else "away",
            "off_epa": 0.0,
            "off_plays": 0,
            "off_success": 0,
            "off_pass_epa": 0.0,
            "off_pass_plays": 0,
            "off_pass_success": 0,
            "off_rush_epa": 0.0,
            "off_rush_plays": 0,
            "off_rush_success": 0,
        }
    for p in plays:
        t = out[p["possession_team_id"]]
        t["team"] = t["team"] or p["possession_team"]
        t["off_epa"] += p["epa"]
        t["off_plays"] += 1
        t["off_success"] += p["success"] or 0
        if p["is_pass"]:
            t["off_pass_epa"] += p["epa"]
            t["off_pass_plays"] += 1
            t["off_pass_success"] += p["success"] or 0
        if p["is_rush"]:
            t["off_rush_epa"] += p["epa"]
            t["off_rush_plays"] += 1
            t["off_rush_success"] += p["success"] or 0

    rows = []
    for tid, row in out.items():
        opp = out[row["opponent_id"]]
        row["opponent"] = opp["team"]
        row["def_epa"] = -opp["off_epa"]
        row["def_plays"] = opp["off_plays"]
        row["def_pass_epa"] = -opp["off_pass_epa"]
        row["def_pass_plays_faced"] = opp["off_pass_plays"]
        row["def_rush_epa"] = -opp["off_rush_epa"]
        row["def_rush_plays_faced"] = opp["off_rush_plays"]
        row["def_success_allowed"] = opp["off_success"]
        row["defense_sign_convention"] = "negated_opponent_offense_higher_is_better"
        rows.append(row)
    rows.sort(key=lambda r: r["team_id"])
    assert_unique(rows, ["event_id", "team_id"], "CFB team-game")
    return rows


def _player_games(header, plays):
    """Passer and rusher rows only.

    There is no college `qb_epa` equivalent, so a passer's EPA is the EPA of
    the plays they threw on -- which is a team outcome credited to the passer,
    not an isolated measure of the passer. That difference from the NFL rows
    (which use nflverse's own qb_epa) is why `epa_basis` is carried on every
    row instead of being left for a reader to assume.
    """
    rows = {}

    def bucket(aid, role, team_id, team, name):
        key = (aid, role)
        if key not in rows:
            rows[key] = {
                "event_id": header["event_id"],
                "athlete_id": aid,
                # Carried for readability only. Identity is the ESPN athlete
                # id; nothing is ever matched or joined on this name.
                "display_name": name,
                "team_id": team_id,
                "team": team,
                "role": role,
                "epa": 0.0,
                "opportunities": 0,
                "successes": 0,
                "epa_basis": "play_epa_on_plays_where_athlete_is_named",
            }
        return rows[key]

    for p in plays:
        if p["is_pass"] and p["passer_athlete_id"]:
            r = bucket(p["passer_athlete_id"], "passer", p["possession_team_id"],
                       p["possession_team"], p["passer_name"])
            r["epa"] += p["epa"]
            r["opportunities"] += 1
            r["successes"] += p["success"] or 0
        if p["is_rush"] and p["rusher_athlete_id"]:
            r = bucket(p["rusher_athlete_id"], "rusher", p["possession_team_id"],
                       p["possession_team"], p["rusher_name"])
            r["epa"] += p["epa"]
            r["opportunities"] += 1
            r["successes"] += p["success"] or 0

    out = sorted(rows.values(), key=lambda r: (r["role"], r["athlete_id"]))
    assert_unique(out, ["event_id", "athlete_id", "role"], "CFB player-game")
    return out


def _check_reconciliation(payload):
    ctx = f"CFB {payload['event_id']}"
    total = sum(t["off_plays"] for t in payload["team_games"])
    if total != len(payload["plays"]):
        raise ValidationError(
            f"{ctx}: team play counts sum to {total} but {len(payload['plays'])} "
            "qualifying plays were emitted"
        )
    play_epa = sum(p["epa"] for p in payload["plays"])
    team_epa = sum(t["off_epa"] for t in payload["team_games"])
    if abs(play_epa - team_epa) > 1e-6:
        raise ValidationError(
            f"{ctx}: play EPA {play_epa!r} != summed team offensive EPA {team_epa!r}"
        )


def reconcile_with_game_json(src, event_id):
    """Compare the compiled Parquet against the per-game enriched final JSON.

    The plan lists that JSON as fallback candidate 1. This measures whether it
    is genuinely an alternative. Note the two are NOT schema-compatible: the
    Parquet flattens possession to `pos_team_id`, the JSON nests it as
    `start.pos_team.id`. Any switch between them is a code change, which is
    another reason a silent runtime fallback is not possible even if it were
    wanted.
    """
    url = CFB_GAME_JSON.format(game_id=event_id)
    doc = fetch_json(url)
    plays = doc.get("plays") or []
    status = (
        ((doc.get("header") or {}).get("competitions") or [{}])[0].get("status") or {}
    ).get("type") or {}

    agg = {}
    for p in plays:
        pos = as_id(p.get("start.pos_team.id"))
        if not (p.get("scrimmage_play") and p.get("EPA") is not None and pos and p.get("start.def_pos_team.id")):
            continue
        a = agg.setdefault(pos, {"epa": 0.0, "plays": 0, "pass_epa": 0.0, "pass_plays": 0, "rush_epa": 0.0, "rush_plays": 0})
        e = float(p["EPA"])
        a["epa"] += e
        a["plays"] += 1
        if p.get("pass"):
            a["pass_epa"] += e
            a["pass_plays"] += 1
        if p.get("rush"):
            a["rush_epa"] += e
            a["rush_plays"] += 1

    parquet = {
        t["team_id"]: {
            "epa": t["off_epa"],
            "plays": t["off_plays"],
            "pass_epa": t["off_pass_epa"],
            "pass_plays": t["off_pass_plays"],
            "rush_epa": t["off_rush_epa"],
            "rush_plays": t["off_rush_plays"],
        }
        for t in normalize_game(src, event_id, allow_incomplete=True)["team_games"]
    }

    diffs = []
    for tid in sorted(set(parquet) | set(agg)):
        a, b = parquet.get(tid), agg.get(tid)
        if a is None or b is None:
            diffs.append({"team_id": tid, "issue": "team present in only one source"})
            continue
        for k in a:
            if abs(a[k] - b[k]) > 1e-6:
                diffs.append({"team_id": tid, "field": k, "parquet": a[k], "game_json": b[k]})
    return {
        "event_id": as_id(event_id),
        "game_json_url": url,
        "game_json_status_state": status.get("state"),
        "game_json_status_completed": status.get("completed"),
        "game_json_status_detail": status.get("detail"),
        "game_json_total_plays": len(plays),
        "parquet_team_totals": parquet,
        "game_json_team_totals": agg,
        "differences": diffs,
        "agrees": not diffs,
    }
