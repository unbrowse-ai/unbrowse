# Unbrowse telemetry worker

A Cloudflare Worker that takes nodes' anonymous usage events and keeps them in a SQLite Durable Object, so Unbrowse can count how the
network is used and see what breaks. The node's side is `unbrowse-node/app/src/telemetry.rs`; what it sends and how to
turn it off is in the [README](../README.md#usage-telemetry).

It is also the relay for agents' bug reports (`POST /v1/reports`, below): it files each as a public GitHub issue on
unbrowse-ai/unbrowse. The node's side is `unbrowse-node/app/src/report.rs`; what a report holds is in the
[README](../README.md#bug-reports).

```
POST https://telemetry.unbrowse.ai/v1/events
{"events": [{"event": "tool_call", "version": "1.4.2", "os": "macos", "install_id": "<32 hex>",
             "tool": "unbrowse_do", "outcome": "ok", "duration_ms": 120}]}
→ 204, or 400 with the reason, and nothing kept
```

## What it accepts

Nine fields, and no others ([schema.json](schema.json), which the worker's and the node's tests both read):

| Field | Values |
|---|---|
| `event` | `node_start`, `tool_call`, `route_failed` (a route the node keeps ran and failed), `fetch_failed` (a paid fetch of another identity's entry failed, or no node served its body) |
| `version` | the node's version, `X.Y.Z` |
| `os` | `macos`, `linux`, `windows`, `other` |
| `install_id` | 32 hex characters, drawn at random once per install and tied to nothing else |
| `tool` | an agent API tool (`unbrowse_search`, `unbrowse_do`, `unbrowse_browse`, `unbrowse_call`) or route template (`/v1/do`, `/v1/routes/{id}/call`, …); never a route's id |
| `outcome` | `ok`, `failed` (the site's call failed), `error` (the node refused the call) |
| `duration_ms` | a whole number, up to a day |
| `from` | on `node_start` only: the source tag the node was first started with (`unbrowse start --from <tag>` or `UNBROWSE_FROM`), `^[a-z0-9][a-z0-9-]{0,39}$`, such as `hn-e`. Kept in the column `from_tag` (`from` is an SQL word). Refused on any other event |
| `error_class` | `bad_request`, `unauthorized`, `payment_required`, `forbidden`, `not_found`, `conflict`, `unavailable`, `internal`, `site`, `other`; for a failed route use, how it failed: `step_status`, `door`, `not_an_answer`, `needs_browser`, `source_missing`, `unsupported_body`, `breaks_body`, `missing_input`, `missing_minted`, `shape_mismatch`, `http`, `transport`, `bad_url`, `refused`, `refused_hop`, `file`, `socket`, `no_body` |

A batch holds at most 100 events and 64 KiB. One event with a field off the list, a value off its list, or a value
that looks like an address (a URL, host, host and port, email or IP address) refuses the whole batch.

## What it keeps

One row per event in the `events` table ([schema.sql](schema.sql)): the event's fields and the hour it arrived. It
reads no header but the body's type and length, so it never sees the caller's IP address, user agent or country, and
it keeps no exact time. Invocation logs are off in [wrangler.jsonc](wrangler.jsonc), and the worker logs nothing.
Cloudflare's edge still sees the connection's IP address, as for any site it serves; the worker doesn't receive it.

Anyone can post a well-formed event, so the counts are what nodes say, not proof: read them as a trend.
[queries.sql](queries.sql) holds the aggregate questions: active installs a day, calls by tool and outcome, what
breaks, call times, versions in use, the funnel, the funnel by source tag (`funnel_by_from`) and the hero test's arms
judged on a first good call (`arms`).

A store made before `from_tag` keeps its table: `CREATE TABLE IF NOT EXISTS` leaves it as it is, so the store adds the
column itself on every start (`migrate` in [src/sql.js](src/sql.js), `ADDED_COLUMNS`), which is a no-op once it is there.
A new column goes in schema.sql and in `ADDED_COLUMNS`, never an index on it in schema.sql (schema.sql runs before the
column is added).

## Bug reports

```
POST https://telemetry.unbrowse.ai/v1/reports
{"kind": "wrong_data", "summary": "unbrowse_do for superdesigndev/treg returned firecrawl/firecrawl",
 "expected": "…", "got": "…", "url": "https://github.com/superdesigndev/treg", "tool": "unbrowse_do",
 "route": {"method": "GET", "host": "api.github.com", "path": "/repos/firecrawl/firecrawl", "inputs": [], "write": false, "steps": 1},
 "version": "1.4.2", "os": "macos", "source": "agent", "install_id": "<32 hex>"}
→ 201 {"issue": "https://github.com/unbrowse-ai/unbrowse/issues/12", "number": 12, "new": true, "reports": 1, "fingerprint": "…"}
→ 200 the same, "new": false, for a problem that already has its issue
→ 400 with the reason, 401 (not signed by a node), 413, 429 (a limit), 502 (GitHub didn't take it) or 503 (not set
  up, or the store down): nothing filed
```

Every report is signed by the node that sends it, with its own report key (Ed25519, made once and kept owner-only in
the node's folder as `report.key`, apart from its wallet, so a report names no one): `x-unbrowse-key` (the public
key, hex) and `x-unbrowse-signature` (hex, over `unbrowse/report\n` followed by the body's exact bytes). The relay
checks it before it reads or keeps anything, and refuses an unsigned or badly signed report with 401. While nodes
from before signing are out, `REPORTS_ACCEPT_UNSIGNED=1` takes unsigned reports too, all of them together at most 5
a day and 1 new issue a day (far below one signer's 20 and 5), each logged as a warning naming how to turn it off. It
is a switch for the rollout only: once nodes sign, turn it off with `npx wrangler secret delete REPORTS_ACCEPT_UNSIGNED`
(or remove it from the worker's variables in the dashboard), then `npx wrangler deploy`.

The fields, their lists and lengths are `reports` in [schema.json](schema.json), which the node's tests read too, with
examples of the scrub and the fingerprint that both sides must produce (each scrub example lists what must not be
left of it). A report with any other field, a URL with a query, or a route with anything but its shape is refused
whole. The text is scrubbed again here ([src/report.js](src/report.js)), whatever the node did, after decoding and
dropping hidden characters: query strings and fragments, logins in URLs, emails, IP addresses, numbers of nine digits
or more however spaced, hex, tokens, values of fields named as secrets, and vault references; hosts keep only the
site's own name (`*.atlassian.net`, `[internal]`, `[ip]`), and a route's or page's path only its plain words.

- **One problem, one issue.** The fingerprint is a hash of what the node says about a report, never an agent's free
  text: the kind, the tool, the route's method, host and path, the page's host, the last failed call's class and
  error (the node's own words: `Failed: step 2 of 2 answered 403`), and, for a report that says it is the node's, its
  error. The first report of a fingerprint opens an issue, labelled `agent-report` and the kind, with the summary as
  its title and the rest in a fixed template where every value sits in a code block (no markdown, link or mention
  renders). Later reports bump its count and add a "seen again" comment, at most once a day, that holds only the
  count: nothing a sender wrote. A problem whose issue was closed opens a new issue that names the old one. If the store loses
  a new issue's number, the next day's report finds it (GitHub's search) before opening another: only an issue the
  relay opened counts, one carrying its label and its mark (an HMAC of the fingerprint under the relay's own token,
  which nobody else can make), and of those the first. The fingerprint is public and anyone can open an issue here, so
  an issue someone else opened with the fingerprint in it, or a copy of the relay's, is never taken for the problem's.
  Rotating `GITHUB_TOKEN` changes the mark: an issue whose number the store lost before a rotation is opened once more.
- **Limits.** 20 reports and 5 new issues a signer a day, 30 new issues and 100 comments a day from everyone, so a
  flood can't bury the repository and one node can't spend the day. A report key costs nothing to make, so the daily
  caps still hold for everyone, and the edge rate limit below slows one address. The store keeps today's counts under
  `sha256(signer:<key>:day)` and `sha256(issues:<key>:day)`, and drops earlier days' counts by an index on the day.
  The install id limits nothing.
- **Source.** A report that says `source: "node"` is labelled as unverified in its issue: the relay can't tell a node
  from anyone else.
- **What the signature proves, and what it doesn't.** A signature proves that one key sent a report, so limits hold
  per key; it does not prove the sender runs a real node, since a key costs nothing and nodes are anonymous by design
  (a report names no one). So anyone can file a report, as anyone can open an issue in the public repository, and the
  first report of a problem writes its issue's words. The issue says so ("the words below are the first report's own,
  unverified"), later reports of the problem only add to its count and never its text, and the daily caps bound how
  many issues anyone can open. What no sender can do is make the relay adopt, comment on or count toward an issue the
  relay didn't open.
- **What the store keeps** (`report_issues`, `report_limits` in [schema.sql](schema.sql)): each fingerprint's issue, kind,
  count and days, and today's counts. Never a report's text, which lives only in the public issue; never the install
  id itself, a report key, the caller's IP address or another header.

## Test

```bash
cd unbrowse-telemetry && npm test
```

No dependencies: the tests run the worker's handler with Node's `Request`, the store's SQL on Node's own SQLite loaded
with `schema.sql` (`test/d1.mjs`), and a stand-in for GitHub's issues API. `npm test` runs them twice: once on a
D1-shaped stand-in, once through the Durable Object's client (`src/sql.js`) the deployed worker uses. No test reaches
GitHub.

## Deploy

It rides the release train (`.deploy/manifest.json` at the repository root, the account pinned there): staging is its
own Worker on workers.dev, production serves `telemetry.unbrowse.ai`. The store is a SQLite Durable Object
(`src/store.js`) that makes its tables from `schema.sql` on first use, so it needs no D1 database (an account holds
at most 10 on its plan).

```bash
node .deploy/deploy.mjs checks          # CHECKS_OK: the tests, and both configs bundle
node .deploy/deploy.mjs staging         # DEPLOY_OK: deployed, gated by gate.mjs, then soaked for 6 hours
node .deploy/deploy.mjs soak staging    # SOAK_ALL_OK before production
```

The stats door needs the secret `ADMIN_TOKEN` on each Worker (`npx wrangler secret put ADMIN_TOKEN`, with
`-c wrangler.staging.jsonc` for staging); the gate reads the same token from `~/.config/unbrowse/telemetry-admin-token`
(or `-staging`). Until production is deployed, nodes' sends fail and are dropped: the node works the same.

## Reading the counts

`node stats.mjs <name>` in this folder, or `GET /v1/stats/<name>` with `Authorization: Bearer <ADMIN_TOKEN>`. The names
are the questions in [queries.sql](queries.sql); `funnel` is the node's half of the funnel: by the week an
install was first seen, how many started, had an agent call a tool, got a first good call (within 7 days, and at
all), and came back a week on.
`funnel_by_from` is the same split by each install's first source tag (`from_tag`, `direct` for none), over the last 12
weeks. `arms` judges the site's hero test on the first good call: per arm (a tag ending in `-<one letter>`, so `hn-e`
is arm `e`), installs, how many got a first good call within 7 days, and the same for `settled` installs, first seen 7
or more days ago, whose window is over.
**Internal installs are left out** of every question but `gate`, `ours` and `install`: the release train's
gate, a source build (`0.x`; no release carries it), a node started with source tag `internal`, `dev`, `ci` or
`test`, and whatever an admin put on the list. To list an install (for example a developer's node: `unbrowse-node telemetry`
prints its id) or a version never offered to anyone (a device test build):

```bash
curl -X POST https://telemetry.unbrowse.ai/v1/ours -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind": "install", "value": "<32 hex>", "why": "dev machine"}'      # DELETE with kind and value takes it off
```

`ours` answers what was left out in the last 30 days: installs and calls, by reason.

`install` is the one question that takes a value: `GET /v1/stats/install?id=<install id>` (32 hex, checked, then bound
as a value, never written into the SQL) answers one install's first and last seen hour, first source tag, first tool
call, first good call, and its call counts. The site's `/admin` Journey reads it for a node whose owner signed in.

### Turning on bug reports

The relay answers 503 (and nodes keep their reports queued, for up to a week) until it has a token. Once:

1. **The label.** In unbrowse-ai/unbrowse, create the label `agent-report` (and, if you want them coloured, one per
   kind: `wrong_data`, `false_success`, `failed`, `slow`, `confusing`, `other`; GitHub makes any that are missing).
2. **A token that can only file issues there.** A fine-grained personal access token (or a GitHub App's installation
   token) with access to **only** unbrowse-ai/unbrowse and the single permission **Issues: read and write**. Nothing
   else: not contents, not other repositories. A token from a bot account keeps the issues from appearing as a
   person's.
3. **The tables** are made by the store from `schema.sql` (`CREATE TABLE IF NOT EXISTS`); nothing to run.
4. **The secret**, never in the repository:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
5. **A rate limit at the edge**, by IP, so one sender can't spend the day's issues and comments: in the Cloudflare
   dashboard for `unbrowse.ai`, Security → WAF → Rate limiting rules, create a rule matching
   `http.host eq "telemetry.unbrowse.ai" and http.request.uri.path eq "/v1/reports"`, counting by IP, 10 requests per
   10 minutes, action Block for 1 hour. Cloudflare counts at its edge; the worker still never receives or keeps the IP.
6. **Deploy** through the train (above). Then a report from a node with reports on opens an issue; `REPORTS_REPO` in
   [wrangler.jsonc](wrangler.jsonc) says which repository.

To stop filing at once, delete the secret (`npx wrangler secret delete GITHUB_TOKEN`): the relay answers 503 and
nodes hold their reports.
