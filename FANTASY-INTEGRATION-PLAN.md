# Fixtura fantasy integration plan

**Planning date:** 2026-09-10  
**Status:** exploration and implementation plan; no fantasy integration is built  
**Initial sport:** NFL fantasy football  
**Platforms considered:** Sleeper, Yahoo Fantasy, ESPN Fantasy

## 1. Product goal

Let a signed-in Fixtura user connect or import one or more fantasy football
teams and answer the questions that currently require opening several apps:

- Who is on my active lineup and bench?
- How is my matchup going this week?
- Which of my players are playing now, finished, on bye, or still upcoming?
- What scoring and roster rules apply to this league?
- Which real NFL game contains each fantasy player, and what is happening in
  that game?
- When was the fantasy data last refreshed, and is any part unavailable?

Version one is a **read-only companion**. Fixtura does not set lineups, add or
drop players, submit waiver claims, propose trades, or recalculate the official
fantasy result. The fantasy platform remains authoritative for roster state,
lineup slots, fantasy points, matchup totals, commissioner overrides, and rules.

This boundary is load-bearing. Custom scoring can include bonuses, fractional
rules, defense/special-teams rules, IDP, commissioner adjustments, and provider
interpretations that Fixtura's NFL box-score feed cannot reproduce exactly.
Imported rules are useful context; they are not permission to silently replace
the provider's score with a Fixtura calculation.

## 2. Recommendation

Plan this track now, apply for external access now, and wait to implement it
until the current EPA Phase 3 work is complete and checkpointed. The current
working tree already contains a large connected EPA schema/Worker change. A
second account-and-schema feature in the same uncommitted slice would make both
harder to review and recover.

Use this order:

1. **Sleeper MVP.** It has an official, read-only API with no user token and
   exposes users, leagues, scoring settings, roster positions, rosters, and
   weekly matchups. It is the fastest path to a real multi-league Fantasy view.
2. **Yahoo official integration.** Apply for Fantasy API access immediately;
   implementation waits for approval. Yahoo has the richest supported path of
   the three, but requires an approved application and OAuth 2.0.
3. **ESPN manual import.** Build a guided roster-and-rules import without asking
   users for `espn_s2` or `SWID` session cookies. ESPN's fantasy JSON endpoints
   remain internal and undocumented, with no supported third-party OAuth flow.
   The imported roster is enriched with Fixtura's live NFL data, but ESPN
   matchup points, lineup changes and transactions remain stale until the user
   imports an updated file.

Sleeper's official documentation says its API is free for non-commercial use
and directs commercial users to contact Sleeper. That licensing conversation
must happen before Fixtura is monetized or otherwise falls outside
non-commercial use.

## 3. Platform feasibility

| Platform | Supported access | Authentication | Useful official data | Main constraint | Recommendation |
|---|---|---|---|---|---|
| Sleeper | Official read-only API | None | User leagues, league rules, roster slots, rosters, users, weekly matchups, transactions, drafts | League data is readable without proof that the Fixtura user owns the selected roster; documented matchup data guarantees team totals, not a complete live per-player scoring feed; commercial use needs a licensing conversation | Build first |
| Yahoo | Official Fantasy Sports API, subject to application review | Yahoo OAuth 2.0 authorization-code flow with access and refresh tokens | Logged-in user's leagues and teams, settings, standings, scoreboard/matchups, weekly rosters, player stats and fantasy points | API access must be approved; tokens must be refreshed and encrypted; Yahoo resource keys and XML/JSON response shapes need an adapter | Apply now, build second after approval |
| ESPN | Manual Fixtura import; no automated ESPN access | None | User-supplied team name, roster slots, player identity and scoring rules | No automatic ESPN matchup score, lineup, waiver or transaction refresh | Build a clearly labeled manual import after the connected-provider foundation |

Primary references:

- Sleeper API: <https://docs.sleeper.com/>
- Yahoo Fantasy developer portal and access application:
  <https://sports.yahoo.com/developer/> and
  <https://sports.yahoo.com/developer/access/>
- Yahoo Fantasy API documentation:
  <https://sports.yahoo.com/developer/docs/>
