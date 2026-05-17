# unbrowse-frontend acceptance criteria

Wave 2026-05-17. Mode: product. Scope: full-stack (user-approved), encrypted
cookie store (user-approved). Every lane cites a source_id resolvable in
evidence-2026-05-17.jsonl. No em dashes (project ban). Rubric order is
priority order.

## Lanes

### L1 accounts_logins
Magic-link signup, email poll, CLI pairing, and the unauthenticated gate all
keep working. Authed `/account` shows real profile (email, created_at,
keys_count, skills_count, wallet fields) from GET /v1/account/me.
- pass_when: `/login` sends a magic link and `/account` while authed renders the real account/me payload, no regression from current behavior.
- source_ids: agentbrowser:/account, agentbrowser:/login

### L2 api_key_management_crud
A signed-in user can create a named API key, see each key's id + created_at,
revoke a key, and rotate a key, entirely from `/account`. Backend gains
`POST /v1/account/keys`, `DELETE /v1/account/keys/:keyId`,
`POST /v1/account/keys/:keyId/rotate` plus a revoke/unbind service; list now
returns created_at.
- pass_when: create returns a one-shot plaintext key bound to the user; the new key authenticates GET /v1/account/me; delete makes that key 401; rotate issues a new key and 401s the old; `/account` reflects all three without reload errors.
- source_ids: code:backend/keys-crud-missing, agentbrowser:/account

### L3 private_public_index_management
A user can see every skill/endpoint they indexed and toggle each between
public (in marketplace resolve) and private (excluded from public resolve,
still theirs). `visibility: "public" | "private"` lands on SkillManifest in
all three type files; `PATCH /v1/skills/:id` accepts visibility; resolve
excludes private skills for other agents.
- pass_when: toggling a skill to private removes it from an anonymous GET /v1/skills card list and from another agent's resolve, while the owner still sees it under GET /v1/account/skills; toggling back restores it; `bun --bun tsc --noEmit -p backend/tsconfig.json` stays clean and the Next.js build does not throw TS2339.
- source_ids: code:backend/skill-visibility-missing, code:frontend/types-tri-sync

### L4 cookie_cloud_sync_per_account
Per-account encrypted cookie vault. The user opts in per domain; cookies are
encrypted with a per-user data key (envelope encryption, master key from
Worker secret, never stored plaintext), scoped to user_id, push and pull via
authenticated endpoints. `/account/cookies` lists synced domains, last-sync
time, and lets the user add/remove a domain and purge the vault.
- pass_when: push then pull for a domain round-trips the cookie set for the owning user only; a different user's bearer key gets 403/empty for that domain; stored KV/D1 value is ciphertext (no plaintext cookie name/value greppable); removing a domain deletes its ciphertext; the `/account/cookies` screen renders the real synced-domain list (not an empty stub).
- source_ids: code:backend/cookie-sync-missing

### L5 x402_payment_tracking
One coherent payment surface (on `/account` or `/dashboard`) shows: today's
sponsor cap + spent + remaining (GET /v1/account/sponsor-status), credit
balance (GET /v1/credits/balance when enabled), fees/attribution
(GET /v1/stats/fees, /v1/stats/attribution), and dashboard economics
(spent/earned USD). Numbers are live from the API, not placeholders.
- pass_when: an authed user sees real dollar figures sourced from the listed endpoints; when an endpoint 404s (feature gated) the panel degrades to a labeled "not enabled" state, never a blank or NaN; no hardcoded sample numbers.
- source_ids: code:backend/x402-tracking-endpoints, agentbrowser:/dashboard, agentbrowser:/billing

### L6 api_key_wrapping_x402
An API key can be bound to an x402 funding source (wallet address or a
prepaid credit budget) so calls authenticated by that key auto-pay paid
skills without per-call signing. Backend: a key->funding binding + execute
path that debits the bound budget/wallet. Frontend: bind/unbind UI under the
key in `/account`.
- pass_when: binding a credit budget to a key, then executing a paid skill with only that key, debits the bound budget (GET /v1/credits/balance drops by the price) and the execute succeeds without an X-PAYMENT header; unbinding restores manual-payment behavior; an unbound key still 402s as today.
- source_ids: code:backend/key-x402-wrap-missing

