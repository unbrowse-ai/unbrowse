# Clarification Questions — OpenClaw-as-Agent-Browser

## Answered (from OPENCLAW_AGENT_BROWSER_PRODUCT_SPEC.md + follow-up)

| # | Question | Answer |
|---|----------|--------|
| 1 | Which agent-browser? | `vercel/agent-browser` (public repo) |
| 2 | Target sites? | General-purpose from day one |
| 3 | Auth / login? | User provides own credentials; local-only replay, never leaves the machine |
| 4 | Discovery index? | `EmergentDB` — API key in hand |
| 5 | Infrastructure? | VM + Vercel for hosted services; execution stays local |
| 6 | Marketplace public or private? | Public |
| 7 | Mutable actions (POST/PUT/DELETE)? | Enabled, but excluded from replay verification; explicit user confirmation policy in orchestrator |
| 8 | Feedback + subscriptions? | Nice-to-have, Phase 2 — not blocking initial release |
| 9 | UI? | No dedicated UI — existing frontends plug into APIs |
| 10 | What does done look like? | Agent experience that hits ~100x vs manual browse/replay on data retrieval tasks |

---

## Still Open / Needs Clarification

1. **Duplicate merge aggressiveness** — For fuzzy endpoint variants (same URL, slightly different query params), should we merge them automatically or flag for manual review?

2. **Local credential vault standard** — OS keychain (`keytar`), or a custom encrypted local file store?

3. **Mutable action confidence thresholds** — For POST/PUT/DELETE, flat global confirmation policy for the initial build, or per-domain risk tiers?
