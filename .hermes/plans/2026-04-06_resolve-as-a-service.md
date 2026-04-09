# Intelligence-as-a-Service: Endpoints Are Free, Routing Is the Product

## Goal

Flip the marketplace model. **Endpoints/skills are open and cacheable — let agents have them.** The paid product is the intelligence layer: search ranking, DAG dependency resolution, reliability signals, and schema freshness. These are fundamentally non-cacheable because they're dynamic, personalized, and constantly updating.

This is the Google model applied to APIs: web pages are free, ranking is the product.

## Why the Previous Plan Was Wrong

The "pointer-as-a-service" plan tried to hide endpoint templates behind a resolve wall. Problem: any agent that calls resolve 3 times with different params reconstructs the template. Hiding data that's trivially reverse-engineerable is security theater and adds friction without moat.

**What's actually cacheable (= commodity, give it away):**
- URL templates (`/r/{subreddit}/{sort}.json`)
- Parameter schemas (path_params, query_params)
- Response schemas (JSON shape)
- Static endpoint metadata

**What's NOT cacheable (= the product, charge for it):**
- Search ranking: "which of 500 reddit endpoints answers 'get hot posts'?" — changes as endpoints are discovered, scores shift, better routes emerge
- DAG resolution: "login -> csrf -> session -> DM endpoint" — chains mutate when sites update auth
- Reliability signals: "is this endpoint returning 200 right now?" — real-time, can't cache
- Schema freshness: "did reddit change their response shape?" — drifts constantly

## Current Fee Schedule (Already Built)

From `backend/src/services/fees.ts` — you've already been pricing the intelligence:

```
search:   1000 uc  ($0.001000)  — intent -> endpoint matching
chain:     200 uc  ($0.000200)  — DAG prerequisite resolution
predict:   100 uc  ($0.000100)  — co-occurrence prediction
session:    50 uc  ($0.000050)  — learning from usage feedback
negative:   50 uc  ($0.000050)  — negative example recording
```

This IS the product. The plan is to lean into it, not fight it.

## The Model

```
┌─────────────────────────────────────────────────────────┐
│                    FREE TIER (open)                      │
│                                                         │
│  GET /v1/skills/:id          → full manifest + endpoints│
│  GET /v1/skills              → browse all skills        │
│  Local cache                 → unlimited reuse          │
│  Self-indexed skills         → yours forever            │
│                                                         │
│  Endpoints are commodity data. Let agents cache them.   │
│  They'll come back for the intelligence.                │
├─────────────────────────────────────────────────────────┤
│                 PAID TIER (intelligence)                 │
│                                                         │
│  POST /v1/search/:intent     → ranked endpoint match    │
## Two-Tier Default Behavior: No Wallet = Mine, Has Wallet = Pay

The agent's wallet state determines the default path automatically:

```
Agent has no wallet / $0 balance:
  → resolve miss
  → open browser session (Kuri)
  → browse the site, capture traffic passively
  → reverse-engineer endpoints from HAR + interceptor
  → cache locally as self-indexed skill
  → FREE FOREVER — agent did the work
  → BONUS: endpoints get published to marketplace, agent earns when others use them

Agent has wallet with funds:
  → query /v1/search for ranked endpoint match (paid: $0.001)
  → query /v1/chain for auth dependency walk (paid: $0.0002)
  → execute locally with fresh intelligence
  → FAST — skips browsing entirely
  → agent pays for speed + reliability
