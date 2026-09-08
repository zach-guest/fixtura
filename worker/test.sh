#!/usr/bin/env bash
#
# Integration tests for the Fixtura worker, run against a local `wrangler dev`.
#
#   Terminal 1:  npm run dev
#   Terminal 2:  ./test.sh
#
# These go over real HTTP rather than calling handlers directly, because what
# is most worth checking here is HTTP-level: which responses are cacheable,
# which must never be, and what CORS headers come back. A unit test of a
# handler function cannot see any of that.
#
# The authenticated half seeds a user and session straight into the LOCAL D1 —
# what a real Google login would have written. It wipes users, sessions and
# settings there first, so never point this at --remote.
#
# The proxy tests call ESPN for real on purpose: the exact User-Agent upstream
# will accept is itself something that can regress. See proxy.js.

set -u
cd "$(dirname "$0")"

B=${B:-http://localhost:8787}
APP=https://zach-guest.github.io
WRANGLER=node_modules/.bin/wrangler
pass=0; fail=0
T=$(mktemp -d)
# KEEP=1 ./test.sh leaves the responses on disk. Worth it: a bare status code
# tells you a test failed, not why.
[ -n "${KEEP:-}" ] && echo "responses kept in $T" || trap 'rm -rf "$T"' EXIT

chk(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-50s %s\n' "$1" "$3"
       else fail=$((fail+1)); printf '  FAIL %-50s want=%s got=%s\n' "$1" "$2" "$3"; fi; }
hdr(){ grep -i "^$2:" "$1" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
code(){ head -1 "$1" | awk '{print $2}'; }
# Accepts either a subscript chain applied to the document ("['pool']['id']")
# or a full expression that uses `d` itself ("len(d['games'])").
jq_(){ F="$1" EXPR="$2" python3 -c 'import json,os
d=json.load(open(os.environ["F"]))
e=os.environ["EXPR"]
print(eval(("d"+e) if e.startswith("[") else e))' 2>/dev/null; }
qs(){ L="$1" K="$2" python3 -c 'import os,urllib.parse as u;print(u.parse_qs(u.urlparse(os.environ["L"]).query)[os.environ["K"]][0])'; }

if ! curl -sf -o /dev/null "$B/health"; then
  echo "no worker on $B — start it with: npm run dev"; exit 1
fi

echo "== health =="
curl -s -D $T/h -o $T/hb "$B/health" -H "Origin: $APP"
chk "status" 200 "$(code $T/h)"
chk "no-store" "no-store, private" "$(hdr $T/h cache-control)"
chk "allow-origin" "$APP" "$(hdr $T/h access-control-allow-origin)"
chk "d1 reachable" "ok" "$(jq_ $T/hb "['db']")"
chk "config complete" "[]" "$(jq_ $T/hb "['missing_config']")"

echo "== proxy lane is public and cached =="
curl -s -D $T/p1 -o /dev/null "$B/espn/football/nfl/scoreboard" -H "Origin: $APP"
chk "status" 200 "$(code $T/p1)"
chk "cache-control" "public, max-age=30" "$(hdr $T/p1 cache-control)"
case "$(hdr $T/p1 x-fixtura-cache)" in MISS|HIT) chk "cache verdict reported" ok ok;; *) chk "cache verdict reported" ok "none";; esac
curl -s -D $T/p2 -o /dev/null "$B/espn/football/nfl/scoreboard" -H "Origin: $APP"
chk "second call hits" "HIT" "$(hdr $T/p2 x-fixtura-cache)"
chk "vary on origin" "Origin" "$(hdr $T/p2 vary)"

echo "== a cache entry cannot leak across origins =="
curl -s -D $T/p3 -o /dev/null "$B/espn/football/nfl/scoreboard" -H "Origin: https://evil.example"
chk "unknown origin gets no ACAO" "" "$(hdr $T/p3 access-control-allow-origin)"
chk "  but is still answered" 200 "$(code $T/p3)"
curl -s -D $T/p4 -o /dev/null "$B/espn/football/nfl/scoreboard" -H "Origin: http://localhost:8123"
chk "hit is re-stamped per origin" "http://localhost:8123" "$(hdr $T/p4 access-control-allow-origin)"

echo "== methods =="
curl -s -D $T/m1 -o /dev/null -X POST "$B/espn/football/nfl/scoreboard" -H "Origin: $APP"
chk "POST to the proxy" 405 "$(code $T/m1)"
curl -s -D $T/m2 -o /dev/null -X OPTIONS "$B/me" -H "Origin: $APP"
chk "preflight" 204 "$(code $T/m2)"
chk "  methods" "GET,POST,PUT,PATCH,DELETE,OPTIONS" "$(hdr $T/m2 access-control-allow-methods)"
chk "  headers" "Content-Type,Authorization" "$(hdr $T/m2 access-control-allow-headers)"

echo "== private lane, unauthenticated =="
for p in me me/settings; do
  curl -s -D $T/u -o /dev/null "$B/$p" -H "Origin: $APP"
  chk "GET /$p" 401 "$(code $T/u)"
  chk "  no-store" "no-store, private" "$(hdr $T/u cache-control)"
  chk "  vary" "Origin, Authorization" "$(hdr $T/u vary)"
done
curl -s -D $T/u2 -o /dev/null "$B/me" -H "Origin: $APP" -H "Authorization: Bearer made-up"
chk "invented bearer token" 401 "$(code $T/u2)"
curl -s -D $T/c1 -o /dev/null "$B/me" -H "Origin: $APP"
chk "private responses never carry a cache verdict" "" "$(hdr $T/c1 x-fixtura-cache)"

echo "== oauth: the redirect out =="
curl -s -D $T/o1 -o /dev/null "$B/auth/google/start?return=$APP/fixtura/" -H "Origin: $APP"
chk "start redirects" 302 "$(code $T/o1)"
LOC="$(hdr $T/o1 location)"
case "$LOC" in https://accounts.google.com/o/oauth2/v2/auth*) chk "  to google" ok ok;; *) chk "  to google" ok "$LOC";; esac
chk "  no-store" "no-store, private" "$(hdr $T/o1 cache-control)"
chk "  scope" "openid email profile" "$(qs "$LOC" scope)"
chk "  redirect_uri tracks the host" "$B/auth/google/callback" "$(qs "$LOC" redirect_uri)"
STATE="$(qs "$LOC" state)"
chk "  state present" "yes" "$([ -n "$STATE" ] && echo yes || echo no)"

echo "== oauth: the callback rejects what it should =="
curl -s -D $T/o2 -o $T/o2b "$B/auth/google/callback?code=x&state=${STATE}TAMPER" -H "Origin: $APP"
chk "unparseable state" 400 "$(code $T/o2)"
chk "  says why" "malformed state" "$(jq_ $T/o2b "['error']")"
FORGED=$(S="$STATE" python3 -c 'import os,base64;b=os.environ["S"].split(".")[0];print(b+"."+base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))')
curl -s -D $T/o3 -o $T/o3b "$B/auth/google/callback?code=x&state=$FORGED" -H "Origin: $APP"
chk "forged signature" 400 "$(code $T/o3)"
chk "  says why" "state signature does not verify" "$(jq_ $T/o3b "['error']")"
curl -s -D $T/o4 -o /dev/null "$B/auth/google/callback?code=x" -H "Origin: $APP"
chk "no code at all" 400 "$(code $T/o4)"
curl -s -D $T/o5 -o $T/o5b "$B/auth/google/callback?code=bogus&state=$STATE" -H "Origin: $APP"
chk "good state, bad code" 502 "$(code $T/o5)"
chk "  blames google, not us" "google token exchange failed" "$(jq_ $T/o5b "['error']")"

echo "== oauth: no open redirect =="
curl -s -D $T/r1 -o /dev/null "$B/auth/google/start?return=https://evil.example/steal" -H "Origin: $APP"
RSTATE="$(qs "$(hdr $T/r1 location)" state)"
RET=$(S="$RSTATE" python3 -c 'import os,base64,json;b=os.environ["S"].split(".")[0];b+="="*((4-len(b)%4)%4);print(json.loads(base64.urlsafe_b64decode(b))["r"])')
chk "off-origin return url refused" "$APP/fixtura/" "$RET"

echo "== routing =="
curl -s -D $T/n1 -o $T/n1b "$B/picks/1" -H "Origin: $APP"
chk "reserved private prefix" 404 "$(code $T/n1)"
chk "  named as unbuilt" "picks is not built yet" "$(jq_ $T/n1b "['error']")"
chk "  still no-store" "no-store, private" "$(hdr $T/n1 cache-control)"
curl -s -D $T/n2 -o /dev/null "$B/nonsense" -H "Origin: $APP"
chk "unknown route" 404 "$(code $T/n2)"
curl -s -D $T/n3 -o /dev/null "$B/score/anything" -H "Origin: $APP"
chk "the removed thescore route" 404 "$(code $T/n3)"
curl -s -D $T/n4 -o $T/n4b "$B/odds/sports" -H "Origin: $APP"
chk "keyed route with no key" 500 "$(code $T/n4)"
chk "  names the missing secret" "ODDS_API_KEY is not configured on the worker" "$(jq_ $T/n4b "['error']")"
chk "  carries a request id" "yes" "$([ -n "$(hdr $T/n4 x-fixtura-request-id)" ] && echo yes || echo no)"

echo "== trends: public lane, D1-backed =="
# Seeded directly rather than by running the cron: the cron only writes when
# ESPN says a regular season is under way, so a test that waited for it would
# pass or fail depending on the month.
$WRANGLER d1 execute fixtura --local --command \
  "DELETE FROM stat_snapshots WHERE season = 2099;
   INSERT OR REPLACE INTO stat_snapshots
     (league,season,week,category,rank,athlete_id,team_id,value,display_value,captured_at)
   VALUES ('nfl',2099,2,'passingYards',1,'101','14',900,'900',1700000000),
          ('nfl',2099,2,'passingYards',2,'102','12',800,'800',1700000000),
          ('nfl',2099,3,'passingYards',1,'102','12',1200,'1200',1700600000),
          ('nfl',2099,3,'passingYards',2,'101','14',1100,'1100',1700600000),
          ('nfl',2099,3,'sacks',1,'103','2',9,'9.0',1700600000);" >/dev/null 2>&1

curl -s -D $T/t1 -o $T/t1b "$B/trends/leaders?season=2099" -H "Origin: $APP"
chk "status" 200 "$(code $T/t1)"
chk "cacheable, unlike the private lane" "public, max-age=900" "$(hdr $T/t1 cache-control)"
chk "allow-origin" "$APP" "$(hdr $T/t1 access-control-allow-origin)"
chk "newest week first" 3 "$(jq_ $T/t1b "d['snapshots'][0]['week']")"
chk "two weeks by default" 2 "$(jq_ $T/t1b "len(d['snapshots'])")"
chk "ranks come back ordered" "['102', '101']" "$(jq_ $T/t1b "list(l['athlete_id'] for l in d['snapshots'][0]['categories']['passingYards'])")"
chk "categories are grouped" 2 "$(jq_ $T/t1b "len(d['snapshots'][0]['categories'])")"
chk "movement is derivable" True "$(jq_ $T/t1b "d['snapshots'][0]['categories']['passingYards'][0]['athlete_id'] != d['snapshots'][1]['categories']['passingYards'][0]['athlete_id']")"

curl -s -o $T/t2b "$B/trends/leaders?season=2099&weeks=1" -H "Origin: $APP"
chk "weeks= is honoured" 1 "$(jq_ $T/t2b "len(d['snapshots'])")"
curl -s -o $T/t3b "$B/trends/leaders?season=2100" -H "Origin: $APP"
chk "no history is an empty list, not an error" "[]" "$(jq_ $T/t3b "d['snapshots']")"

curl -s -D $T/t4 -o /dev/null "$B/trends/leaders" -H "Origin: $APP"
chk "season is required" 400 "$(code $T/t4)"
curl -s -D $T/t5 -o /dev/null "$B/trends/leaders?season=abc" -H "Origin: $APP"
chk "season must be a year" 400 "$(code $T/t5)"
curl -s -D $T/t6 -o /dev/null "$B/trends/nonsense?season=2099" -H "Origin: $APP"
chk "unknown trends resource" 400 "$(code $T/t6)"
curl -s -D $T/t7 -o /dev/null -X POST "$B/trends/leaders?season=2099" -H "Origin: $APP"
chk "GET only" 400 "$(code $T/t7)"
curl -s -D $T/t8 -o /dev/null "$B/trends/leaders?season=2099" -H "Origin: https://evil.example"
chk "unknown origin gets no ACAO" "" "$(hdr $T/t8 access-control-allow-origin)"

# --------------------------------------------------------------------------
# Authenticated. Seeds the local D1 the way a completed Google login would.
# --------------------------------------------------------------------------
# Seed everything in ONE pass, before any authenticated request.
#
# This matters: `wrangler d1 execute --local` writes to the same SQLite file the
# running `wrangler dev` holds open, and a write issued *between* HTTP calls is
# not reliably visible to the worker straight away. Seeding mid-run produced
# tests that passed or 401'd depending on timing. Seed once, then wait until the
# worker can actually see it.
h(){ printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
mktok(){ openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
TOKEN=$(mktok)        # user A, spent by the logout test
TOKEN_A=$(mktok)      # user A, for pick'em
TOKEN_B=$(mktok)      # user B
TOKEN_X=$(mktok)      # user A, seeded already-expired
NOW=$(date +%s); EXP=$((NOW + 2592000))
$WRANGLER d1 execute fixtura --local --command \
"DELETE FROM results; DELETE FROM picks; DELETE FROM pool_members; DELETE FROM pools;
 DELETE FROM sessions; DELETE FROM settings; DELETE FROM users;
 INSERT INTO users (provider,sub,email,name,picture,role,created_at,last_seen)
 VALUES ('google','test-sub-1','zach@example.com','Zach Guest',NULL,'admin',$NOW,$NOW);
 INSERT INTO users (provider,sub,email,name,picture,role,created_at,last_seen)
 VALUES ('google','test-sub-2','friend@example.com','Friend B',NULL,'user',$NOW,$NOW);
 INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$(h "$TOKEN")',  (SELECT id FROM users WHERE sub='test-sub-1'),$NOW,$EXP,'test.sh');
 INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$(h "$TOKEN_A")',(SELECT id FROM users WHERE sub='test-sub-1'),$NOW,$EXP,'test.sh');
 INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$(h "$TOKEN_B")',(SELECT id FROM users WHERE sub='test-sub-2'),$NOW,$EXP,'test.sh');
 INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$(h "$TOKEN_X")',(SELECT id FROM users WHERE sub='test-sub-1'),$NOW,$((NOW-10)),'expired');" > $T/seed.log 2>&1 \
  || { echo "SEED FAILED — the rest of this run is meaningless:"; tail -20 $T/seed.log; exit 1; }
A="Authorization: Bearer $TOKEN"
A2="Authorization: Bearer $TOKEN_A"
B_AUTH="Authorization: Bearer $TOKEN_B"
# Wait for the worker to see the seed rather than assuming it does.
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/me" -H "$A2")" = "200" ] && break
  sleep 1
done

echo "== signed in =="
curl -s -D $T/a1 -o $T/a1b "$B/me" -H "Origin: $APP" -H "$A"
chk "GET /me" 200 "$(code $T/a1)"
chk "  name" "Zach Guest" "$(jq_ $T/a1b "['user']['name']")"
chk "  role" "admin" "$(jq_ $T/a1b "['user']['role']")"
chk "  never echoes a token" "False" "$(python3 -c "print('token' in open('$T/a1b').read())")"
chk "  no-store" "no-store, private" "$(hdr $T/a1 cache-control)"

echo "== settings sync =="
curl -s -o $T/s0b "$B/me/settings" -H "Origin: $APP" -H "$A"
chk "starts empty" "{}" "$(jq_ $T/s0b "['settings']")"
curl -s -D $T/s1 -o $T/s1b -X PUT "$B/me/settings" -H "Origin: $APP" -H "$A" \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"sb-favs":"[\"nfl:12\",\"nfl:25\"]","sb-theme":"midnight"}}'
chk "PUT" 200 "$(code $T/s1)"
chk "  reports what it saved" "['sb-favs', 'sb-theme']" "$(jq_ $T/s1b "['saved']")"
curl -s -o $T/s2b "$B/me/settings" -H "Origin: $APP" -H "$A"
chk "reads back a scalar" "midnight" "$(jq_ $T/s2b "['settings']['sb-theme']['value']")"
chk "reads back JSON verbatim" '["nfl:12","nfl:25"]' "$(jq_ $T/s2b "['settings']['sb-favs']['value']")"
chk "stamps updated_at" "True" "$(jq_ $T/s2b "['settings']['sb-theme']['updated_at'] > 1700000000")"
curl -s -o /dev/null -X PUT "$B/me/settings" -H "Origin: $APP" -H "$A" \
  -H 'Content-Type: application/json' -d '{"settings":{"sb-theme":"terminal"}}'