- Yahoo OAuth 2.0 authorization-code flow:
  <https://developer.yahoo.com/oauth2/guide/flows_authcode/>
- Yahoo developer data-retention and API terms:
  <https://legal.yahoo.com/us/en/yahoo/guidelines/ydn/index.html> and
  <https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html>
- ESPN's public material documents fantasy settings and product behavior, but
  no supported fantasy developer API or third-party authorization flow was
  found: <https://support.espn.com/hc/en-us/categories/360000009091-Fantasy-Football>
- Disney's current terms restrict automated access, monitoring, copying and
  extraction without express written permission:
  <https://disneytermsofuse.com/english/>

The absence of an ESPN public program is a product constraint, not evidence
that the internal endpoint is technically unreachable. Community projects use
`lm-api-reads.fantasy.espn.com` and, for private leagues, ESPN web-session
cookies. Fixtura should not turn a user's full ESPN browser session into an app
credential. Such a cookie can grant broader account access than this feature
needs, expires outside Fixtura's control, and has no supported refresh flow.
Disney's current general terms also prohibit automated extraction by script
without express written permission. Do not use a technically reachable internal
endpoint as a substitute for an approved integration.

## 4. Version-one experience

Add a user-reorderable `FANTASY` view. It requires a Fixtura account because
connections and selected rosters are personal. Signed-out users see a short
explanation and the existing sign-in action.

### Empty state

Show three provider cards:

- **Sleeper — Connect by username.** Enter a Sleeper username, resolve it to
  the stable Sleeper user ID, list that user's NFL leagues for the selected
  season, then let the Fixtura user choose one or more rosters.
- **Yahoo — Connect Yahoo.** Start a server-side OAuth flow, return to Fixtura,
  list the user's NFL fantasy teams, and let the user select which to display.
  Hide or label this option as unavailable until Yahoo approves the application.
- **ESPN — Import manually.** Start a guided flow that downloads a Fixtura CSV
  template and accepts an uploaded completed template. Collect league name,
  team name, season, week/as-of date, lineup slot, player name, NFL team and
  position, with ESPN athlete ID optional. Collect scoring rules in the same
  flow using standard, half-PPR or PPR as a starting preset plus editable rule
  values. Never request ESPN session cookies.

An ESPN manual league must always display **Manual import** and its as-of date.
Fixtura can update each mapped player's real NFL game status, box-score context
and EPA without another import. It cannot claim the ESPN lineup, matchup score,
transactions or official fantasy points are current. Users replace the prior
snapshot by importing an updated file; imports are idempotent for the same
league, season and user-selected team.

Sleeper cannot prove that the signed-in Fixtura user owns the entered Sleeper
username. The UI should say “Add Sleeper profile” rather than “Verify account,”
and the private Fixtura association must not be represented as identity proof.

### Connected state

The view opens to a league/team switcher followed by:

1. **This week's matchup.** My team and opponent, current authoritative fantasy
   points, projected points only when the platform supplies them, record, week,
   and matchup state. Always show provider and refresh time.
2. **Starting lineup.** Slot, player, NFL team/opponent, real-game state and
   kickoff, provider fantasy points when available, and injury/status when a
   reliable source supplies it.
3. **Bench and reserve.** Same identity and game-state treatment, visually
   secondary. Never mix bench points into the starting total.
4. **Rules summary.** Scoring type, reception value, passing touchdown value,
   roster slots, lineup lock style, waiver type and notable bonuses when the
   provider supplies them. Include “View all imported rules” and the source
   refresh time.
5. **Connection health.** Fresh, stale, reconnect required, provider unavailable,
   or unsupported rule fields. A stale last-known roster remains visible with a
   clear timestamp after a refresh failure.

Selecting a mapped player should use Fixtura's existing `openPlayer` experience.
An unresolved identity remains a readable roster row without a broken link.

## 5. What Fixtura should display versus calculate

### Provider-authoritative

- Fantasy roster and lineup slots
- Current opponent and matchup grouping
- Fantasy points and projections
- Official record and standings
- Commissioner overrides
- League scoring and roster settings

### Fixtura enrichment