```

**This is the key UX insight: the free path IS the mining path.** Every agent without a wallet is a contributor. They don't know they're "mining" — they're just using Unbrowse and it works. The marketplace fills itself from the bottom up.

| Wallet state | Default behavior | Cost | Side effect |
|-------------|-----------------|------|-------------|
| No wallet / empty | Browse + reverse-engineer + cache | Free | Publishes to marketplace (earns later) |
| Has funds | Query intelligence layer + execute | ~$0.001/resolve | Fast, reliable, no browsing needed |

This must be **explicit in README and docs** — it's the core value prop for both sides:
- "Install Unbrowse. No wallet needed. It just works." (free users = miners)
- "Add a wallet. Skip the browsing. Get instant answers." (paid users = consumers)
## Payment Guards: 402 Is a Silent Fork, Never a Wall

### The Problem Today

When search returns 402 and the agent can't pay, the orchestrator (`src/orchestrator/index.ts:3479-3495`) returns a dead-end error:

```typescript
// CURRENT — breaks UX
return {
  result: {
    error: "payment_required",
    message: "Marketplace search requires payment...",
    next_step: "Pay the Tier 3 search fee, or re-run with force capture...",
    indexing_fallback_available: true,  // LIES — doesn't actually fall back
  }
};
```

The agent hits a wall. The user sees "payment_required" and has to manually re-run with `--force-capture`. This is the UX killer.

### The Fix: Auto-Fork on 402

```
Intelligence query (search/chain/health)
  ├─ has wallet + funds → pay, get intelligence, execute fast
  ├─ has wallet + empty → silent fork to mine path (no error)
  ├─ no wallet at all  → silent fork to mine path (no error)
  └─ payment fails     → silent fork to mine path (no error)
```

The agent should NEVER see "payment_required". Instead:

```typescript
// NEW — 402 is invisible to the caller
} catch (err) {
  if (isX402Error(err)) {
    // Don't return an error. Fork to the free path silently.
    console.log(`[routing] no wallet/funds — falling back to local capture`);
    return resolveViaLocalCapture(queryIntent, context);
    // This opens Kuri, browses, captures, indexes, caches — same result, just slower
  }
}
```

### Three layers of guards

**Layer 1: Pre-flight wallet check (before any paid call)**
```typescript
// src/orchestrator/index.ts — at the top of resolve flow
const wallet = getLocalWalletContext();
const canPay = wallet.wallet_address && wallet.balance_uc > 0;

if (canPay) {
  // Fast path: query intelligence layer
  return resolveViaIntelligence(queryIntent, context);
} else {
  // Free path: browse + reverse-engineer + cache
  return resolveViaLocalCapture(queryIntent, context);
}
```

Never even attempt a paid call if there's no wallet. Zero wasted round-trips.

**Layer 2: Graceful 402 catch (in case balance changed mid-session)**
```typescript
// src/client/index.ts — in the fetch wrapper
if (res.status === 402) {
  // Try lobster pay-and-retry (existing)
  // If that fails → DON'T throw, return a sentinel
  return { data: null, x402_skipped: true };
}
```

The client never throws on 402. It returns a signal. The orchestrator checks the signal and forks.

**Layer 3: Transparent logging (user knows what happened)**
```
[unbrowse] no wallet configured — browsing reddit.com directly (free, ~8s)
[unbrowse] captured 12 endpoints, cached locally
[unbrowse] tip: add a wallet for instant results ($0.001/query)
```

One log line explaining what happened. One tip about the paid path. No error, no wall, no re-run needed.

### What changes in code

| File | Change |
|------|--------|
| `src/orchestrator/index.ts:3456-3502` | Replace `payment_required` error return with silent fork to `resolveViaLocalCapture()` |
| `src/client/index.ts:514-550` | Don't throw on 402 when lobster fails — return sentinel `{ x402_skipped: true }` |
| `src/orchestrator/index.ts` (top of resolve) | Add pre-flight wallet check to skip paid calls entirely |
| `src/client/index.ts:isX402Error` | Keep for internal routing, but never surface to caller |

### The UX contract

- **No wallet?** Everything works. Browsing is slower but free. No errors.
- **Has wallet?** Everything is faster. Payment is invisible (auto-pay via lobster).
- **Wallet runs dry mid-session?** Seamless fallback to browse. Log line, not an error.
- **The word "payment_required" never appears in any user-facing output.**

---

│    "Did the response shape change?" ($0.0001)           │
│                                                         │
│  These are dynamic, personalized, non-cacheable.        │
│  This is the recurring revenue engine.                  │
└─────────────────────────────────────────────────────────┘
```

## Why Agents Keep Paying (The Non-Cacheability Argument)