curl -s -o $T/s4b "$B/me/settings" -H "Origin: $APP" -H "$A"
chk "upsert overwrites one key" "terminal" "$(jq_ $T/s4b "['settings']['sb-theme']['value']")"
chk "  and leaves the others" '["nfl:12","nfl:25"]' "$(jq_ $T/s4b "['settings']['sb-favs']['value']")"

echo "== settings validation =="
v(){ curl -s -D $T/v -o /dev/null -X PUT "$B/me/settings" -H "Origin: $APP" -H "$A" \
       -H 'Content-Type: application/json' -d "$2"; chk "$1" 400 "$(code $T/v)"; }
v "a key outside the sb- namespace"  '{"settings":{"evil":"x"}}'
v "a path-shaped key"                '{"settings":{"sb-../../etc":"x"}}'
v "a non-string value"               '{"settings":{"sb-favs":{"a":1}}}'
v "an empty settings object"         '{"settings":{}}'
v "a body with no wrapper"           '{"sb-favs":"x"}'
v "an array instead of an object"    '{"settings":[1,2]}'
v "a body that is not JSON"          'not json'
BIG=$(python3 -c "print('x'*70000)")
v "a value over the size cap"        "{\"settings\":{\"sb-favs\":\"$BIG\"}}"

echo "== sessions end =="
curl -s -D $T/l1 -o /dev/null -X POST "$B/auth/logout" -H "Origin: $APP" -H "$A"
chk "logout" 200 "$(code $T/l1)"
curl -s -D $T/l2 -o /dev/null "$B/me" -H "Origin: $APP" -H "$A"
chk "  token is dead afterwards" 401 "$(code $T/l2)"
curl -s -D $T/l3 -o /dev/null -X POST "$B/auth/logout" -H "Origin: $APP" -H "$A"
chk "  logging out twice is fine" 200 "$(code $T/l3)"
curl -s -D $T/e1 -o /dev/null "$B/me" -H "Origin: $APP" -H "Authorization: Bearer $TOKEN_X"
chk "an expired row cannot authenticate" 401 "$(code $T/e1)"