- NFL game status, kickoff, opponent, score, drive context and links
- Existing player detail, news and retained real-game statistics
- EPA context after the EPA feature ships
- Cross-league combined “players live now” and “players still to play” counts
- Clear freshness and missing-data labels

### Deferred calculations

- Recomputing fantasy points from Fixtura's NFL statistics
- Start/sit advice, waiver recommendations or trade values
- Win probability for a fantasy matchup
- Rest-of-season projections
- Automatic lineup changes or transactions

Those are separate products with separate data and evaluation requirements.

## 6. Normalized provider contract

Keep each provider adapter separate. Normalize only the concepts the UI shares;
retain bounded raw settings for audit and newly discovered provider fields.

```js
{
  provider: "sleeper" | "yahoo" | "espn-manual",
  connectionId: "string",
  league: {
    externalLeagueId: "string",
    season: 2026,
    sport: "nfl",
    name: "string",
    scoringType: "string|null",
    rosterSlots: [{ slot: "QB", count: 1 }],
    scoringRules: [{ key: "rec", label: "Reception", value: 1 }],
    rawSettingsVersion: "string"
  },
  team: {
    externalTeamId: "string",
    name: "string",
    ownerDisplayName: "string|null",
    record: { wins: 0, losses: 0, ties: 0 }
  },
  matchup: {
    week: 1,
    status: "pregame" | "active" | "final" | "unknown",
    points: 0,
    projectedPoints: null,
    opponent: { externalTeamId: "string", name: "string", points: 0 }
  },
  roster: [{
    providerPlayerId: "string",
    espnAthleteId: null,
    displayName: "string|null",
    nflTeam: "string|null",
    position: "string|null",
    lineupSlot: "QB",
    starter: true,
    reserve: false,
    fantasyPoints: null,
    projectedPoints: null,
    identityStatus: "mapped" | "ambiguous" | "unmapped"
  }],
  freshness: {
    providerUpdatedAt: null,
    fetchedAt: "ISO-8601",
    stale: false,
    warnings: []
  }
}
```

Missing data stays `null`. An absent projection, injury flag, matchup or point
breakdown never becomes zero.

## 7. Player identity

Provider player IDs are separate namespaces:

- Sleeper uses Sleeper player IDs and team abbreviations.
- Yahoo uses season-scoped Yahoo player keys.
- ESPN fantasy uses ESPN athlete IDs, but that advantage does not justify an
  unsupported connection method.
- Fixtura's player detail currently uses ESPN athlete IDs.

Add an explicit crosswalk rather than joining on display name at read time:

```sql
fantasy_player_links (
  provider,
  season,
  provider_player_id,
  espn_athlete_id,
  method,              -- provider_field | curated | exact_multi_field
  confidence,
  reviewed_at,
  PRIMARY KEY (provider, season, provider_player_id)
)
```

Automatically accept only a provider-supported ID or an exact match across
multiple stable fields such as normalized full name, NFL team and position.
Name-only matches remain unresolved. Traded players, duplicate names, defenses,
free agents and position changes need fixtures. A wrong player link is worse
than no link.

Sleeper's complete player catalog is a large object and the official docs say
to retrieve it sparingly. Fetch it in a bounded scheduled/admin job and cache a
season snapshot; do not download it for every user or page load.

## 8. Worker architecture

Fantasy routes belong entirely in the private lane. A signed-in user's selected
teams, Yahoo tokens and dashboard must never be edge-cached or returned through
`pub()`.

Proposed resources:

```text
GET    /fantasy/connections
POST   /fantasy/connections/sleeper
DELETE /fantasy/connections/:connectionId
GET    /fantasy/connections/:connectionId/leagues
POST   /fantasy/leagues
DELETE /fantasy/leagues/:id
POST   /fantasy/leagues/:id/refresh
GET    /fantasy/dashboard?leagueId=:id&week=:week

GET    /fantasy/imports/espn/template
POST   /fantasy/imports/espn

GET    /auth/yahoo/start?return=:allowedFixturaUrl
GET    /auth/yahoo/callback
```

