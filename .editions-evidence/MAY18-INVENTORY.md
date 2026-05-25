# MAY-18 Landing Inventory — `frontend/` reverted to `e1758b13`

Source of truth: `frontend/src/app/page.tsx` (513 LOC). The May-18 rewrite was the "evidence-driven landing rewrite from 76 reddit threads" commit; copy citations trace into `frontend/docs/POSITIONING.md` (referenced in-file). No `(home)/page.tsx` route group exists — `app/page.tsx` is the only landing.

The landing is composed of **15 ordered sections** + 1 sr-only agent-instructions block + 1 fixed bottom footer bar. Two top-level chrome components (Navbar from `layout.tsx`, FlowingDotField + MobileNav floating). Audience toggle (`?mode=everyone` vs default `dev`) swaps copy in five places: H1, subhead, CTA label, "Why it matters" PEEL block (everyone-only), HeroSpeedProofStrip, HeroTerminalGated.

---

## Global chrome (rendered by `app/layout.tsx`)

### `Navbar` — `frontend/src/components/navbar.tsx`
- **Purpose**: fixed top nav, glassmorphic black/15 with backdrop-blur. Logo + links: Leaderboard, Blog, Papers, Registry, Docs (subdomain), Discord, auth state.
- **Style**: `bg-black/15 backdrop-blur-md`, 1px white/8 bottom border, h-14, max-w-7xl. White/90 logo text.
- **Keep**: glass nav over content, low-noise; logo on left + 5-6 deep links.

### `SiteFooter` — `frontend/src/components/site-footer.tsx`
- **Purpose**: Stripe-style category columns (Product, Developer, Resources, Company) + L2 tagline "infrastructure for the agentic internet". Loads on every page from layout.
- **Note**: the home page ALSO ships its own thin fixed footer bar (page.tsx L472-509) with copyright + 4 quick links (GitHub/FAQ/Terms/Privacy). Two footers stacked — duplicative, can collapse in Editions rebuild.

### `FlowingDotField` — `frontend/src/components/flowing-dot-field.tsx`
- **Purpose**: ambient animated dot/particle field, z-index 0, behind all content. Atmospheric, NOT load-bearing.
- **Style**: orange dots flowing across the viewport.

### `MobileNav` — `frontend/src/components/mobile-nav.tsx`
- **Purpose**: 57-LOC mobile-only nav drawer trigger.

### `globals.css` / theme — `frontend/src/app/globals.css`
- **Palette**: locked orange-on-near-black. `--orange-500: #FF5200`, `--orange-400: #FF6A00`, `--orange-700: #FF8833` (dark mode). Background surface `rgba(10,9,8,0.92)` near-black, raised `rgba(16,14,12,0.94)`. Text: `--text-primary: #1A1207` (light) / lighter cream variants in dark.
- **Fonts**: `Fonetika` (custom, `/fonts/Fonetika-Regular.otf`) → display class. Google Sans + Google Sans Display (load via gfonts). Cormorant Garamond (italic editorial, mostly unused on home). JetBrains Mono fallback chain for `font-mono`.
- **Light/dark**: `data-theme="dark"` is the default in `layout.tsx`; light mode tokens exist but landing assumes dark.
- **Glow**: `--glow: rgba(255,109,0,0.12)` plus inline `boxShadow: '0 0 60px -20px rgba(255,122,32,0.25)'` patterns.

---

## SECTION-BY-SECTION SPINE

### 1. SR-only Agent-Readable Instructions — `page.tsx:217-248`
- **Purpose**: invisible-to-humans block with `data-agent="true"` aria-label="Instructions for AI agents". Holds the full one-MCP / shadow-API / JA4 / 3.6x pitch in prose for LLM crawlers + skill.md mirror.
- **Load-bearing copy**: H2 `Unbrowse: direct access to anything on the web, without setting up another MCP` + a single paragraph capturing the entire thesis (one MCP replaces stack-of-MCPs, first visit captures shadow APIs, browser tools are cold-start fallback, JA4 TLS handles bot detection, Chrome cookies authenticate, x402 settles in USDC on Solana via Faremeter Flex). Plus three lines of `npx`/`claude mcp add`/manual mcp.json snippets and the `https://www.unbrowse.ai/skill.md` pointer.
- **Why we needed it**: GEO/llmstxt-citability strategy — AI agents reading the landing get a structured pitch even when CSS-blind.