# --------------------------------------------------------------------------
# Pick'em. Uses two real test data sets, on purpose:
#   season 2026 week 1 — 16 games, all still upcoming  -> picking, privacy
#   season 2025 week 1 — 16 games, all final           -> the lock, scoring
# --------------------------------------------------------------------------
jpost(){ curl -s -o "$2" -w '%{http_code}' -X "$3" "$B$1" -H "Origin: $APP" -H "$4" \
         -H 'Content-Type: application/json' -d "$5"; }

echo "== pools: creating and joining =="
code=$(jpost /pools $T/pc POST "$A2" '{"name":"Sunday Money","season":2026,"league":"nfl"}')
chk "create" 201 "$code"
POOL=$(jq_ $T/pc "['pool']['id']"); JOIN=$(jq_ $T/pc "['pool']['join_code']")
chk "  mode is straight up" "su" "$(jq_ $T/pc "['pool']['mode']")"
chk "  join code is 6 chars" 6 "$(printf %s "$JOIN" | wc -c | tr -d ' ')"
curl -s -o $T/pl "$B/pools" -H "Origin: $APP" -H "$A2"
chk "owner sees it listed" 1 "$(jq_ $T/pl "len(d['pools'])")"
chk "  and is the only member" 1 "$(jq_ $T/pl "d['pools'][0]['members']")"

