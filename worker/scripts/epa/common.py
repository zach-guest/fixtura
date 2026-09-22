"""Shared helpers for the offline EPA inspection tooling.

Deliberately stdlib + duckdb only. This tool is offline analysis; it is not
imported by the Worker or the frontend and adds no runtime dependency to
either (AGENTS.md, "Architecture and repository map").

Nothing here reads or prints a secret. The upstream assets are public and
unauthenticated, so the tool has no credential to leak; if one is ever added,
it must not be echoed into the report.
"""

import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request

# The crawler-form User-Agent verified against ESPN in hard-won detail 18.
# ESPN 403s a bare product token from a server-side client. This tool talks to
# ESPN only for coverage checks, but it uses the same string so there is one
# answer in the repository rather than two.
USER_AGENT = "Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)"

CACHE_DIR = os.environ.get(
    "EPA_CACHE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
)


class SourceUnavailable(Exception):
    """An upstream asset is not published (yet), or could not be fetched.

    Kept distinct from ValidationError because the two deserve opposite
    reactions. A season-scoped asset that 404s before the season publishes is
    the normal state of the world and must be a quiet, legible skip -- this is
    hard-won detail 28 arriving through a different door, where ESPN's
    scoreboard advanced to a season whose stat endpoints did not exist yet.
    A 5xx or a network failure is a real problem and still deserves to be
    loud, so `retryable` records which one this was.
    """

    def __init__(self, message, status=None, retryable=False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class ValidationError(Exception):
    """Raised when a payload fails a contract check.

    Every raise site is a deliberate refusal to emit. The tool fails loudly
    rather than emitting a plausible-looking payload, because a silent
    fallback is exactly what the plan forbids.
    """


def log(msg):
    """Progress goes to stderr so stdout stays a clean report/JSON stream."""
    print(msg, file=sys.stderr)


def fetch(url, dest=None, force=False):
    """Download `url` to the cache and return (path, http_meta).

    Caches by filename so repeated runs are cheap and deterministic. The
    returned metadata carries the upstream freshness signals the plan requires
    to be recorded: ETag, Last-Modified, and byte length.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    # Namespaced by a hash of the whole URL, not just the basename. nflverse
    # and SportsDataverse both publish a file called
    # play_by_play_2025.parquet; caching by basename would silently serve one
    # league's season file to the other adapter.
    stem = url.rsplit("/", 1)[-1]
    tag = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
    path = dest or os.path.join(CACHE_DIR, f"{tag}_{stem}")
    meta_path = path + ".meta.json"

    if os.path.exists(path) and os.path.exists(meta_path) and not force:
        with open(meta_path) as fh:
            return path, json.load(fh)

    log(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            headers = resp.headers
            body = resp.read()
            meta = {
                "url": url,
                "http_status": resp.status,
                "etag": headers.get("ETag"),
                "last_modified": headers.get("Last-Modified"),
                "content_length": len(body),
            }
    except urllib.error.HTTPError as exc:
        if 400 <= exc.code < 500:
            raise SourceUnavailable(
                f"{url} is not published ({exc.code} {exc.reason}). For a "
                "season-scoped asset before that season publishes this is "
                "expected, and a scheduled importer must skip rather than fail.",
                status=exc.code,
                retryable=False,
            )
        raise SourceUnavailable(
            f"{url} failed with {exc.code} {exc.reason}", status=exc.code, retryable=True
        )
    except urllib.error.URLError as exc:
        raise SourceUnavailable(f"{url} unreachable: {exc.reason}", retryable=True)
    with open(path, "wb") as fh:
        fh.write(body)
    meta["sha256"] = sha256_file(path)
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True)
    return path, meta


def fetch_json(url):
    """GET a JSON document, with the same typed failures as fetch().

    Used for ESPN coverage checks, GitHub release probes (unauthenticated, so
    rate-limited at 60/hour) and the CFB per-game JSON. All three can fail for
    ordinary reasons, and none of them should produce a raw traceback.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        retryable = exc.code >= 500 or exc.code in (403, 429)
        raise SourceUnavailable(
            f"{url} returned {exc.code} {exc.reason}"
            + (" (GitHub's unauthenticated API allows 60 requests/hour)" if exc.code in (403, 429) else ""),
            status=exc.code,
            retryable=retryable,
        )
    except urllib.error.URLError as exc:
        raise SourceUnavailable(f"{url} unreachable: {exc.reason}", retryable=True)
    except json.JSONDecodeError as exc:
        raise SourceUnavailable(f"{url} did not return JSON: {exc}", retryable=True)


def head(url):
    """HEAD a release asset to record availability without downloading it."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    req.get_method = lambda: "HEAD"
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return {
                "url": url,
                "http_status": resp.status,
                "etag": resp.headers.get("ETag"),
                "last_modified": resp.headers.get("Last-Modified"),
                "content_length": resp.headers.get("Content-Length"),
            }
    except urllib.error.HTTPError as exc:
        return {"url": url, "http_status": exc.code, "error": exc.reason}
    except urllib.error.URLError as exc:
        return {"url": url, "http_status": None, "error": str(exc.reason)}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(obj):
    """Deterministic serialization.

    Sorted keys and fixed separators, so the same inputs always hash to the
    same content hash. The importer's "skip unchanged games" behaviour depends
    on this being stable across machines and runs.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# Fields that describe WHEN we fetched rather than WHAT the game was. They are
# kept in the payload but excluded from the content hash, because the hash
# answers "has this game's data changed?" -- the question a scheduled importer
# asks to skip unchanged games. Folding a live release timestamp into it made
# the hash change whenever upstream republished anything, even when every play
# was byte-identical, which defeats the only purpose the hash has.
VOLATILE_SOURCE_FIELDS = (
    "release_timestamp",
    "pbp_etag",
    "pbp_last_modified",
    "schedules_last_modified",
    "players_last_modified",
)


def data_core(payload):
    """The part of a payload whose change means the game's data changed."""
    core = {k: v for k, v in payload.items() if k not in ("content_hash", "source", "census")}
    src = payload.get("source") or {}
    core["source"] = {k: v for k, v in src.items() if k not in VOLATILE_SOURCE_FIELDS}
    return core


def content_hash(obj):
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def finite(value, field, context):
    """Return a float, or raise. `None` is allowed and passes through.

    Missing is not zero (AGENTS.md). A null stays null; only a value that is
    present and not finite is an error.
    """
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{context}: {field} is not numeric: {value!r}")
    if not math.isfinite(out):
        raise ValidationError(f"{context}: {field} is not finite: {value!r}")
    return out


def required_finite(value, field, context):
    out = finite(value, field, context)
    if out is None:
        raise ValidationError(f"{context}: {field} is required and missing")
    return out


def as_id(value):
    """Normalize an identifier to a string, or None.

    Every ID this tool emits is a string. CFB play IDs are the reason: the
    largest observed 2026 play id is 401858212104999901, which is far beyond
    JavaScript's safe integer range (2**53 - 1 = 9007199254740991). Emitting it
    as a JSON number would silently round it in the Worker and in the browser.
    NFL ids are small enough not to need this, but they are stringified too so
    there is one rule rather than a per-league exception to remember.
    """
    if value is None:
        return None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        if value.is_integer():
            return str(int(value))
        return str(value)
    text = str(value).strip()
    return text or None


def assert_unique(rows, key_fields, what):
    """Fail on duplicate composite keys before anything is emitted."""
    seen = {}
    for row in rows:
        key = tuple(row.get(f) for f in key_fields)
        if key in seen:
            raise ValidationError(
                f"duplicate {what} key {key!r} (fields {key_fields})"
            )
        seen[key] = True


def write_json(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")
    return path


def rule(title):
    print()
    print(title)
    print("-" * len(title))