The browser parses the selected ESPN CSV only to show a preview, then submits
bounded JSON containing the import metadata, scoring rules and rows. The Worker
revalidates every field and performs the atomic replacement; client validation
is never authoritative. The template route returns the current versioned column
contract.

Reuse Fixtura's current user session. Yahoo authorization links an external
provider to that user; it does not replace Google as Fixtura's identity system.
Use signed, short-lived OAuth state with an allowed return URL, following the
existing Google flow.

Provider modules should implement a narrow interface:

```js
listLeagues(connection, season)
getLeague(connection, externalLeagueId)
getRoster(connection, externalLeagueId, externalTeamId, week)
getMatchup(connection, externalLeagueId, externalTeamId, week)
refreshCredential(connection) // Yahoo only
```

The route layer validates ownership and parameters. Adapters understand provider
responses. A normalizer produces the shared contract. Storage persists the last
successful snapshot. Rendering never parses Yahoo or Sleeper shapes directly.

## 9. Storage plan

Use typed tables rather than putting connections into the existing settings
key/value store:

```text
fantasy_connections
  id, user_id, provider, external_user_id, display_name, status,
  access_token_ciphertext, refresh_token_ciphertext, token_nonce,
  token_expires_at, scopes, created_at, updated_at, last_error

fantasy_leagues
  id, connection_id, provider_league_id, season, sport, name,
  selected_team_id, scoring_type, roster_settings_json,
  scoring_settings_json, settings_hash, created_at, updated_at,
  last_synced_at, last_success_at, sync_status, last_error,
  import_format_version, imported_as_of

fantasy_snapshots
  league_id, week, fetched_at, provider_updated_at, content_hash,
  matchup_json, roster_json, warnings_json,
  PRIMARY KEY (league_id, week)

fantasy_player_links
  provider, season, provider_player_id, espn_athlete_id,
  method, confidence, reviewed_at
```

Every connection and league query must join through `user_id`. Deleting a
Fixtura user cascades through connections, leagues and snapshots. Deleting a
connection revokes the provider credential where supported, then deletes local
rows.

Store normalized bounded snapshots, not every upstream response forever. Keep
the current and recent weeks only where the provider's terms permit it. Record a
content hash so an unchanged refresh does not rewrite D1.

Yahoo requires provider-specific expiry. Its general Developer Network rules say
Yahoo user data may not be stored longer than 24 hours unless the API documents
or signed agreement explicitly identify it as indefinitely storable. The general
exception covers the Yahoo GUID and authenticated token, not fantasy rosters,
scores or league settings. Therefore Yahoo roster, rules, matchup and player
snapshots must carry `expires_at`, be refreshed or deleted within 24 hours, and
must not become Fixtura's permanent fantasy history unless Yahoo grants that
right in the approved agreement. The final agreement controls if it differs.

Yahoo also requires the applicable Yahoo attribution and an accurate privacy
policy describing collection, use, sharing and retention. Treat those as product
requirements, not release paperwork to add later.

## 10. Yahoo token security

Yahoo client secrets belong in Wrangler secrets. Yahoo access and refresh
tokens must be encrypted before D1 storage using an independent versioned
encryption key such as `FANTASY_TOKEN_KEY`; hashing cannot work because Fixtura
must recover the refresh token to call Yahoo.

- Use AES-GCM with a random nonce per encrypted value and authenticated context
  containing user, provider and connection ID.
- Store key version, ciphertext and nonce, never plaintext.
- Never return credentials to the frontend or place them in localStorage.
- Never log authorization codes, access tokens, refresh tokens, cookies or full
  provider error bodies that might contain them.
- Refresh server-side shortly before expiry and update tokens atomically.
- On `invalid_grant`, mark the connection `reconnect_required`; do not repeatedly
  retry a dead credential.
- Request read-only Fantasy Sports access. Do not request lineup-write access for
  the read-only product.

## 11. Refresh behavior

The first release does not need a high-frequency global cron.

- Refresh when the Fantasy view opens if the snapshot is stale.
- During active NFL games, allow a server-side refresh at a bounded interval,
  initially no faster than once per minute per connected league.
- Outside live windows, use a longer freshness period such as 10–15 minutes.
- Coalesce simultaneous requests for the same provider league where practical.
- Return the last successful snapshot with `stale: true` after a provider
  failure; do not erase a roster because one call failed.