curl -s -D $T/nm -o /dev/null "$B/pools/$POOL" -H "Origin: $APP" -H "$B_AUTH"
chk "a non-member is refused" 403 "$(code $T/nm)"
chk "join with the code" 200 "$(jpost /pools/join $T/pj POST "$B_AUTH" "{\"code\":\"$JOIN\"}")"
chk "joining twice is fine" 200 "$(jpost /pools/join $T/pj POST "$B_AUTH" "{\"code\":\"$JOIN\"}")"
curl -s -o $T/pd "$B/pools/$POOL" -H "Origin: $APP" -H "$A2"
chk "pool now has two members" 2 "$(jq_ $T/pd "len(d['members'])")"

echo "== pools: bad input =="
chk "empty name"        400 "$(jpost /pools $T/x POST "$A2" '{"name":"   ","season":2026}')"
chk "unbuilt mode"      400 "$(jpost /pools $T/x POST "$A2" '{"name":"x","mode":"ats"}')"
chk "unknown league"    400 "$(jpost /pools $T/x POST "$A2" '{"name":"x","league":"cricket"}')"
chk "60+ char name"     400 "$(jpost /pools $T/x POST "$A2" "{\"name\":\"$(python3 -c 'print("z"*61)')\"}")"
chk "bad join code"     404 "$(jpost /pools/join $T/x POST "$A2" '{"code":"ZZZZZZ"}')"

