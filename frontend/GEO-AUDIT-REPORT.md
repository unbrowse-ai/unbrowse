# GEO Audit Report: unbrowse.ai

**Date:** March 9, 2026
**URL:** https://unbrowse.ai
**Business Type:** SaaS (Developer Tool for AI Agents)
**Framework:** Next.js (App Router) on Cloudflare Workers via OpenNext

---

## Composite GEO Score: 35/100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| AI Citability & Visibility | 34/100 | 25% | 8.5 |
| Brand Authority Signals | 33/100 | 20% | 6.6 |
| Content Quality & E-E-A-T | 52/100 | 20% | 10.4 |
| Technical Foundations | 52/100 | 15% | 7.8 |
| Structured Data | 5/100 | 10% | 0.5 |
| Platform Optimization | 29/100 | 10% | 2.9 |
| **TOTAL** | | | **36.7** |

**Rating: Poor** -- The site is largely invisible to AI search engines despite having a product built specifically for AI agents.

---

## The Paradox

Unbrowse is a tool designed to help AI agents interact with websites. Yet its own website **blocks every major AI crawler** from accessing its content. The robots.txt (Cloudflare managed) disallows GPTBot, ClaudeBot, Google-Extended, CCBot, Bytespider, Applebot-Extended, Amazonbot, and meta-externalagent. This is the single most damaging finding in this audit.

The site has excellent SSR rendering, a dedicated `<section data-agent="true">` for AI consumption, custom `ai-skill` and `ai-plugin` meta tags, and an llms.txt file -- all of which are rendered useless by the crawler blocks.

---

## Category Breakdown

### 1. AI Citability & Visibility (34/100)

| Component | Score |
|-----------|-------|
| Citability | 52/100 |
| Brand Mentions | 33/100 |
| Crawler Access | 10/100 |
| llms.txt | 35/100 |

**Citability (52/100):** The homepage has some quotable passages -- the "100x faster, 40x fewer tokens" comparison scores 72/100 for citation readiness. However, no canonical "What is Unbrowse?" definition block exists. No FAQ section. Content is marketing-oriented rather than informational, making it harder for AI to cite as a factual source.

**Brand Mentions (33/100):** GitHub (473 stars, 35 forks) is the only meaningful brand signal. Zero presence on Reddit, YouTube, Stack Overflow, Product Hunt, Dev.to, or Wikipedia. Two low-engagement Hacker News posts. One third-party LinkedIn mention. No Wikipedia or Wikidata entity.

**Crawler Access (10/100):** All 8 named AI crawlers are blocked. PerplexityBot and OAI-SearchBot are not explicitly blocked (inherit wildcard Allow), providing minimal coverage. No sitemap exists for any crawler.

**llms.txt (35/100):** File exists but is minimal. Missing blockquote description, link descriptions are sparse, no `/llms-full.txt` companion file.

### 2. Brand Authority Signals (33/100)

| Platform | Status |
|----------|--------|
| Wikipedia | Absent |
| Reddit | Absent |
| YouTube | Absent |
| LinkedIn | 1 third-party mention, no company page |
| Hacker News | 2 posts, minimal engagement |
| GitHub | 473 stars, 35 forks (strongest signal) |
| npm | 410 weekly downloads |
| Stack Overflow | Absent |
| Product Hunt | Absent |
| Smithery.ai | Listed as MCP server |

### 3. Content Quality & E-E-A-T (52/100)

| Dimension | Score |
|-----------|-------|
| Experience | 14/25 |
| Expertise | 12/25 |
| Authoritativeness | 9/25 |
| Trustworthiness | 12/25 |

**Strengths:** Genuine product with real demo data (Airbnb API endpoints). Content reads as human-written. Specific performance claims with concrete numbers. Open source codebase for verification.

**Weaknesses:** Zero author/team information anywhere on the site. No about page. No blog or thought leadership content. No user testimonials or case studies. No contact information on homepage. Privacy policy exists but is not linked from navigation. The entire site is essentially a single landing page.

### 4. Technical Foundations (52/100)

| Area | Score | Status |
|------|-------|--------|
| Server-Side Rendering | 85/100 | PASS |
| Meta Tags & Indexability | 35/100 | FAIL |
| Crawlability | 20/100 | FAIL |
| Security Headers | 25/100 | FAIL |
| Core Web Vitals Risk | 55/100 | WARN |
| Mobile Optimization | 80/100 | PASS |
| URL Structure | 90/100 | PASS |

