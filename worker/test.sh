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
trap 'rm -rf "$T"' EXIT

chk(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-50s %s\n' "$1" "$3"
       else fail=$((fail+1)); printf '  FAIL %-50s want=%s got=%s\n' "$1" "$2" "$3"; fi; }
hdr(){ grep -i "^$2:" "$1" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
code(){ head -1 "$1" | awk '{print $2}'; }
jq_(){ F="$1" EXPR="$2" python3 -c 'import json,os;d=json.load(open(os.environ["F"]));print(eval("d"+os.environ["EXPR"]))' 2>/dev/null; }
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
chk "first call misses" "MISS" "$(hdr $T/p1 x-fixtura-cache)"
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
chk "  methods" "GET,POST,PUT,DELETE,OPTIONS" "$(hdr $T/m2 access-control-allow-methods)"
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

# --------------------------------------------------------------------------
# Authenticated. Seeds the local D1 the way a completed Google login would.
# --------------------------------------------------------------------------
TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
NOW=$(date +%s); EXP=$((NOW + 2592000))
$WRANGLER d1 execute fixtura --local --command \
"DELETE FROM sessions; DELETE FROM settings; DELETE FROM users;
 INSERT INTO users (provider,sub,email,name,picture,role,created_at,last_seen)
 VALUES ('google','test-sub-1','zach@example.com','Zach Guest',NULL,'admin',$NOW,$NOW);
 INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$HASH',(SELECT id FROM users WHERE sub='test-sub-1'),$NOW,$EXP,'test.sh');" >/dev/null 2>&1
A="Authorization: Bearer $TOKEN"

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
$WRANGLER d1 execute fixtura --local --command \
"INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent)
 VALUES ('$HASH',(SELECT id FROM users WHERE sub='test-sub-1'),$NOW,$((NOW-10)),'expired');" >/dev/null 2>&1
curl -s -D $T/e1 -o /dev/null "$B/me" -H "Origin: $APP" -H "$A"
chk "an expired row cannot authenticate" 401 "$(code $T/e1)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