echo "== renaming a pool =="
chk "the owner can rename" 200 "$(jpost /pools/$POOL $T/rn PATCH "$A2" '{"name":"Sunday Money II"}')"
curl -s -o $T/rn2 "$B/pools/$POOL" -H "Origin: $APP" -H "$A2"
chk "  the new name sticks" "Sunday Money II" "$(jq_ $T/rn2 "['pool']['name']")"
chk "a member who is not the owner cannot" 403 "$(jpost /pools/$POOL $T/x PATCH "$B_AUTH" '{"name":"Hijacked"}')"
chk "  and the name is untouched" "Sunday Money II" "$(jq_ $T/rn2 "['pool']['name']")"
chk "an empty name is refused" 400 "$(jpost /pools/$POOL $T/x PATCH "$A2" '{"name":"  "}')"
chk "season cannot be changed this way" 2026 "$(jpost /pools/$POOL $T/x PATCH "$A2" '{"name":"ok","season":1999}' >/dev/null; jq_ <(curl -s "$B/pools/$POOL" -H "$A2") "['pool']['season']")"

echo "== the week view =="
curl -s -o $T/wk "$B/pools/$POOL/week/1" -H "Origin: $APP" -H "$A2"
chk "16 games in week 1" 16 "$(jq_ $T/wk "len(d['games'])")"
chk "  none locked yet" 0 "$(jq_ $T/wk "len([g for g in d['games'] if g['locked']])")"
chk "  kickoff came from ESPN" True "$(jq_ $T/wk "d['games'][0]['kickoff'] > 1780000000")"
chk "  home/away is explicit" True "$(jq_ $T/wk "'neutral' in d['games'][0]")"
chk "  a neutral-site game is flagged" True "$(jq_ $T/wk "any(g['neutral'] for g in d['games'])")"
chk "  odds passed through for display" True "$(jq_ $T/wk "any(g.get('odds') for g in d['games'])")"
G1=$(jq_ $T/wk "d['games'][0]['id']"); H1=$(jq_ $T/wk "d['games'][0]['home']['id']")
A1=$(jq_ $T/wk "d['games'][0]['away']['id']")
G2=$(jq_ $T/wk "d['games'][1]['id']"); H2=$(jq_ $T/wk "d['games'][1]['home']['id']")

echo "== submitting picks =="
# Build the body in a variable. Escaped JSON inside "$( ... )" with a line
# continuation does not survive the shell intact, and the symptom is a confusing
# "body must be JSON" from the worker rather than a shell error.
PICKS2="{\"week\":1,\"picks\":[{\"event_id\":\"$G1\",\"selection_id\":\"$H1\"},{\"event_id\":\"$G2\",\"selection_id\":\"$H2\"}]}"
chk "valid picks accepted" 200 "$(jpost /pools/$POOL/picks $T/sp PUT "$A2" "$PICKS2")"
chk "  both saved" 2 "$(jq_ $T/sp "len(d['saved'])")"
chk "  none rejected" 0 "$(jq_ $T/sp "len(d['rejected'])")"
jpost /pools/$POOL/picks $T/sp2 PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$G1\",\"selection_id\":\"$A1\"}]}" >/dev/null
curl -s -o $T/wk2 "$B/pools/$POOL/week/1" -H "Origin: $APP" -H "$A2"
chk "changing a pick overwrites it" "$A1" "$(jq_ $T/wk2 "d['myPicks']['$G1']")"

echo "== picks the server must refuse =="
jpost /pools/$POOL/picks $T/r1 PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$G1\",\"selection_id\":\"999999\"}]}" >/dev/null
chk "a team not in the game" "that team is not in this game" "$(jq_ $T/r1 "d['rejected'][0]['why']")"
jpost /pools/$POOL/picks $T/r2 PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"1\",\"selection_id\":\"$H1\"}]}" >/dev/null
chk "an event not in the week" "not a game in this week" "$(jq_ $T/r2 "d['rejected'][0]['why']")"
chk "no picks at all" 400 "$(jpost /pools/$POOL/picks $T/x PUT "$A2" '{"week":1,"picks":[]}')"
chk "a nonsense week" 400 "$(jpost /pools/$POOL/picks $T/x PUT "$A2" '{"week":99,"picks":[{"event_id":"1","selection_id":"1"}]}')"
SOLO=$(jq_ <(jpost /pools $T/solo POST "$A2" '{"name":"A only","season":2026}' >/dev/null; cat $T/solo) "['pool']['id']")
chk "a non-member submitting to a real pool" 403 "$(jpost /pools/$SOLO/picks $T/x PUT "$B_AUTH" '{"week":1,"picks":[{"event_id":"1","selection_id":"1"}]}')"
chk "a pool that does not exist is a 404, not a 403" 404 "$(jpost /pools/999999/picks $T/x PUT "$A2" '{"week":1,"picks":[{"event_id":"1","selection_id":"1"}]}')"