### L7 fix_search_broken
`/search` returns real skills for anonymous visitors. Root cause: server-side
searchSkills() POSTs /v1/search with no auth, backend 401, catch swallows it.
Fix at the right layer: public search uses an unauthenticated-allowed search
path (card-view parity) or attaches a service token, and the catch logs
instead of silently returning [].
- pass_when: an anonymous query on `/search` returns a non-empty ranked skill list for a common intent; the failure path surfaces an error state, never a silent empty list.
- source_ids: agentbrowser:/search, code:frontend/search-rootcause

### L8 remove_dead_redundant
Stale `/skill.md` footer link removed from site-footer (retired v6.15.0, per
CLAUDE.md the skill path is intentionally gone). `/leaderboard` no longer
appears as a separate nav/footer item duplicating `/miners` (route kept as a
redirect for old inbound links, de-listed from chrome). `/agents/[id]` gets a
real inbound link (it is functional but orphaned) or is removed. The
`/shadow-apis-are-all-you-need` exact duplicate is canonicalized to
`/internal-apis-are-all-you-need` (rel=canonical) rather than left as a silent
byte-clone.
- pass_when: no page links to /skill.md; chrome lists Miners once, not Miners+Leaderboard; /agents/[id] is reachable from at least one real link OR the route is deleted; the duplicate marketing route emits a canonical tag.
- source_ids: agentbrowser:/skill.md-footer, agentbrowser:/leaderboard, agentbrowser:/agents/[id], agentbrowser:/shadow-apis-are-all-you-need

### L9 no_dead_screens_verification
Post-build agent-browser re-sweep of every route. Every route is REAL or
AUTH_PROMPT_OK. Zero BROKEN, zero DEAD, zero unresolved REDUNDANT. Every new
feature screen (key CRUD, skill visibility, /account/cookies, x402 panel,
key->x402 bind) calls a real endpoint and renders real data, not a stub.
- pass_when: a fresh agent-browser sweep produces a verdict table with no BROKEN/DEAD cell and every new screen shows a real API call + real content.
- source_ids: agentbrowser:/search, agentbrowser:/account, agentbrowser:/dashboard, agentbrowser:/skill.md-footer, agentbrowser:/leaderboard

## Rubric

```yaml
lanes:
  - id: L1
    description: accounts + magic-link login + unauth gate keep working
    source_ids: [agentbrowser:/account, agentbrowser:/login]
  - id: L2
    description: API key create/list(created_at)/revoke/rotate full-stack
    source_ids: [code:backend/keys-crud-missing, agentbrowser:/account]
  - id: L3
    description: per-skill public/private visibility, tri-file type sync
    source_ids: [code:backend/skill-visibility-missing, code:frontend/types-tri-sync]
  - id: L4
    description: per-account encrypted cookie vault + /account/cookies UI
    source_ids: [code:backend/cookie-sync-missing]
  - id: L5
    description: aggregated x402 payment tracking surface, live numbers
    source_ids: [code:backend/x402-tracking-endpoints, agentbrowser:/dashboard, agentbrowser:/billing]
  - id: L6
    description: API key wrapping x402 (key bound to wallet/credit budget)
    source_ids: [code:backend/key-x402-wrap-missing]
  - id: L7
    description: fix broken anonymous /search (401 swallowed)
    source_ids: [agentbrowser:/search, code:frontend/search-rootcause]
  - id: L8
    description: remove dead/redundant chrome links, canonicalize duplicate
    source_ids: [agentbrowser:/skill.md-footer, agentbrowser:/leaderboard, agentbrowser:/agents/[id], agentbrowser:/shadow-apis-are-all-you-need]
  - id: L9
    description: post-build agent-browser sweep, zero dead/broken screens
    source_ids: [agentbrowser:/search, agentbrowser:/account, agentbrowser:/dashboard, agentbrowser:/skill.md-footer, agentbrowser:/leaderboard]
```
