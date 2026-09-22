"""Upstream asset locations and the availability/freshness probe.

Every URL the tool reads is declared here, once. The probe subcommand prints
exactly what exists, how big it is, and when it was last published, so a
source decision rests on an observation rather than on a document.
"""

from common import fetch_json, head, log

# --- NFL: nflverse ---------------------------------------------------------
#
# Processed play-by-play. nflverse republishes nightly after game days.
# Release: https://github.com/nflverse/nflverse-data/releases/tag/pbp
NFL_PBP = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.parquet"

# Schedules. Carries the `espn` column: the provider-supported join from an
# nflverse game_id to Fixtura's existing ESPN event id. This is why no game is
# ever matched on date + team names.
NFL_SCHEDULES = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet"
NFL_SCHEDULES_TIMESTAMP = "https://github.com/nflverse/nflverse-data/releases/download/schedules/timestamp.json"

# Player crosswalk. Carries gsis_id (the id used throughout pbp) and espn_id
# (the id Fixtura's player popup already uses).
NFL_PLAYERS = "https://github.com/nflverse/nflverse-data/releases/download/players/players.parquet"

NFL_RELEASE_API = "https://api.github.com/repos/nflverse/nflverse-data/releases/tags/{tag}"

# --- CFB: SportsDataverse / cfbfastR --------------------------------------
#
# ESPN-derived compiled play-by-play. game_id IS the ESPN event id and the
# player id columns ARE ESPN athlete ids, so college needs no crosswalk at all.
CFB_PBP = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_pbp/play_by_play_{season}.parquet"

# Machine-readable publication time for the whole espn_cfb_pbp release.
# This is the freshness gate a scheduled importer should read before working.
CFB_TIMESTAMP = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_pbp/timestamp.json"

# Fallback candidate 1 from the plan: the per-game enriched final JSON that the
# compiled release is built from.
CFB_GAME_JSON = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-raw/main/cfb/json/final/{game_id}.json"
CFB_GAME_RAW_JSON = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-raw/main/cfb/json/raw/{game_id}.json"

CFB_RELEASE_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/espn_cfb_pbp"

# --- ESPN: the coverage authority -----------------------------------------
#
# Fixtura's own coverage rule. The app already shows college football through
# groups=80, so analytics coverage is measured against the same surface.
ESPN_SCOREBOARD = (
    "https://site.api.espn.com/apis/site/v2/sports/football/{path}/scoreboard"
    "?seasontype={season_type}&week={week}&dates={season}&limit=400"
)
ESPN_CFB_GROUPS = "80"

LEAGUE_PATHS = {"nfl": "nfl", "cfb": "college-football"}


def release_assets(api_url):
    """Return {asset name: metadata} for a GitHub release tag."""
    doc = fetch_json(api_url)
    if "assets" not in doc:
        return {}
    return {
        a["name"]: {
            "size": a["size"],
            "updated_at": a["updated_at"],
            "download_count": a["download_count"],
        }
        for a in doc["assets"]
    }


def probe_nfl(seasons):
    out = {"league": "nfl", "source": "nflverse", "seasons": {}, "support": {}}
    assets = release_assets(NFL_RELEASE_API.format(tag="pbp"))
    for season in seasons:
        name = f"play_by_play_{season}.parquet"
        entry = dict(assets.get(name) or {})
        entry["asset"] = name
        entry["present_in_release"] = name in assets
        entry["url"] = NFL_PBP.format(season=season)
        entry["http"] = head(entry["url"])
        out["seasons"][str(season)] = entry
    for label, url in (
        ("schedules", NFL_SCHEDULES),
        ("players", NFL_PLAYERS),
    ):
        out["support"][label] = head(url)
    try:
        out["support"]["schedules_timestamp"] = fetch_json(NFL_SCHEDULES_TIMESTAMP)
    except Exception as exc:  # noqa: BLE001 - a probe reports, it does not fail
        out["support"]["schedules_timestamp"] = {"error": str(exc)}
    return out


def probe_cfb(seasons):
    out = {
        "league": "cfb",
        "source": "sportsdataverse/cfbfastR espn_cfb_pbp",
        "seasons": {},
        "support": {},
    }
    assets = release_assets(CFB_RELEASE_API)
    for season in seasons:
        name = f"play_by_play_{season}.parquet"
        entry = dict(assets.get(name) or {})
        entry["asset"] = name
        entry["present_in_release"] = name in assets
        entry["url"] = CFB_PBP.format(season=season)
        entry["http"] = head(entry["url"])
        out["seasons"][str(season)] = entry
    try:
        out["support"]["release_timestamp"] = fetch_json(CFB_TIMESTAMP)
    except Exception as exc:  # noqa: BLE001
        out["support"]["release_timestamp"] = {"error": str(exc)}
    out["support"]["per_game_json_example"] = CFB_GAME_JSON
    return out


def espn_finals(league, season, season_type, week):
    """Final ESPN events for one week, using Fixtura's own coverage rule.

    Returns (final_event_ids, all_event_ids). College adds groups=80 so the
    denominator is exactly the set of games the app already shows.
    """
    url = ESPN_SCOREBOARD.format(
        path=LEAGUE_PATHS[league], season_type=season_type, week=week, season=season
    )
    if league == "cfb":
        url += f"&groups={ESPN_CFB_GROUPS}"
    log(f"  ESPN coverage: {url}")
    doc = fetch_json(url)
    events = doc.get("events") or []
    finals = [
        e["id"]
        for e in events
        if ((e.get("status") or {}).get("type") or {}).get("state") == "post"
    ]
    return finals, [e["id"] for e in events]
