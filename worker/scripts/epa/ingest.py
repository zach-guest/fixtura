#!/usr/bin/env python3
"""Scheduled EPA ingestion: build payloads, upload them, report coverage.

Phase 3. This is the shipping runner; `epa_inspect.py` remains the inspection
tool. It reads the same public upstreams, normalizes through the same
league-specific adapters, and POSTs bounded batches to the Worker's private
import route.

    # what would be sent, without sending anything
    ./.venv/bin/python ingest.py --league nfl --season 2025 --mode week --week 1 --dry-run

    # one game, against a local worker
    ./.venv/bin/python ingest.py --league cfb --season 2026 --mode game \
        --game 401858422 --target http://127.0.0.1:8787 --token-env EPA_IMPORT_TOKEN

    # a whole archived season
    ./.venv/bin/python ingest.py --league nfl --season 2025 --mode season --dry-run

Safety properties, in order of how much they matter:

  * `--dry-run` performs no network write of any kind. It is the default when
    no `--target` is given, so a mistyped command cannot post somewhere.
  * The token is read from an environment variable, never a flag, so it cannot
    land in a shell history or a process listing. It is never logged, and the
    report never contains it.
  * A 4xx is not retried (except 429): a rejected payload is a contract
    failure, and hammering the Worker with it helps nobody.
  * Determinism: with a fixed source asset, two dry runs produce byte-identical
    payloads and byte-identical reports apart from timings. There is a test.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cfb  # noqa: E402
import nfl  # noqa: E402
from common import SourceUnavailable, ValidationError, canonical_json, log  # noqa: E402
from sources import espn_finals  # noqa: E402

REPORT_VERSION = 1

# The Worker caps a request at 40 games and 4 MB. Staying well under both keeps
# one oversized college game from tipping a batch over the body limit, and
# keeps a single failure from taking 40 games down with it.
DEFAULT_BATCH_GAMES = 8
DEFAULT_BATCH_BYTES = 2 * 1024 * 1024

RETRY_STATUSES = {429, 500, 502, 503, 504}
DEFAULT_RETRIES = 4


class Uploader:
    """POSTs batches to the Worker, with bounded retries.

    Deliberately not a general HTTP client: it knows one route, one auth
    scheme, and one retry policy, all of which are part of the contract rather
    than configuration.
    """

    def __init__(self, target, token, retries=DEFAULT_RETRIES, sleep=time.sleep):
        self.target = target.rstrip('/')
        self.token = token
        self.retries = retries
        self.sleep = sleep

    def post(self, league, games, dry_run_param=False):
        url = f'{self.target}/epa/import/{league}' + ('?dryRun=1' if dry_run_param else '')
        body = json.dumps({'games': games}).encode('utf-8')
        headers = {
            'Content-Type': 'application/json',
            # Never logged, never echoed into the report.
            'Authorization': f'Bearer {self.token}',
            'User-Agent': 'Fixtura-EPA-Ingest/1.0 (+https://zach-guest.github.io/fixtura/)',
        }
        attempt = 0
        while True:
            attempt += 1
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method='POST')
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return {'http_status': resp.status, 'body': json.loads(resp.read().decode('utf-8')),
                            'attempts': attempt}
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode('utf-8', 'replace')[:2000]
                try:
                    parsed = json.loads(detail)
                except Exception:  # noqa: BLE001
                    parsed = {'error': detail}
                # 207 is a partial success and is reported, not retried.
                if exc.code == 207:
                    return {'http_status': 207, 'body': parsed, 'attempts': attempt}
                if exc.code not in RETRY_STATUSES or attempt > self.retries:
                    return {'http_status': exc.code, 'body': parsed, 'attempts': attempt,
                            'retryable': exc.code in RETRY_STATUSES}
                self._backoff(attempt, f'HTTP {exc.code}')
            except urllib.error.URLError as exc:
                if attempt > self.retries:
                    return {'http_status': None, 'body': {'error': f'unreachable: {exc.reason}'},
                            'attempts': attempt, 'retryable': True}
                self._backoff(attempt, f'network: {exc.reason}')

    def _backoff(self, attempt, why):
        delay = min(2 ** (attempt - 1), 30)
        log(f'  retry {attempt}/{self.retries} in {delay}s ({why})')
        self.sleep(delay)


def batches(payloads, max_games, max_bytes):
    """Chunk by BOTH count and serialized size.

    A college game is roughly 100 KB, so 40 of them would sit on the Worker's
    4 MB body limit. Bounding bytes as well means an unusually long game cannot
    push a batch over it.
    """
    batch, size = [], 0
    for p in payloads:
        n = len(canonical_json(p))
        if batch and (len(batch) >= max_games or size + n > max_bytes):
            yield batch
            batch, size = [], 0
        batch.append(p)
        size += n
    if batch:
        yield batch


# --------------------------------------------------------------- discovery --

def discover_nfl(src, season, mode, week, games):
    """Which nflverse games this run should consider."""
    if mode == 'game':
        return list(games)
    where = "season_type = 'REG'"
    params = [season]
    sql = f"""SELECT game_id FROM read_parquet('{src.pbp_path}')
               WHERE season = ? AND {where}"""
    if mode == 'week':
        sql += ' AND week = ?'
        params.append(week)
    sql += ' GROUP BY game_id ORDER BY game_id'
    return [r[0] for r in src.q(sql, params)]


def discover_cfb(src, season, mode, week, games):
    if mode == 'game':
        return list(games)
    sql = f"""SELECT DISTINCT game_id FROM read_parquet('{src.pbp_path}')
               WHERE season = ? AND {cfb.COMPLETENESS_GATE}"""
    params = [season]
    if mode == 'week':
        sql += ' AND week = ?'
        params.append(week)
    sql += ' ORDER BY game_id'
    return [str(r[0]) for r in src.q(sql, params)]


def cfb_recheck_weeks(src, season, recheck_weeks):
    """Weeks to revisit for games that were truncated or absent upstream.

    **The window is deliberately not fixed.** Whether a truncated college game
    heals, and how fast, has not been measured (see DECISIONS.md and handoff
    §26): week-1 2026 games were still truncated three to eleven days later,
    and the source had not republished when re-checked. Guessing "the previous
    two weeks" would silently stop retrying games that heal on day twelve.

    With no `--recheck-weeks`, every week of the season that still has an
    incomplete game is revisited. That is bounded by the season and is the
    conservative choice while the behaviour is unknown. Passing a number caps
    it to the most recent N weeks once someone has measured the answer.
    """
    rows = src.q(
        f"""SELECT week, count(*) FILTER (WHERE {cfb.COMPLETENESS_GATE}) AS complete,
                   count(*) AS total
              FROM (SELECT DISTINCT game_id, week, status_type_completed
                      FROM read_parquet('{src.pbp_path}') WHERE season = ?)
             GROUP BY week ORDER BY week""",
        [season],
    )
    incomplete = [int(w) for w, complete, total in rows if complete < total]
    if recheck_weeks is None:
        return incomplete, 'all-incomplete-weeks (healing behaviour unmeasured)'
    capped = sorted(incomplete)[-recheck_weeks:] if recheck_weeks > 0 else []
    return capped, f'last-{recheck_weeks}-incomplete-weeks (operator override)'


# ------------------------------------------------------------------- build --

def build(league, src, ids, allow_incomplete=False):
    """Normalize each game, collecting failures rather than aborting the run."""
    payloads, failures = [], []
    for token in ids:
        try:
            if league == 'nfl':
                payloads.append(nfl.normalize_game(src, token))
            else:
                payloads.append(cfb.normalize_game(src, token, allow_incomplete=allow_incomplete))
        except ValidationError as exc:
            failures.append({'game': str(token), 'stage': 'normalize', 'error': str(exc)})
    # Stable order regardless of discovery order, so two runs agree.
    payloads.sort(key=lambda p: p['event_id'])
    failures.sort(key=lambda f: f['game'])
    return payloads, failures


# ------------------------------------------------------------------- main --

def run(args):
    league = args.league
    dry_run = args.dry_run or not args.target

    token = None
    if not dry_run:
        token = os.environ.get(args.token_env)
        if not token:
            log(f'{args.token_env} is not set; refusing to upload. '
                f'Export it, or use --dry-run.')
            return 2

    if league == 'nfl':
        src = nfl.NflSource(args.season, force=args.force)
        ids = discover_nfl(src, args.season, args.mode, args.week, args.game or [])
        recheck = None
    else:
        src = cfb.CfbSource(args.season, force=args.force)
        ids = discover_cfb(src, args.season, args.mode, args.week, args.game or [])
        recheck = None
        if args.mode == 'season':
            weeks, policy = cfb_recheck_weeks(src, args.season, args.recheck_weeks)
            recheck = {'weeks': weeks, 'policy': policy}

    log(f'{league}: {len(ids)} game(s) to normalize (mode={args.mode}, dry_run={dry_run})')
    payloads, failures = build(league, src, ids, allow_incomplete=False)
    log(f'{league}: {len(payloads)} normalized, {len(failures)} rejected before upload')

    results, http = [], []
    if payloads and not dry_run:
        up = Uploader(args.target, token, retries=args.retries)
        for i, chunk in enumerate(batches(payloads, args.batch_games, args.batch_bytes), start=1):
            log(f'  batch {i}: {len(chunk)} game(s)')
            out = up.post(league, chunk, dry_run_param=args.server_dry_run)
            http.append({'batch': i, 'games': len(chunk), 'http_status': out['http_status'],
                         'attempts': out['attempts']})
            body = out.get('body') or {}
            results.extend(body.get('results') or [])
            if out['http_status'] not in (200, 207):
                failures.append({'game': None, 'stage': 'upload', 'batch': i,
                                 'error': json.dumps(body)[:500]})

    report = {
        'report_version': REPORT_VERSION,
        'league': league,
        'season': args.season,
        'mode': args.mode,
        'week': args.week,
        'dry_run': dry_run,
        'source': {
            'url': src.pbp_meta['url'],
            'sha256': src.pbp_meta['sha256'],
            'last_modified': src.pbp_meta.get('last_modified'),
            **({'release_timestamp': src.release_timestamp} if league == 'cfb' else {}),
        },
        'discovered': len(ids),
        'normalized': len(payloads),
        'rejected': len(failures),
        'games': [
            {
                'event_id': p['event_id'],
                'week': p['week'],
                'plays': len(p['plays']),
                'drives': len(p.get('drives') or []),
                'content_hash': p['content_hash'],
                'coverage': p.get('coverage'),
            }
            for p in payloads
        ],
        'failures': failures,
        'upload': {'batches': http, 'results': results},
        **({'cfb_recheck': recheck} if recheck else {}),
    }

    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, 'w') as fh:
            json.dump(report, fh, indent=2, sort_keys=True)
            fh.write('\n')
        log(f'wrote {args.report}')

    if args.payload_dir:
        os.makedirs(args.payload_dir, exist_ok=True)
        for p in payloads:
            path = os.path.join(args.payload_dir, f"{league}_{args.season}_{p['event_id']}.json")
            with open(path, 'w') as fh:
                json.dump(p, fh, indent=2, sort_keys=True)
                fh.write('\n')
        log(f'wrote {len(payloads)} payload(s) to {args.payload_dir}')

    print(json.dumps({k: report[k] for k in
                      ('league', 'season', 'mode', 'dry_run', 'discovered', 'normalized', 'rejected')},
                     sort_keys=True))

    # Exit codes are the workflow's signal, so they distinguish causes:
    #   0 everything normalized (and uploaded, if not a dry run)
    #   1 at least one game failed to normalize or upload
    #   3 nothing to do -- an empty discovery is not an error by itself
    if failures:
        return 1
    if not payloads:
        log('nothing to ingest')
        return 3
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--league', choices=('nfl', 'cfb'), required=True)
    ap.add_argument('--season', type=int, required=True)
    ap.add_argument('--mode', choices=('season', 'week', 'game'), default='season')
    ap.add_argument('--week', type=int)
    ap.add_argument('--game', action='append',
                    help='NFL: nflverse game_id or ESPN event id. CFB: ESPN event id.')
    ap.add_argument('--target', help='Worker base URL. Omitted means dry run.')
    ap.add_argument('--token-env', default='EPA_IMPORT_TOKEN',
                    help='Environment variable holding the import token. Never a flag.')
    ap.add_argument('--dry-run', action='store_true', help='normalize and report, upload nothing')
    ap.add_argument('--server-dry-run', action='store_true',
                    help='upload with ?dryRun=1 so the Worker validates without storing')
    ap.add_argument('--recheck-weeks', type=int, default=None,
                    help='CFB season mode: cap the truncated-game recheck to the last N '
                         'incomplete weeks. Unset means every incomplete week, which is '
                         'correct while the upstream healing behaviour is unmeasured.')
    ap.add_argument('--batch-games', type=int, default=DEFAULT_BATCH_GAMES)
    ap.add_argument('--batch-bytes', type=int, default=DEFAULT_BATCH_BYTES)
    ap.add_argument('--retries', type=int, default=DEFAULT_RETRIES)
    ap.add_argument('--report', help='write a JSON coverage report here')
    ap.add_argument('--payload-dir', help='also write each normalized payload as JSON')
    ap.add_argument('--force', action='store_true', help='re-download cached source assets')
    args = ap.parse_args()

    if args.mode == 'week' and args.week is None:
        ap.error('--mode week needs --week')
    if args.mode == 'game' and not args.game:
        ap.error('--mode game needs at least one --game')

    try:
        return run(args)
    except SourceUnavailable as exc:
        # A season asset that is not published yet is not a failure; it is the
        # normal state of the world before a season starts.
        log(f'SOURCE UNAVAILABLE: {exc}')
        return 3 if exc.retryable else 0
    except ValidationError as exc:
        log(f'FAILED: {exc}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