echo "== THE LOCK: a finished week cannot be picked =="
old=$(jpost /pools $T/op POST "$A2" '{"name":"Last Season","season":2025,"league":"nfl"}')
OLDPOOL=$(jq_ $T/op "['pool']['id']")
jpost /pools/join $T/oj POST "$B_AUTH" "{\"code\":\"$(jq_ $T/op "['pool']['join_code']")\"}" >/dev/null
curl -s -o $T/ow "$B/pools/$OLDPOOL/week/1" -H "Origin: $APP" -H "$A2"
chk "every 2025 game reads as locked" 16 "$(jq_ $T/ow "len([g for g in d['games'] if g['locked']])")"
OG=$(jq_ $T/ow "d['games'][0]['id']"); OH=$(jq_ $T/ow "d['games'][0]['home']['id']")
jpost /pools/$OLDPOOL/picks $T/ol PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$OG\",\"selection_id\":\"$OH\"}]}" >/dev/null
chk "the pick is refused" 0 "$(jq_ $T/ol "len(d['saved'])")"
chk "  and says why" "that game has already started" "$(jq_ $T/ol "d['rejected'][0]['why']")"
chk "  nothing reached the database" 0 "$($WRANGLER d1 execute fixtura --local --json \
  --command "SELECT COUNT(*) AS n FROM picks WHERE pool_id=$OLDPOOL" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo ERR)"

echo "== PRIVACY: an unlocked pick is invisible to everyone else =="
jpost /pools/$POOL/picks $T/bp PUT "$B_AUTH" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$G1\",\"selection_id\":\"$H1\"},{\"event_id\":\"$G2\",\"selection_id\":\"$H2\"}]}" >/dev/null
chk "B's picks saved" 2 "$(jq_ $T/bp "len(d['saved'])")"
curl -s -o $T/av "$B/pools/$POOL/week/1" -H "Origin: $APP" -H "$A2"
chk "A still sees A's own picks" True "$(jq_ $T/av "len(d['myPicks']) >= 2")"
chk "A sees NO other picks" 0 "$(jq_ $T/av "len(d['picks'])")"
BID=$($WRANGLER d1 execute fixtura --local --json --command \
  "SELECT id FROM users WHERE sub='test-sub-2'" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["id"])' 2>/dev/null)
chk "B's user id appears nowhere in the payload" "False" \
  "$(python3 -c "import json;d=json.load(open('$T/av'));print(str($BID) in json.dumps(d['picks']))")"
chk "  (B is still listed as a member)" True "$(jq_ $T/av "len(d['members'])==2")"

echo "== standings and scoring =="
# Seed a finished week directly: A picks every winner, B picks every loser.
python3 - "$OLDPOOL" "$NOW" > $T/seed.sql <<'PY'
import sys,json,urllib.request
pool,now=sys.argv[1],sys.argv[2]
u="https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2025&seasontype=2&week=1"
r=urllib.request.Request(u,headers={"User-Agent":"Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)"})
d=json.load(urllib.request.urlopen(r))
out=[]
for e in d["events"]:
    c=e["competitions"][0]; cs=c["competitors"]
    w=[x for x in cs if x.get("winner")]
    if not w: continue
    win=w[0]["team"]["id"]; lose=[x for x in cs if x["team"]["id"]!=win][0]["team"]["id"]
    for sub,sel in (("test-sub-1",win),("test-sub-2",lose)):
        out.append(f"INSERT OR REPLACE INTO picks (pool_id,user_id,event_id,week,selection_id,locks_at,created_at,updated_at) "
                   f"VALUES ({pool},(SELECT id FROM users WHERE sub='{sub}'),'{e['id']}',1,'{sel}',0,{now},{now});")
print("\n".join(out))
PY
$WRANGLER d1 execute fixtura --local --file=$T/seed.sql >/dev/null 2>&1
curl -s -o $T/st "$B/pools/$OLDPOOL/standings" -H "Origin: $APP" -H "$A2"
chk "everyone appears" 2 "$(jq_ $T/st "len(d['standings'])")"
chk "the winner picker is 16-0" "16 0" "$(jq_ $T/st "str(d['standings'][0]['wins'])+' '+str(d['standings'][0]['losses'])")"
chk "  at 100%" 100 "$(jq_ $T/st "d['standings'][0]['pct']")"
chk "the loser picker is 0-16" "0 16" "$(jq_ $T/st "str(d['standings'][1]['wins'])+' '+str(d['standings'][1]['losses'])")"
chk "  at 0%" 0 "$(jq_ $T/st "d['standings'][1]['pct']")"
chk "results were written once per game" 16 "$($WRANGLER d1 execute fixtura --local --json \
  --command "SELECT COUNT(*) AS n FROM results WHERE pool_id=$OLDPOOL" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo ERR)"