**Strengths:** Excellent SSR -- full content rendered server-side. Clean URL structure. Good mobile optimization with responsive Tailwind classes.

**Critical Issues:**
- No canonical tags on any page
- No XML sitemap (404)
- No Open Graph or Twitter Card meta tags
- Double redirect chain (http -> https -> www)
- All security headers missing except HTTPS
- Meta description too long (176 chars, will truncate)
- Duplicate H1 tags on homepage
- `X-Powered-By: Next.js` header exposed
- 4 font families loaded (excessive)
- Google Fonts CSS loaded twice

### 5. Structured Data (5/100)

**Zero structured data on the site.** No JSON-LD, no Microdata, no RDFa.

Missing schemas (priority order):
1. **Organization** with sameAs (GitHub, X/Twitter, npm) -- Critical for entity recognition
2. **SoftwareApplication** with offers (free), features, category -- Critical for product identity
3. **WebSite** with SearchAction for /search -- Enables sitelinks search box
4. **BreadcrumbList** -- Navigation context for crawlers
5. **speakable** -- AI assistant readiness (the existing `#agent-instructions` section is a perfect target)

### 6. Platform Optimization (29/100)

| Platform | Score | Status |
|----------|-------|--------|
| Google AI Overviews | 32/100 | Poor |
| Perplexity AI | 33/100 | Poor |
| ChatGPT Web Search | 24/100 | Poor |
| Bing Copilot | 23/100 | Poor |
| Google Gemini | 22/100 | Poor |

**Cross-platform issues:**
- No entity in any knowledge base (Wikipedia, Wikidata)
- No community footprint (Reddit, forums)
- No ecosystem presence (YouTube, LinkedIn, Google News)
- No structured data for any platform to parse
- No question-based content for AI Overviews extraction
- No IndexNow protocol for Bing/Copilot

---

## Prioritized Action Plan

### Quick Wins (Low Effort, High Impact)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 1 | **Unblock AI search crawlers in robots.txt** -- Allow OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot. Keep `ai-train=no` content signal if desired. | Critical | 15 min |
| 2 | **Add canonical tags** to all pages via Next.js metadata `alternates.canonical` | Critical | 30 min |
| 3 | **Create XML sitemap** via `app/sitemap.ts` covering all public pages + dynamic skill pages | Critical | 1 hr |
| 4 | **Add Open Graph + Twitter Card meta tags** to layout.tsx metadata export | High | 30 min |
| 5 | **Add Organization + SoftwareApplication JSON-LD** to layout.tsx | High | 1 hr |
| 6 | **Fix duplicate H1** -- consolidate to single H1 on homepage | High | 10 min |
| 7 | **Add a "What is Unbrowse?" definition block** -- 2-3 sentence self-contained paragraph after H1 | High | 15 min |
| 8 | **Trim meta description** to 155 chars, update install command | Medium | 10 min |
| 9 | **Remove X-Powered-By header** -- set `poweredByHeader: false` in next.config.ts | Low | 5 min |
| 10 | **Fix double redirect** -- direct all variants to `https://www.unbrowse.ai` in one hop | Medium | 30 min |

### Medium-Term (1-4 Weeks)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 11 | **Add security headers** (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) via Cloudflare or Next.js headers config | High | 2 hrs |
| 12 | **Rewrite llms.txt** with blockquote description, substantive link descriptions, and create `/llms-full.txt` | High | 2 hrs |
| 13 | **Create an About page** with founder/team info, company story, credentials | Critical | 3 hrs |
| 14 | **Add an FAQ section** to homepage with 5-8 common questions (targets AI Overview extraction) | High | 2 hrs |
| 15 | **Add question-based H2/H3 headings** ("What is Unbrowse?", "How does it work?", "How is it different?") | High | 2 hrs |
| 16 | **Link privacy policy** from homepage footer/navigation | Medium | 15 min |
| 17 | **Create a Wikidata entry** for Unbrowse (instance of: software, official website, source code repository, license, programming language) | High | 1 hr |
| 18 | **Create a LinkedIn company page** for Unbrowse with complete info | Medium | 1 hr |
| 19 | **Implement IndexNow** for Bing/Copilot instant indexing | Medium | 1 hr |
| 20 | **Optimize font loading** -- reduce from 4 families, fix duplicate CSS link | Medium | 1 hr |