### Search ranking is ephemeral
An agent caches "for reddit hot posts, use endpoint X." Next week, a new contributor indexes a faster endpoint Y with 99% reliability vs X's 85%. The cached answer is now suboptimal. The agent that queries search gets Y; the agent running on stale cache gets X's 403 errors.

### DAG chains mutate
X.com changes their auth flow quarterly. The cached chain `login -> bearer -> timeline` breaks when they add a CSRF step. The agent that queries `/v1/chain` gets the updated flow; the cached agent gets 401s.

### Reliability is real-time
An endpoint that worked yesterday returns 429 today because the site added rate limiting. `/v1/health` knows this in real-time from other agents' feedback. A cached endpoint has no signal.

### Schema drifts silently
Reddit adds a `crosspost_parent` field to their response. Agents parsing the old schema miss it. `/v1/schema/fresh` returns the current shape. Cached schemas go stale without warning.

### The compound effect
Each signal alone is marginal. Together, they're the difference between "my agent works 95% of the time" and "my agent works 60% of the time." Professional agent builders will pay $0.001/query for 95% reliability over maintaining stale caches.

## What Changes From Current Architecture

### Already done (keep as-is)
- `GRAPH_OPERATION_COST_UC` fee schedule in `backend/src/services/fees.ts`
- `requireSearchPayment()` x402 gate on search routes
- `recordGraphFee()` ledger tracking per agent
- `chargeSearchFee()` on search/chain/predict operations
- Skills cached locally via `cachePublishedSkill()`
- Skills browsable via `GET /v1/skills`

### New: Make endpoints fully open on GET /v1/skills/:id
- **Remove x402 gate from skill fetch** — let anyone download the full manifest for free
- Keep x402 on search/chain/predict/health (the intelligence)
- This is counterintuitive but correct: giving away the data drives adoption, charging for intelligence drives revenue

### New: Add live reliability endpoint
```typescript
// backend/src/routes/health.ts
GET /v1/health/:endpoint_id
  → { status: "healthy" | "degraded" | "down",
      reliability_7d: 0.94,
      last_success: "2026-04-06T10:23:00Z",
      last_failure: "2026-04-05T18:41:00Z",
      avg_latency_ms: 142,
      schema_drift: false }
```
Fed by execution feedback from all agents. Non-cacheable by nature.

### New: Add schema freshness endpoint
```typescript
// backend/src/routes/schema.ts
GET /v1/schema/fresh/:endpoint_id
  → { schema: { ... },
      last_verified: "2026-04-06T09:00:00Z",
      drift_since: null | "2026-04-01T...",
      fields_added: ["crosspost_parent"],
      fields_removed: [] }
```
Returns the latest verified response schema with drift annotations.

### New: Enhance chain endpoint with live resolution
```typescript
// backend/src/routes/chain.ts
POST /v1/chain/:endpoint_id
  → { chain: [
        { step: 1, endpoint_id: "login_csrf", status: "healthy" },
        { step: 2, endpoint_id: "oauth_token", status: "healthy" },
        { step: 3, endpoint_id: "dm_fetch", status: "degraded" }
      ],
      estimated_success_rate: 0.87,
      estimated_total_latency_ms: 420 }
```
Returns the live dependency chain with per-step health. The graph structure is in the free manifest; the live health overlay is the paid signal.

### Modify: Client orchestrator prefers intelligence queries
```
Current flow:
  1. Check local cache → hit? execute
  2. Miss → searchIntentResolve() → get skill → cache → execute

New flow:
  1. Check local cache → have endpoints? great
  2. ALWAYS call /v1/search for ranking → "use endpoint X" (paid)
  3. If auth needed → /v1/chain for dep walk (paid)
  4. Optionally → /v1/health for live signal (paid)
  5. Execute locally with own cached endpoint + fresh intelligence
```

The key shift: even if you have the endpoint cached, you still query search for the best current answer. The data is free; the routing decision is paid.

## Revenue Model

### Per-agent unit economics
A typical agent session (resolve one intent):
```
1x search query:     $0.001000
1x chain resolution: $0.000200  (if auth needed)
1x health check:     $0.000100  (optional)
─────────────────────────────
Total per resolve:   $0.001300  (~$0.001 avg blended)
```

