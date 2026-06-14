# Strategy gap analysis — the standard protocol + indexers-pointed-at-our-wallets

**INTERNAL ONLY** (this dir is gitignored — the private tier). Never publish any of
this, and keep the privacy-IP track (the unreleased authorization scheme) out of
every public artifact until the whitepaper ships. Written day 30 of the backlog
walk, grounded in the real codebase — not a pitch.

## The thesis, in one line

Make Unbrowse the protocol every agent uses to turn a website into a callable
route, so that (a) the existing browser/API-scraper companies' per-site
engineering becomes free commodity through us, and (b) the majority of indexers
publish into our route graph and are paid through our wallets/split.

Are we on that path? **Partly — the mechanism exists; the distribution and the
indexer-economics flywheel are the real gaps.** Detail below.

## Where we actually are (real, cited)

1. **The compatibility wedge is real.** The drop-in shims for every scraper SDK
   ship today: `axios-shim, got-shim, ky-shim, node-fetch-shim, undici-shim,
   playwright-shim, puppeteer-shim, selenium-shim, stagehand-shim, firecrawl-shim,
   exa-shim, tavily-shim`, plus AI-SDK/langchain/llamaindex/crewai adapters
   (`scripts/open-core-sync.sh PUBLIC_PKGS`). This is the commoditize lever: a
   team using Playwright/Firecrawl/Exa keeps their code; the shim routes it
   through Unbrowse. Their per-site engineering stops being a moat.
2. **The protocol surface is real.** resolve → execute (the two-call contract) +
   the browse→index→publish capture path. MCP / CLI / SDK / package-skill all
   expose it. The route graph is the index.
3. **The economics are wired.** x402 per-request settlement with a 50/35/15 split
   (PLATFORM_BPS=5000; indexer pool gets the remaining 5000 bps, owner 15% when a
   domain is DNS-claimed) — `backend/src/services/flex.ts`. Stripe-tier + sponsor
   credits exist. So "indexers paid through our wallets" is mechanically live.
4. **Passive indexing just shipped** (this session) — browsing now reverse-
   engineers + indexes-to-publish in parallel by default (opt-out). This is the
   flywheel primitive: every agent that browses grows the index without extra
   effort.
5. **The moat is bounded** (`docs/OPEN-SOURCE-NOTICE.md`): the capture/index/
   replay engine ships only as the binary (private repo); the SDKs/shims/CLI are
   MIT. The routing logic + the index + the backend are the closeable core.

## The gaps, ranked by leverage

1. **Distribution of the shims (highest leverage, lowest cost).** The shims exist
   but adoption is the bottleneck (the flywheel memory: activation, not
   acquisition, is the gap). The play: make `npx skills add unbrowse-ai/unbrowse`
   + the shims the path of least resistance for every agent framework, and get
   them into the defaults of the frameworks agents already use. Commoditization
   only bites at scale of installs.
2. **Indexer-economics flywheel must visibly pay.** Indexers point at our wallets
   only if publishing earns more than it costs. Today: passive-index lowers the
   cost to ~zero (good); the earn side needs the marketplace to have enough
   *execution* demand that published routes actually settle x402 to the indexer.
   The gap is the demand side (executors), not the supply side. Without
   executors paying, the 50% indexer pool is theoretical. **This is the real
   chicken-and-egg: subsidize execution (sponsor credits already exist) to prime
   the pump until organic executor demand covers it.**
3. **Auth on all layers / wallet binding is half-built.** x402 wallet binding +
   the SDK wallet adapters (lobster/OWS/Privy) are wired; the backend
   `/v1/wallet/sign` (delegated signing) is the missing piece (wallet-sign-backend,
   blocked on Privy delegated-signing consent + creds). Needed for the "web2 users
   pay via API with our optional default wallet" path — the on-ramp that lets
   non-crypto users participate. Until it lands, the default-wallet on-ramp is
   gated.
4. **"Standard protocol" positioning vs MCP.** We expose MCP tools, but the
   durable standard is the route-graph + the two-call contract, not the transport.
   The gap: get other indexers/tools to publish INTO our graph (not just consume),
   i.e. an open *index* spec with closed *routing/ranking*. The open/closed line
   is already drawn correctly (index format open enough to publish to; engine
   closed).
5. **Close-source sequencing.** The plan to close the servers/index/routing is
   sound but timing-sensitive: close too early and you kill the trust that drives
   adoption; too late and a fork commoditizes *us*. The hash-chained auditable
   receipt (already the trust mechanism) is what lets the engine stay closed while
   trust stays public. The privacy-IP authorization scheme (whitepaper-gated) is
   the next trust escalation — keep it private until the paper.

## The benchmark track (separate but reinforcing)

Beating Exa's published numbers (browsecomp 0.336, extraction 79.4) is the
credibility proof for "we retrieve better than the incumbents." Current honest
state: browsecomp 0.10, extraction-RAG 60% — confirmed climbs, not wins, and the
scored runs are funding-blocked (402 on the grader API). This is a *marketing/
credibility* lever, not a *commoditize* lever — useful for the narrative, but the
distribution + economics gaps above matter more for the actual moat.

## Honest verdict

The **mechanism** to commoditize scrapers and route indexer payments to our
wallets is genuinely built (shims + protocol + split + passive index). The path
is real. The **gaps are go-to-market, not engineering**: shim distribution,
priming executor demand so the indexer pool pays, finishing the default-wallet
on-ramp (wallet-sign), and the close-source timing. None of those are things a
coding loop settles — they're product/distribution/funding calls. That's why the
remaining backlog is external-gated: the engineering frontier is largely done;
the leverage now is distribution and demand.