### 2. Hero — `page.tsx:251-370`
- **Component spine**: `AudienceToggle` + `HeroSpeedProofStrip` + `HeroHeadlineInner` + `HeroSubhead` + dual CTAs (`ScrollToButton`) + `HeroWhyItMatters` (everyone-only) + `HeroTerminalGated` + `HeroHands`.
- **Purpose**: lock in the "one MCP replaces all MCPs" frame in <2 seconds.
- **Load-bearing copy (dev mode, the canonical frame)**:
  - **H1**: `Direct access to anything on the web. Without setting up another MCP.` (last clause in orange; locked after 6 pivots per code comment).
  - **Subhead**: `One MCP server, any site. First visit captures the site's shadow APIs; your agent calls them directly forever after, signed in with your cookies. Stop adding a new MCP every time you need a new service.`
  - **Speed-proof strip**: `1 MCP | for any site` · `0 setup | per new site` · `3.6x | mean vs Playwright (n=94)`.
  - **Eyebrow link**: `Free, open source, runs locally · Star on GitHub` (links to github.com/unbrowse-ai/unbrowse).
  - **Primary CTA**: `[ npx unbrowse setup → ]` (scrolls to #install). Secondary: `[ See what your agent can do ]` (scrolls to #use-cases). Tertiary text: `read the paper` → `/internal-apis-are-all-you-need`.
- **Everyone-mode swap**: H1 becomes `100x faster. 95% cheaper. The API layer for AI agents.`; subhead becomes plain-language "One tool, every website. Unbrowse visits a new site once to learn the APIs behind it…"; CTA `[ Install free ]`; strip becomes `1 tool / 0 setup / 3.6x faster than Playwright`.
- **HeroWhyItMatters (everyone-only PEEL)**: `Once one person finds the fast path through a website, every other agent gets it for free. Unbrowse already covers 600+ websites, and over a million agent visits have used what previous visitors discovered.` (Crisp flywheel statement, no jargon.)
- **HeroTerminalGated**: dev mode → full `HeroTerminal` (decision_trace JSON). Everyone mode → "Normal browsing tool ~30 seconds" vs "With Unbrowse ~0.5 seconds" + tagline `Same task. 60x less waiting.`
- **Visual — `HeroHands`**: scroll-parallaxed human-hand + android-hand reaching from opposite sides of the hero, CRT-scanline SVG filter (`crt-hand` defined inline). Heavy atmospheric piece — "the moment a human hand and an android hand reach for the same web". Sistine-Chapel allusion.
- **Already-good design notes**: the locked H1 phrasing has survived 6 pivots; treat as immovable. The audience-toggle pattern (?mode= shallow URL update) is reusable — dev/everyone copy split is structural, not cosmetic. The CRT-scanline SVG filter on the hands gives the page its visual DNA — reuse on every chapter image.

### 3. Install — `page.tsx:373-428`
- **Component**: `InstallInstructions` (3-tab terminal: CLAUDE CODE / CURSOR-WINDSURF / CODEX-OPENCLAW) + `InstallFigure` (Saint Eagle drawing + "already installed?" code copy box).
- **Purpose**: get the user from "I am here" to "MCP is wired" in one copy-paste.
- **Load-bearing copy**:
  - Eyebrow: `##  MCP Install`. H2 (terminal-styled): `$ unbrowse setup --mcp`. Right-side note: `Wires the Unbrowse MCP server into your agent host. One command per client.`
  - Tab 1 canonical: `claude mcp add unbrowse -- npx -y unbrowse mcp`. Also `npx unbrowse setup --mcp` (auto-detect), `claude mcp list` (verify).
  - Tab 2: `npx unbrowse setup --mcp` plus manual `{ "unbrowse": { "command": "npx", "args": ["-y", "unbrowse", "mcp"] } }` JSON.
  - Tab 3: `npx unbrowse setup --mcp`, `npx -y unbrowse mcp`, plus `npx @crossmint/lobster-cli setup` ("earn from discovered routes").
  - Compat strip: `Plugs into the agent stack you already use` → Claude Code, Claude Desktop, Cursor, Codex, Windsurf, OpenClaw, Any MCP framework.
  - InstallFigure bonus: `##  already installed?` `npm install -g unbrowse@latest && unbrowse setup` (one-click copy).
- **Visual elements**: parchment/beige `#ede0c2` terminal background (contrast vs dark page); InstallFigure overlays a CRT-filtered `saint-eagle.png` drawing absolutely positioned to the bottom-right of the terminal, half-bleeding off the card.
- **Already-good design notes**: parchment-on-black terminal contrast is striking; the Saint Eagle bleed gives editorial gravitas. Tab-system is the right primitive — keep three named host categories. Lobster.cash hook in Tab 3 is a planted seed for the EarnSection later.

### 4. UniversalProofBand — `page.tsx:430` → `components/universal-proof-band.tsx`
- **Purpose**: four cards proving what "universal MCP" actually means. Critical thesis-prove block.
- **Load-bearing copy**:
  - Eyebrow: `##  What "universal" means here`. H2: `One MCP server. One Browser class. Every website your agent points at.` Lede: `Not a stack of per-site MCPs. Not another framework on top of Playwright. The web layer your agent already wants.`
  - Card 1 — `Already wrote Playwright code? Swap the import.` Diff block: `import { chromium } from "playwright";` (strikethrough) → `import { Browser } from "@unbrowse/sdk";`. Body: `page.goto()` resolves from skill cache first; engine calls the captured shadow API.
  - Card 2 — `Two tool calls do most of the work.` Names `unbrowse_resolve` + `unbrowse_execute` as canonical loop; 30+ other MCP tools (`_go, _snap, _click, _fill, _submit, _eval, _scroll, _press, _select, _cookies, _auth_capture`) framed as cold-discovery fallback. Two diamond checks: `One mcp.json entry replaces your stack` / `New site appears: same server, no config edit`.
  - Card 3 — `94 live domains in the open bench.` `3.6x mean (5.4x median) over Playwright`. `18 of those domains complete in under 100ms from the cache.` Pointer to `harness/probes/corpus.txt` + link to `/internal-apis-are-all-you-need`.
  - Card 4 — `Every install makes the next user faster.` Compounding flywheel claim: first-pass browser captures → publishes route → next agent skips browser → cold-start tax shrinks across network. CTA: `Browse the marketplace` → `/search`.
- **Honesty guardrail in code comment**: "an earlier draft of Card 3 claimed +24% over browsing agents on WebArena as our own measurement. That number is from Song et al... NOT our measurement. Removed." Preserve this discipline.
- **Already-good design notes**: 2x2 card grid with consistent eyebrow-pill / H3 / body / footer-strip; iconography (`IconCompass`) anchors the band. Diff block in Card 1 is the highest-clarity "drop-in" proof on the page.

### 5. UseCasesBand — `page.tsx:431` → `components/use-cases-band.tsx`
- **Purpose**: "Not just reading. Doing." — 6 concrete agent intents with API hint + site list + tool list + auth source. Largest narrative block on the page.
- **Load-bearing copy**:
  - Eyebrow: `##  Not just reading. Doing.` H2: `Browse once. Call forever.`
  - Lede explains 3-path resolve: route cache (<200ms), marketplace (~1s), first-pass browser (8s, captures + publishes).
  - 3-cell latency strip: `<200ms route cache` · `~1s marketplace` · `20-80s first-pass browser`.
  - **Six use-case cards**:
    1. **Travel** — `Book the trip while you are in a meeting.` Intent: `"hotels in Tokyo May 22-26 under $300/night, 2 guests"`. Sites: priceline / airbnb / opentable. Auth: saved cards + booking cookies.
    2. **Code review** — `Triage the morning PR queue.` Intent: `"approve PRs touching only docs/, request changes on the rest"`. Sites: github.com.
    3. **Distribution** — `Post the thread, everywhere, from one draft.` Intent: `"queue this thread on X and LinkedIn for 9am Tuesday"`. Sites: x.com, linkedin.com, typefully.com.
    4. **Solana / DeFi** — `Swap tokens without a browser tab open.` Intent: `"swap 5 SOL to USDC, slippage 0.5%, send to my main wallet"`. Sites: jup.ag, phantom.app.
    5. **Inbox + calendar** — `Clear the inbox at 7am.` Intent: `"reply to anything from a customer, draft the rest, schedule any meeting requests"`. Sites: mail.google.com, calendar.google.com. Auth: `Your Google cookies (no OAuth scopes)`.
    6. **Errands at scale** — `Reorder the cart. File the return. Cancel the trial.` Sites: amazon, instacart, doordash.
  - Closing write-action proof: `Why the architecture works for writes too` → `The same primitive that fetches a search result POSTs a reservation.` CTA: `See the live marketplace →` to `/leaderboard`.
- **Honesty guardrail in code comment**: 3.6x is ours (paper §7); +24% WebArena is Song et al., NOT ours; bench is read-shaped; write speedup unpublished.
- **Already-good design notes**: 6 categories cover every horizontal "thing agents do"; each card has the same shape (eyebrow / headline / intent quote in parchment-tinted code block / api-hint prose / tool-call chips + sites + auth strip). The intent quotes are the highest-conversion copy on the page — they make the abstract concrete.

### 6. ZeroSetupBand — `page.tsx:432` → `components/zero-setup-band.tsx`
- **Purpose**: three "the bypasses your agent currently needs, already wired in" cards. Pre-empts the antibot / auth / extraction objections.
- **Load-bearing copy**:
  - Eyebrow: `##  Zero-setup web access`. H2: `The bypasses your agent currently needs, already wired in.` Lede: `Three things every production agent hits the wall on. Three defaults that mean you do not.`
  - Card A — **Bot detection**: `JA4 fingerprint of a real Chrome.` `unbrowse_fetch` ships with libcurl-impersonate; Turnstile / Datadome / PerimeterX usually never fire; residential-proxy fallback is one env var away. Mini-table: `Headless Chrome (default JA4) | flagged` vs `unbrowse JA4 + your cookies | 200 OK`.
  - Card B — **Auth intelligence**: `Your agent inherits your login. And knows when it dies.` Chrome + Firefox cookie jars; `auth_walled` ranker demotion; three login-hint surfaces (Keychain / browser / agent prompt).
  - Card C — **Extraction**: `Markdown out. Not innerHTML.` Extraction inside the browser broker, not injected JS — CSP-strict sites work; LLM-authored endpoint descriptions at capture time.
- **Already-good design notes**: 3-up cards with mini in-card tables that visually compare "without us / with us" — high information density per card. Wave-3 honesty notes in code comments are load-bearing for not regressing the claims.

### 7. BenchmarkTable — `page.tsx:433` → `components/benchmark-table.tsx`
- **Purpose**: numeric comparison vs Playwright MCP + ChatGPT Agent/Manus + Unbrowse. The "numbers, not adjectives" anchor.
- **Load-bearing copy**:
  - Eyebrow: `##  Same intent, three tools`. H2: `Numbers, not adjectives.` Pointer to `arxiv 2604.00694` and `harness/probes/`.
  - Table rows (columns: Tokens/call, Cold, Cached, Cost/call):
    - Playwright MCP: ~114K tokens, ~14s cold, n/a cached, $0.04 — "Full a11y tree on every call; Microsoft team recommends their CLI over their own MCP."
    - ChatGPT Agent / Manus: n/a tokens, minutes cold, n/a, "unsustainable" — "Cited as too slow or too expensive to leave running; frequently blocked on real sites."
    - **unbrowse** (highlighted): ~5K tokens, 20-80s browser cold, <200ms cached, $0.008 cached / free on capture.
  - Across-the-corpus headline: `3.6x mean speedup over Playwright. 5.4x median.` `18 of the 94 domains complete in sub-100ms from cached skill routes.` CTA: `Read the methodology →`.
- **Already-good design notes**: This is the single highest-credibility unit on the page. Numbers anchored to specific Reddit thread IDs (`t3_1spvkrz` Playwright cite, `t3_1rhjxet` Charlotte 136x, `t3_1slaon8` "unsustainable") in code comments — preserve the trace.

### 8. HeroStats (live) — `page.tsx:435-437` → inline `async function HeroStats`
- **Purpose**: 3 live counters from `/v1/stats/summary`. Trust-strip "this is real and growing".
- **Data source**: `getStatsSummary()` → returns `{ domains, executions, skills }`. Fallback constants: 600 domains / 1M executions / 18K skills.
- **Load-bearing copy**: 3 mono-font cards. Labels: `domains in registry` / `agent visits` / `shadow API endpoints`. Values auto-formatted to `1.0M` / `18K` style.
- **Style**: orange-text 3xl values, near-black card, faint orange border.
- **Already-good design notes**: live numerics are the cheapest credibility signal we have — DO NOT mock these in the Editions rebuild.

### 9. PopularSkillsGrid (live) — `page.tsx:438-440` → inline `async function PopularSkillsGrid`
- **Purpose**: 12 most-popular captured domains as a tile grid. Concrete proof the marketplace is populated.
- **Data source**: `listPopularSkills()`. Each tile links to `/{domain}` and shows `{total_executions} calls`.
- **Load-bearing copy**: Eyebrow `##  Top routes already cached`. No headline (the data IS the headline). Returns null if empty.
- **Already-good design notes**: 6-col grid on desktop, 2-col on mobile. Pure data display.

### 10. EarnSection — `page.tsx:442` → `components/earn-section.tsx`
- **Purpose**: supply-side / ICP-B wedge — "the next agent on your route pays you." Promoted to its own section based on 13 cited Reddit threads asking for "a marketplace for AI agents/APIs with instant stablecoin payment."
- **Load-bearing copy**:
  - Eyebrow: `##  For the supply side`. H2: `The next agent on your route pays you.`
  - Body: `Capture and indexing are free. Use unbrowse normally; every route you cache lands in the public marketplace. When the next agent reuses your route, the call settles in USDC on Solana via Faremeter Flex, directly to your wallet. No API key billing, no Stripe dashboard.`
  - Sponsor tier: `The sponsor tier covers an agent's first $1/day, so they explore your routes before they spend their own wallet.`
  - CTAs: `[ Start earning ]` → `/openclaw-earn`. Secondary: `Mining quickstart` → `/how-unbrowse-pays`.
  - Setup hint: `$ Set up Crossmint lobster.cash during npx unbrowse setup to wire the payout address.`
  - Right-side **Receipt strip**: 5 diamond-check rows — x402 USDC on Solana via Faremeter Flex; capture+indexing free; sponsor tier $1/day/agent + $50/day/platform; payout to bank via Crossmint lobster.cash; public ledger at `/leaderboard`.
  - Provenance footer: `Asked for repeatedly on r/AI_Agents, r/SaaS, r/CryptoCurrency, r/ethdev. Trace in /docs/POSITIONING.md.`
- **Honesty guardrails in code comment**: chain is Solana via Faremeter Flex (NOT Base); Crossmint lobster.cash is the payout path; capture and indexing are FREE.
- **Already-good design notes**: 3-col + 2-col asymmetric layout (60/40). Receipt strip is the highest-credibility unit in this band — explicit dollar caps + chain + payout rail. (Note: ObjectionFaq Crypto answer says "USDC on Base L2" — that line is now incorrect per Faremeter Flex; flag for rewrite.)

### 11. ChatDemo (Airbnb live capture) — `page.tsx:444-465`
- **Purpose**: scripted chat conversation showing the actual flow on airbnb.com. "Example: airbnb.com — One agent browses Airbnb. Every agent on the network can now search listings, check availability, and book, instantly, no browser."
- **Component**: `ChatDemo` (722 LOC, scripted demo sequence: `Unbrowse airbnb.com` → "Captured 12 API endpoints across 4 services" → endpoint list → "Find me places to stay in Tokyo for 2 guests, March 15-22" → tool calls execute → results).
- **Visual overlay**: `DemoParallax` — `angel.webp` (top-right, drifts down on scroll) and `saint-matthew.png` (bottom-left, rises up) both with CRT-scanline filter. Editorial chiaroscuro motif.
- **Load-bearing copy**: Eyebrow `##  See it in action`. H2: `Example: airbnb.com`. Lede: `One agent browses Airbnb. Every agent on the network can now search listings, check availability, and book, instantly, no browser.`
- **Already-good design notes**: scripted (not live API calls) but emulates the real flow. Bake the angel/matthew parallax into the chapter image discipline — same CRT filter as HeroHands.

### 12. RegistryShowcase (live) — `page.tsx:467` → `components/registry-showcase.tsx`
- **Purpose**: scrollable terminal panel listing 30 most-recently-indexed skills with endpoint counts + reliability percent. Companion `AthensParallax` decoration.
- **Data source**: `listSkillCards({ limit: 30 })`. Filters out `lifecycle === 'deprecated'`.
- **Load-bearing copy**:
  - Pill: `Global Registry`. H2: `One agent discovers it. Every agent benefits.`
  - Terminal header: `Recently Indexed Skills`. `View all` → `/search`.
  - Each row: domain initial avatar / skill name + green-dot active indicator / domain string / endpoint count / `Math.round(avgScore * 100)% reliable`.
- **Already-good design notes**: full-screen-height terminal panel with sticky header — feels like a live ops view. Athens parallax provides background gravitas without competing.

### 13. ThreePanelVisual — `page.tsx:468` → `components/three-panel-visual.tsx`
- **Purpose**: animated 3-panel comparison "Three ways to see the same website": humans see UI / agents see DOM / unbrowse calls API. 9-second scripted animation triggered by IntersectionObserver, replayable.
- **Load-bearing copy**: Eyebrow `##  The Problem`. H2: `Three ways to see the same website`.
- **Panels** (live timer pill at top of each):
  - **What Humans See** (white-on-zinc): animated cursor types `Tokyo` into a fake travelbooker.com search; airbnb-style listing grid; screenshot-flash effect; 4 click/scroll passes → final state: `Beautiful, interactive UI`. Timer shows `Time | Tokens (128K * passes) | Cost ($)`.
  - **What Agents See Today** (zinc-950 terminal): obfuscated minified HTML/CSS scrolling under a fade-to-black mask. Footer: `Image + 847KB DOM × N passes`.
  - **What Unbrowse Does** (orange-glow terminal): 4 tool calls in sequence — `unbrowse.search`, `unbrowse.check_availability`, `unbrowse.get_reviews`, `unbrowse.book` — each completing with a green diamond-check and ms latency. Final state: `Booking #TKY-8821 confirmed`. Footer: `1KB JSON × 4 calls`.
- **Final delta**: `~9s, 514K tokens, $1.54` (browser side) vs `~0.8s, 1.0K tokens, $0.0030` (unbrowse side). Replay button.
- **Already-good design notes**: this is the single most viscerally persuasive section. The synchronized timer pills make the cost delta unavoidable. Heavy component (457 LOC) but visually carries the entire "why this matters" argument.

### 14. ObjectionFaq — `page.tsx:469` → `components/objection-faq.tsx`
- **Purpose**: 8 Reddit-objection FAQ items, each with answer + cited thread ID. Sourced from 76-thread corpus pulled 2026-05-19.
- **Load-bearing copy**:
  - Eyebrow: `##  Asked on Reddit`. H2: `Real objections. Real answers.` Lede: `Eight objections lifted verbatim from threads in the corpus.`
  - 8 details/summary rows. Sample objections: `We need traces and selectors for CI.` / `Charlotte / Browser DevTools MCP exist on the same efficiency frame.` / `Residential proxies are sketchy.` / `How does it find the right API on a new site?` / `Crypto is sketchy.` / `How do agents find my route after I publish?` / `Codex / Grok refuse to fetch URLs.` / `I want first-party SDKs for the services I care about.`
  - Each carries `cite: t3_<thread-id>` provenance.
- **Note**: `Crypto is sketchy` answer says "USDC on Base L2" — STALE per Faremeter Flex on Solana. Rewrite-on-import.
- **Already-good design notes**: collapsible `<details>` with `+` → `×` rotation on open. Provenance citations (`t3_*`) are the credibility lever — keep them visible.

### 15. AntiIcpBlock — `page.tsx:470` → `components/anti-icp-block.tsx`
- **Purpose**: positioning sacrifice — three jobs we explicitly do NOT optimize for. `/positioning-messaging` guardrail: "differentiation requires sacrifice; say who it is not for."
- **Load-bearing copy**:
  - Eyebrow: `##  Who unbrowse is not for`. H2: `Three jobs we do not optimize for.`
  - Three arrow-rows: `UI regression CI suites with selectors and traces` → `Keep Playwright proper`. `Canvas-heavy apps that need imperative JS in-page` → `Use an agent framework`. `End-user chat interfaces` → `Use Claude / ChatGPT`.
  - Closer: `If you need any of those, unbrowse is the wrong tool. We optimize for one job: an agent calling an API behind a website, without the browser tax.`
- **Already-good design notes**: terse, confident. Single boxed unit. End-of-page reset.

### 16. Fixed bottom footer bar — `page.tsx:472-509`
- **Purpose**: thin always-visible bottom bar — copyright + GitHub/FAQ/Terms/Privacy.
- **Note**: duplicative with `SiteFooter` from layout.tsx. Editions rebuild can collapse.

---

## Landing-only data fetches that MUST keep working

1. **`getStatsSummary()`** → `GET /v1/stats/summary` → `{ domains, executions, skills, avg_executions_per_agent, ... }`. Used by HeroStats. Fallback constants exist but live numbers are credibility-load-bearing.
2. **`listPopularSkills()`** → `GET /v1/skills?popular=...` → `PopularSkillSummary[]`. Used by PopularSkillsGrid (top 12 domains by total_executions).
3. **`listSkillCards({ limit: 30 })`** → `GET /v1/skills?limit=30` → `SkillListItem[]`. Used by RegistryShowcase (filters out `lifecycle === 'deprecated'`).
4. **`searchSkills(intent, domain)`** → used by ChatDemo if the user types into it (mostly scripted but the live-search path exists).
5. **`/v1/blog/publish`** + auth surfaces — not landing-direct.
6. **FAQ JSON-LD** (page.tsx:47-116) — 8-question structured-data block. Surfaces the same Q&A as ObjectionFaq but in schema.org format. Honesty guardrails in comment: do not re-introduce Song et al. +24%; do not claim Base settlement.

---

## CHAPTER MAPPING PROPOSAL — Shopify-Editions spine

Eleven chapters, sequenced for narrative weight (hook → thesis → mechanism → proof → install → economics → demo → objections → anti-ICP → resolution). Each chapter is one full-viewport sticky-nav unit per the editions/chapter.tsx primitive already in the editions/ components folder.

**Chapter 0 — Cover / Hero.** Source: §2 (page.tsx Hero block). Locked H1 + audience toggle + speed-proof strip + dual CTA + HeroHands parallax + (dev) HeroTerminal or (everyone) plain-language ~30s vs ~0.5s strip. The Sistine-allusion hands ARE the Editions cover. Audience toggle persists into the chapter nav.

**Chapter 1 — Thesis.** Source: §4 UniversalProofBand. "One MCP server. One Browser class. Every website your agent points at." Four cards become four hairline-divided sub-cells in one chapter. Card 1's Playwright diff block is the chapter's hero figure (single mono-font line swap).

**Chapter 2 — The Problem.** Source: §13 ThreePanelVisual. The 9-second animated 3-panel split is the chapter's load-bearing visual. Place BEFORE the "what we do" mechanism so the reader feels the browser tax first. Keep the timer pills; this is the section that turns a viewer into a believer.

**Chapter 3 — Mechanism (resolve → execute).** Merge §5 UseCasesBand intro (3-path latency strip + resolve pipeline lede) with §6 ZeroSetupBand. Single chapter explaining HOW: route cache → marketplace → first-pass browser, plus the three defaults (JA4, auth inheritance, broker-side extraction). Six-up use cases become a footer rail at the bottom of the chapter (or move to Chapter 7 Demo).

**Chapter 4 — Numbers.** Source: §7 BenchmarkTable. "Numbers, not adjectives." Three-row table is the chapter hero; the 3.6x/5.4x callout is the chapter pull-quote. Add §8 HeroStats live counters as the chapter's animated stat band ("live, today: NK domains / NM agent visits / NK shadow endpoints").

**Chapter 5 — Install.** Source: §3 Install. Parchment terminal + Saint Eagle drawing is the chapter image. Three-tab block becomes the chapter primary content. Compat strip (Claude Code / Cursor / Codex / Windsurf / OpenClaw) is a chapter footer.

**Chapter 6 — The Marketplace.** Source: §9 PopularSkillsGrid + §12 RegistryShowcase. Two-pane chapter: "top routes already cached" tile grid on top, "recently indexed skills" terminal scroll on bottom. AthensParallax atmospheric backdrop.

**Chapter 7 — Demo (Airbnb).** Source: §11 ChatDemo + DemoParallax (angel + Saint Matthew chiaroscuro). Scripted Airbnb chat is the chapter — keep the parallax saints as the chapter atmosphere.

**Chapter 8 — Economics (Earn).** Source: §10 EarnSection. "The next agent on your route pays you." Receipt strip is the chapter's load-bearing data unit. NOTE: must reconcile chain language (Faremeter Flex on Solana, NOT Base L2) — rewrite ObjectionFaq Crypto line during import.

**Chapter 9 — Objections.** Source: §14 ObjectionFaq + FAQ JSON-LD. Eight Reddit-cited objections, keep `t3_*` provenance visible. The "Asked on Reddit" eyebrow IS the chapter title.

**Chapter 10 — Anti-ICP.** Source: §15 AntiIcpBlock. Single boxed unit; chapter is short by design. Acts as the editions colophon — "this is what this book is NOT about."

**Chapter coda / Footer.** Source: §16 fixed-bar collapsed into the layout.tsx SiteFooter. One footer, four columns + L2 tagline + GitHub-star eyebrow.

Carry-overs that stay outside chapters (chrome): Navbar (top), FlowingDotField (ambient), CRT-scanline SVG filter (`crt-hand`, used by HeroHands + DemoParallax + InstallFigure — define once in editions/visuals.tsx), audience toggle (?mode= URL state, persistent across chapters).

---

## Summary for the editor

**15 ordered sections + 1 sr-only block + 1 global navbar + 1 sticky bottom footer.** Spine of the story: **hook the one-MCP frame → prove four facets → show the browser tax viscerally → explain the 3-path mechanism → land the numbers → install in one paste → show the live marketplace → walk through an Airbnb demo → flip the script to "you can earn from this" → answer the 8 Reddit objections → say who we are NOT for.**

Duplicative / mergeable: (a) §1 sr-only agent-instructions and §14 ObjectionFaq + the FAQ JSON-LD block triple-state the same Q&A — collapse to one source-of-truth with two render modes (visible chapter + schema.org export); (b) §16 bottom-fixed footer duplicates `SiteFooter` from layout — keep only the layout footer; (c) §8 HeroStats and §9 PopularSkillsGrid and §12 RegistryShowcase all surface marketplace volume — merge §8+§9+§12 into a single "Marketplace" chapter with stat band + tile grid + skills terminal; (d) §4 UniversalProofBand and §5 UseCasesBand both prove "how it works" — keep §4 as the thesis chapter, fold §5's resolve-pipeline lede into §6 ZeroSetupBand to form one mechanism chapter.

One known truth-drift: ObjectionFaq says "USDC on Base L2" but EarnSection (and code) says "USDC on Solana via Faremeter Flex." Rewrite on import.