- Respect provider throttling, `Retry-After`, and exponential backoff.
- Use the platform's current week, but validate it against league season and
  explicit stored scope. Never guess that NFL calendar week equals fantasy week.
- Expire or delete Yahoo-derived cached data within 24 hours unless the approved
  Fantasy API agreement expressly grants different retention.

Sleeper publishes a general ceiling of 1,000 calls per minute. Fixtura should
operate far below it. Yahoo says it monitors excessive usage and may throttle;
approval terms and actual response headers must set the final policy.

## 12. Testing strategy

All provider tests use retained, sanitized fixtures. Integration tests must not
depend on a live roster, the current week, a real Yahoo token, or a user's fantasy
account.

Required coverage:

- Provider response changes, missing collections and malformed numeric values
- PPR, half-PPR, standard, superflex, two-QB, IDP and unusual roster slots
- Byes, IR/reserve, empty slots, co-managed teams and commissioner overrides
- One user with multiple leagues and multiple providers
- Player traded between NFL teams, duplicated names and unmapped IDs
- Matchup not published, playoffs, multi-week matchups and season rollover
- Yahoo access-token refresh, rotated refresh token, revoked access and state
  forgery/expiry
- Provider timeout, 401/403/429/5xx, stale snapshot fallback and bounded errors
- Private response headers and ownership checks across two Fixtura users
- Fresh database and additive migration preserving users, pools, picks, stats and
  EPA tables
- Mobile/desktop layouts, every theme, reduced motion and stale/error states

Contract tests should run the same normalized fixtures through Sleeper and Yahoo
adapters and assert shared UI meaning while retaining provider-specific warnings.

## 13. Delivery phases

### F0 — access and proof samples

1. Submit the Yahoo Fantasy API application with the exact read-only use case.
2. Contact Sleeper if Fixtura's intended use may be commercial.
3. Review Yahoo's attribution, privacy and 24-hour user-data retention rules
   against the agreement returned with approval. Record any API-specific
   exceptions before finalizing storage.
4. Capture one allowed sample league from each approved provider, including
   settings, roster and matchup responses. Remove personal data before retaining
   fixtures.
5. Verify whether Sleeper's current matchup response provides documented or
   stable per-player points. Do not build against an observed undocumented field.
6. Preserve the accepted ESPN boundary: manual import only, no private
   session-cookie collection and no use of internal fantasy endpoints without
   express written permission.

Exit: access constraints, exact response shapes, terms and product boundaries are
recorded. No user credentials are in the repository.

### F1 — shared contract and storage

1. Add the additive fantasy migration and mirror the final state into repeat-safe
   `schema.sql`.
2. Implement provider adapter interfaces and the normalized contract using only
   retained fixtures.
3. Add token encryption utilities and Yahoo OAuth tests without real secrets.
4. Add private connection/league/dashboard routes with strict ownership tests.

Exit: fixture-backed adapters produce deterministic normalized dashboards and
cross-user access is rejected.

### F2 — Sleeper MVP

1. Add username lookup, season league selection and roster selection.
2. Import league/scoring settings, current roster and matchup totals.
3. Build the Fantasy view, league switcher, matchup card, lineup, bench, rules and
   freshness states.
4. Add conservative player crosswalks and real-game status enrichment.
5. Test multiple Sleeper leagues on mobile and desktop.

Exit: a signed-in user can add a Sleeper profile and see at least one selected
team's authoritative weekly matchup, roster, rules and Fixtura game context.

### F3 — Yahoo official integration

Begins only after Yahoo grants access and its agreement is reviewed.

1. Register exact production and local callback URLs.
2. Add server-side Yahoo connect/callback/refresh/disconnect flows.
3. List the logged-in user's NFL leagues and teams.
4. Normalize settings, weekly roster, scoreboard and provider fantasy points.
5. Add Yahoo fixture tests and reconnect handling before exposing the provider
   card.

Exit: Yahoo works without credential copying, uses read-only authorization, and
survives access-token expiry.

### F4 — ESPN manual import