curl -s -o $T/st2 "$B/pools/$OLDPOOL/standings" -H "Origin: $APP" -H "$A2"
chk "re-scoring is idempotent" 16 "$($WRANGLER d1 execute fixtura --local --json \
  --command "SELECT COUNT(*) AS n FROM results WHERE pool_id=$OLDPOOL" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo ERR)"
echo "== confidence mode =="
code=$(jpost /pools $T/cc POST "$A2" '{"name":"Conf Pool","season":2026,"league":"nfl","mode":"confidence"}')
chk "create" 201 "$code"
CPOOL=$(jq_ $T/cc "['pool']['id']")
chk "  mode sticks" "confidence" "$(jq_ $T/cc "['pool']['mode']")"

curl -s -o $T/cwk "$B/pools/$CPOOL/week/1" -H "Origin: $APP" -H "$A2"
CG1=$(jq_ $T/cwk "d['games'][0]['id']"); CH1=$(jq_ $T/cwk "d['games'][0]['home']['id']")
CG2=$(jq_ $T/cwk "d['games'][1]['id']"); CH2=$(jq_ $T/cwk "d['games'][1]['home']['id']")
NGAMES=$(jq_ $T/cwk "len(d['games'])")

CPICKS="{\"week\":1,\"picks\":[{\"event_id\":\"$CG1\",\"selection_id\":\"$CH1\",\"confidence\":3},{\"event_id\":\"$CG2\",\"selection_id\":\"$CH2\",\"confidence\":5}]}"
chk "valid confidence picks accepted" 200 "$(jpost /pools/$CPOOL/picks $T/csp PUT "$A2" "$CPICKS")"
chk "  both saved" 2 "$(jq_ $T/csp "len(d['saved'])")"

jpost /pools/$CPOOL/picks $T/cdup PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$CG2\",\"selection_id\":\"$CH2\",\"confidence\":3}]}" >/dev/null
chk "reusing a confidence rank is refused" 0 "$(jq_ $T/cdup "len(d['saved'])")"
chk "  and says why" "that confidence rank is already used this week" "$(jq_ $T/cdup "d['rejected'][0]['why']")"

jpost /pools/$CPOOL/picks $T/coor PUT "$A2" \
  "{\"week\":1,\"picks\":[{\"event_id\":\"$CG1\",\"selection_id\":\"$CH1\",\"confidence\":999}]}" >/dev/null
chk "out-of-range confidence is refused" "confidence must be 1..$NGAMES" "$(jq_ $T/coor "d['rejected'][0]['why']")"

curl -s -o $T/cwk2 "$B/pools/$CPOOL/week/1" -H "Origin: $APP" -H "$A2"
chk "myConfidence is exposed on the week view" 3 "$(jq_ $T/cwk2 "d['myConfidence']['$CG1']")"

# A rank change is only expressible as a SWAP, because ranks are unique. Sending
# both legs together must work — otherwise, once every game is ranked, no rank
# could ever be changed again. The frontend builds exactly this body.
CSWAP="{\"week\":1,\"picks\":[{\"event_id\":\"$CG1\",\"selection_id\":\"$CH1\",\"confidence\":5},{\"event_id\":\"$CG2\",\"selection_id\":\"$CH2\",\"confidence\":3}]}"
chk "swapping two ranks in one request is accepted" 200 "$(jpost /pools/$CPOOL/picks $T/cswap PUT "$A2" "$CSWAP")"
chk "  both legs saved" 2 "$(jq_ $T/cswap "len(d['saved'])")"
chk "  none rejected" 0 "$(jq_ $T/cswap "len(d['rejected'])")"
curl -s -o $T/cwk3 "$B/pools/$CPOOL/week/1" -H "Origin: $APP" -H "$A2"
chk "  the ranks actually swapped" "5 3" "$(jq_ $T/cwk3 "str(d['myConfidence']['$CG1'])+' '+str(d['myConfidence']['$CG2'])")"

echo "== survivor mode =="
code=$(jpost /pools $T/sc POST "$A2" '{"name":"Survivor Pool","season":2026,"league":"nfl","mode":"survivor"}')
chk "create" 201 "$code"
SPOOL=$(jq_ $T/sc "['pool']['id']")
chk "  mode sticks" "survivor" "$(jq_ $T/sc "['pool']['mode']")"

curl -s -o $T/swk "$B/pools/$SPOOL/week/1" -H "Origin: $APP" -H "$A2"
SG1=$(jq_ $T/swk "d['games'][0]['id']"); SH1=$(jq_ $T/swk "d['games'][0]['home']['id']")
SA1=$(jq_ $T/swk "d['games'][0]['away']['id']")
SG2=$(jq_ $T/swk "d['games'][1]['id']"); SH2=$(jq_ $T/swk "d['games'][1]['home']['id']")