### At scale
| Daily resolves | Monthly revenue | Annual revenue |
|---------------|-----------------|----------------|
| 100           | $3              | $36            |
| 1,000         | $30             | $360           |
| 10,000        | $300            | $3,600         |
| 100,000       | $3,000          | $36,000        |
| 1,000,000     | $30,000         | $360,000       |

Revenue scales linearly with usage. No ceiling from one-time purchases.

### Contributor payouts
Contributors earn a share of intelligence fees when their endpoints are selected:
- Search fee: 20% to contributor whose endpoint was ranked #1
- Chain fee: split among contributors whose endpoints are in the chain
- Health/schema: funded by platform (these benefit all agents)

## Migration Path

### Phase 1: Open the data (this week)
- Remove x402 gate from `GET /v1/skills/:id` — make endpoint manifests free
- Keep x402 on all `/v1/search/*` routes (already gated)
- Messaging: "Unbrowse endpoints are open. The intelligence is the product."

### Phase 2: Add health + schema endpoints (next week)
- `GET /v1/health/:endpoint_id` — live reliability from aggregated feedback
- `GET /v1/schema/fresh/:endpoint_id` — latest verified schema with drift
- Wire execution feedback from all agents into health aggregation

### Phase 3: Enhance client to prefer intelligence (week after)
- Client always queries `/v1/search` even with local cache
- Client queries `/v1/chain` before executing auth-gated endpoints
- Client optionally queries `/v1/health` for high-stakes operations

### Phase 4: Usage-based tiers
- Free tier: 100 search queries/month, no chain/health
- Pro tier: unlimited search, chain, health, predict
- Enterprise: dedicated ranking, priority health signals, SLA

## Investor Narrative

"Unbrowse is the Google of internal APIs. Anyone can see the endpoints — we publish them openly. But when your agent needs to know which endpoint to call, what auth chain to follow, and whether it's working right now, that's our intelligence layer. It's non-cacheable by design — the ranking changes hourly, auth flows mutate weekly, reliability signals are real-time. Every agent query is a paid API call. At 1M daily agent queries, that's $360K ARR from intelligence alone, with near-zero marginal cost on Cloudflare Workers."

## Risks

### Risk: Agents skip search and hardcode endpoints
Some agents will cache "reddit hot posts = endpoint X" and never query search again. That's fine — they'll come back when X breaks, or when they need a new domain, or when they want better reliability. The intelligence layer is insurance, not a gate.

### Risk: Competitors scrape our open endpoints
Let them. The endpoints are commodity data — any tool that browses can discover them. Our moat is the ranking, the graph, the reliability signals, and the network effect of millions of agent executions feeding back into the system. Scraping endpoints without the intelligence is like scraping web pages without PageRank.

### Risk: Search results become cacheable if ranking is stable
If the same intent always returns the same endpoint, agents learn to skip search. Mitigation: ranking IS dynamic — new endpoints get indexed daily, reliability scores shift with every execution, contributor activity changes supply. The ranking genuinely changes.

## Files to Change

| File | Change |
|------|--------|
| `backend/src/routes/skills.ts` | Remove x402 gate from GET /skills/:id |
| `backend/src/routes/health.ts` | NEW — live reliability endpoint |
| `backend/src/routes/schema.ts` | NEW — schema freshness endpoint |
| `backend/src/routes/chain.ts` | Enhance with live health overlay |
| `backend/src/services/fees.ts` | Add health + schema_fresh operations |
| `backend/src/services/health.ts` | NEW — aggregate execution feedback into health |
| `src/orchestrator/index.ts` | Always-query-search flow, health checks |
| `src/client/index.ts` | New health(), schemaFresh() API methods |

## Open Questions

1. **Free tier limits**: How many search queries/month before paywall? Too low = friction kills adoption. Too high = no revenue. Propose: 100/month free, then x402.

2. **Health signal aggregation window**: Real-time from last N executions? Rolling 1h? 24h? Shorter = more valuable but noisier.

3. **Should self-indexed endpoints also feed health signals?** If yes, every user's execution feedback improves the system. If no, marketplace health data is sparser.