1. Publish a versioned UTF-8 CSV template with these required columns:
   `slot`, `player_name`, `pro_team`, and `position`; accept optional
   `espn_athlete_id`. The surrounding import form supplies league name, team
   name, season, week and as-of date.
2. Add a scoring-rules step with standard, half-PPR and PPR presets plus editable
   values. Persist the submitted rules as user-provided context, not as verified
   ESPN rules.
3. Parse and validate the file in the Worker with row, byte and player-count
   limits. Reject duplicate active slots and ambiguous mappings with actionable
   row errors; never guess between two players.
4. Upsert a manual league and replace its roster snapshot atomically. Preserve
   the previous snapshot if any row fails validation.
5. Render the normal Fantasy roster experience with a permanent `Manual import`
   badge, as-of timestamp and `Import update` action. Omit official matchup and
   fantasy-point fields rather than showing zero.
6. Add downloadable sample data, keyboard/mobile coverage and tests for formula
   injection, malformed CSV, duplicate names, empty slots, free agents, IR and
   season rollover.

Exit: an ESPN user can import a roster and rules, see mapped players against live
Fixtura NFL games, and replace the snapshot safely. The product makes no claim of
automatic ESPN synchronization.

### F5 — deeper Fixtura analysis

After provider-authoritative dashboards are stable, consider:

- Roster-wide live game timeline
- Fantasy points beside EPA and retained player game logs
- Usage and efficiency context for starters versus bench
- Injury/news aggregation
- Carefully evaluated projections or recommendations

Each derived metric must state its source and should not be mixed into the
provider's official score.

## 14. Effort and dependencies

Rough engineering size for one experienced implementer with fixture access:

| Slice | Approximate effort | External dependency |
|---|---:|---|
| F0 proof and terms review | 2–4 focused days | Yahoo/Sleeper response time |
| Shared contract, schema and private routes | 4–7 days | Sanitized fixtures |
| Sleeper MVP plus frontend | 7–12 days | Sleeper usage terms |
| Yahoo OAuth and adapter | 7–12 days after F1 | Yahoo approval and credentials |
| Player crosswalk hardening | 4–8 days | Quality of provider metadata |
| ESPN manual import | 4–7 days | Final CSV template and scoring-rule fields |

These are implementation sizes, not calendar promises. Yahoo review time can
dominate the schedule, and player identity quality can expand the crosswalk work.

## 15. Decisions to settle before implementation

1. Is Fixtura expected to remain non-commercial during the Sleeper MVP?
2. Is team-level matchup score plus roster/game status enough for version one if
   Sleeper does not officially expose per-player live points?
3. Should one Sleeper profile be allowed to add any visible roster, or should the
   product require selecting only the roster whose `owner_id` matches the entered
   profile?
4. How many connected leagues per Fixtura user should version one support?
5. How long should old Sleeper fantasy snapshots be retained after a season?
   Yahoo data defaults to no more than 24 hours unless its approved agreement
   grants a different period.
6. Does the first Fantasy view need opponent roster detail, or only the opponent's
   total and team name?

Recommended defaults: non-commercial Sleeper pilot; require the selected Sleeper
roster's `owner_id` to match the entered user ID; five connected leagues per user;
retain the current plus prior Sleeper season but treat Yahoo as an expiring cache;
show only opponent name/score in version one; and implement ESPN as a separately
labeled manual import with no official matchup or fantasy-point claims.

## 16. Release gates

- Provider access and terms recorded in `DECISIONS.md`
- Yahoo retention, attribution and privacy-policy requirements implemented from
  the approved agreement
- Read-only scopes and credential storage reviewed
- No ESPN session-cookie collection or automated internal-endpoint access
- ESPN imports are versioned, bounded, atomically replaced and always labeled
  with their manual source and as-of date
- Private route ownership and `no-store` verified
- Provider fixtures contain no personal tokens or private league data
- Player mappings report unresolved/ambiguous rows honestly
- Stale snapshots remain visible and clearly dated
- Complete Worker suite and real browser validation pass
- Existing auth, Pick'em, stats, trends and EPA routes remain intact
- Production migration, secrets and deploy receive separate authorization