SPICK1="{\"week\":1,\"picks\":[{\"event_id\":\"$SG1\",\"selection_id\":\"$SH1\"}]}"
chk "one pick a week is accepted" 200 "$(jpost /pools/$SPOOL/picks $T/ssp PUT "$A2" "$SPICK1")"
SPICK2="{\"week\":1,\"picks\":[{\"event_id\":\"$SG1\",\"selection_id\":\"$SH1\"},{\"event_id\":\"$SG2\",\"selection_id\":\"$SH2\"}]}"
chk "a second team the same week is refused outright" 400 "$(jpost /pools/$SPOOL/picks $T/ssp2 PUT "$A2" "$SPICK2")"

SPICK3="{\"week\":1,\"picks\":[{\"event_id\":\"$SG2\",\"selection_id\":\"$SH2\"}]}"
chk "switching teams the same week is fine" 200 "$(jpost /pools/$SPOOL/picks $T/ssw PUT "$A2" "$SPICK3")"
curl -s -o $T/swk2 "$B/pools/$SPOOL/week/1" -H "Origin: $APP" -H "$A2"
chk "  the old week-1 row is gone" False "$(jq_ $T/swk2 "'$SG1' in d['myPicks']")"
chk "  the new one is there" "$SH2" "$(jq_ $T/swk2 "d['myPicks']['$SG2']")"

echo "== THE SURVIVOR LOCK: a week whose pick kicked off is spent =="
# Survivor's one pick a week lives on a DIFFERENT event from any new submission,
# so the per-game locked check cannot see it. Without a guard, a losing Thursday
# pick could be abandoned on Sunday and the delete-then-insert would erase it.
# Seed a week-2 pick whose game has already started, the way Sunday sees Thursday.
UID_A=$($WRANGLER d1 execute fixtura --local --json --command \
  "SELECT id FROM users WHERE sub='test-sub-1'" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["id"])' 2>/dev/null)
$WRANGLER d1 execute fixtura --local --command \
"INSERT OR REPLACE INTO picks (pool_id,user_id,event_id,week,selection_id,locks_at,created_at,updated_at)
 VALUES ($SPOOL,$UID_A,'$SG1',2,'$SH1',1,$NOW,$NOW);" >/dev/null 2>&1
SESC="{\"week\":2,\"picks\":[{\"event_id\":\"$SG2\",\"selection_id\":\"$SH2\"}]}"
chk "switching away from a kicked-off pick is refused" 400 "$(jpost /pools/$SPOOL/picks $T/sesc PUT "$A2" "$SESC")"
chk "  and says why" "your pick for this week has already kicked off" "$(jq_ $T/sesc "['error']")"
chk "  the locked pick is still there" 1 "$($WRANGLER d1 execute fixtura --local --json \
  --command "SELECT COUNT(*) AS n FROM picks WHERE pool_id=$SPOOL AND week=2 AND event_id='$SG1'" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo ERR)"
chk "  and no second pick was created" 1 "$($WRANGLER d1 execute fixtura --local --json \
  --command "SELECT COUNT(*) AS n FROM picks WHERE pool_id=$SPOOL AND week=2" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["results"][0]["n"])' 2>/dev/null || echo ERR)"

echo "== survivor: elimination, seeded against a finished season =="
old=$(jpost /pools $T/sold POST "$A2" '{"name":"Survivor Last Season","season":2025,"league":"nfl","mode":"survivor"}')
SOLDPOOL=$(jq_ $T/sold "['pool']['id']")
jpost /pools/join $T/soldj POST "$B_AUTH" "{\"code\":\"$(jq_ $T/sold "['pool']['join_code']")\"}" >/dev/null
python3 - "$SOLDPOOL" "$NOW" > $T/sseed.sql <<'PY'
import sys,json,urllib.request
pool,now=sys.argv[1],sys.argv[2]
u="https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2025&seasontype=2&week=1"
r=urllib.request.Request(u,headers={"User-Agent":"Fixtura/1.0 (+https://zach-guest.github.io/fixtura/)"})
d=json.load(urllib.request.urlopen(r))
e=d["events"][0]
c=e["competitions"][0]; cs=c["competitors"]
w=[x for x in cs if x.get("winner")][0]["team"]["id"]
l=[x for x in cs if x["team"]["id"]!=w][0]["team"]["id"]
out=[]
for sub,sel in (("test-sub-1",w),("test-sub-2",l)):
    out.append(f"INSERT OR REPLACE INTO picks (pool_id,user_id,event_id,week,selection_id,locks_at,created_at,updated_at) "
               f"VALUES ({pool},(SELECT id FROM users WHERE sub='{sub}'),'{e['id']}',1,'{sel}',0,{now},{now});")
print("\n".join(out))
PY
$WRANGLER d1 execute fixtura --local --file=$T/sseed.sql >/dev/null 2>&1

curl -s -o $T/sst "$B/pools/$SOLDPOOL/standings" -H "Origin: $APP" -H "$A2"
chk "the winner-picker is still alive" True "$(jq_ $T/sst "any(r['alive'] and r['eliminated_week'] is None for r in d['standings'])")"
chk "the loser-picker is eliminated in week 1" True "$(jq_ $T/sst "any((not r['alive']) and r['eliminated_week']==1 for r in d['standings'])")"

SPICK4="{\"week\":2,\"picks\":[{\"event_id\":\"$SG1\",\"selection_id\":\"$SH1\"}]}"
chk "an eliminated player cannot pick again" 400 "$(jpost /pools/$SOLDPOOL/picks $T/selim2 PUT "$B_AUTH" "$SPICK4")"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