### Strategic (1-3 Months)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 21 | **Build a technical blog** with 5-10 articles (architecture deep-dives, benchmarks, comparisons, use cases) | Critical | Ongoing |
| 22 | **Seed Reddit discussions** in r/ClaudeAI, r/LocalLLaMA, r/cursor, r/webdev, r/programming | High | Ongoing |
| 23 | **Create YouTube content** -- 3-5 demo/explainer/comparison videos | High | 2-4 weeks |
| 24 | **Launch on Product Hunt** | High | 1 week prep |
| 25 | **Build comparison pages** (vs Playwright, vs Puppeteer, vs Browserbase, vs Apify) | High | 1 week |
| 26 | **Create integration guides** for each platform (Claude Code, Cursor, Windsurf, OpenClaw) | Medium | 1 week |
| 27 | **Build topical content cluster** -- 10+ interlinked pages covering AI agent web automation | High | Ongoing |
| 28 | **Pursue press coverage** from tech publications (The New Stack, InfoQ, Hacker Noon) | High | Ongoing |
| 29 | **Publish benchmark methodology** for "100x faster, 40x fewer tokens" claims | Medium | 3 hrs |
| 30 | **Add user testimonials** from real developers using the tool | Medium | Ongoing |

---

## Recommended JSON-LD (Ready to Implement)

### Organization Schema

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Unbrowse",
  "legalName": "Unreel AI Pte Ltd",
  "url": "https://www.unbrowse.ai",
  "logo": "https://www.unbrowse.ai/logo.png",
  "description": "Unbrowse reverse-engineers any website into reusable API skills for AI agents. 100x faster than headless browsers, 40x fewer tokens.",
  "sameAs": [
    "https://github.com/unbrowse-ai",
    "https://github.com/unbrowse-ai/unbrowse",
    "https://x.com/getFoundry",
    "https://www.npmjs.com/package/unbrowse"
  ]
}
```

### SoftwareApplication Schema

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Unbrowse",
  "description": "Reverse-engineer any website into reusable API skills for AI agents. Auto-discovers undocumented website APIs and converts them to clean, direct API calls.",
  "url": "https://www.unbrowse.ai",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "macOS, Linux, Windows",
  "downloadUrl": "https://www.npmjs.com/package/unbrowse",
  "codeRepository": "https://github.com/unbrowse-ai/unbrowse",
  "isAccessibleForFree": true,
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "featureList": [
    "Auto-discovers undocumented website APIs",
    "100x faster than headless browsers (50-200ms vs 5-30s)",
    "40x fewer tokens (200 vs 8000 per page)",
    "Shared skill registry for collective API discoveries",
    "Works with Claude Code, Cursor, OpenClaw, and Windsurf"
  ]
}
```

### WebSite + SearchAction Schema

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Unbrowse",
  "url": "https://www.unbrowse.ai",
  "potentialAction": {
    "@type": "SearchAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "https://www.unbrowse.ai/search?q={search_term_string}"
    },
    "query-input": "required name=search_term_string"
  }
}
```

---

## Key Metrics to Track

| Metric | Current | Target (90 days) |
|--------|---------|-------------------|
| GEO Score | 36/100 | 60/100 |
| AI Crawler Access | 10/100 | 75/100 |
| Structured Data | 5/100 | 70/100 |
| Brand Mentions | 33/100 | 50/100 |
| Content Quality | 52/100 | 65/100 |
| Platform Readiness | 29/100 | 50/100 |
| Technical SEO | 52/100 | 75/100 |

---

## Summary

Unbrowse.ai has strong technical foundations (SSR, clean URLs, mobile optimization) and genuine product innovation, but is severely handicapped by:

1. **AI crawler blocks** -- The #1 issue. Every major AI crawler is blocked.
2. **Zero structured data** -- No JSON-LD, no schema markup of any kind.
3. **No entity presence** -- Absent from Wikipedia, Wikidata, Reddit, YouTube, LinkedIn.
4. **Homepage-only content** -- No blog, no guides, no comparisons, no FAQ.
5. **Missing trust signals** -- No team info, no about page, no contact info, no testimonials.

The irony is stark: a product built for AI agents is invisible to AI. The top 10 quick wins can be implemented in a single day and would likely push the GEO score from 36 to 50+. The medium-term actions over the next month could reach 60+.

---

*Report generated by GEO Audit Tool | March 9, 2026*
