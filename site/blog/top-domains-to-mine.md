# The 50 Most Valuable Domains to Mine (And Why)

*A practical guide to the highest-value websites for AI agent route discovery*

---

**TL;DR:** Not all domains are equal for mining. We benchmarked 94 domains — 61 had no bot detection, and even WAF-protected sites yielded a 2.1x speedup. This is the definitive list of the 50 highest-value targets: specific domains, why they're valuable, difficulty ratings, expected route counts, and mining tips. Start with easy wins (Hacker News, DuckDuckGo, npm), then move to premium targets (LinkedIn, Google, Bloomberg) where fewer miners mean higher earnings per route.

---

## From the benchmark

| Metric | Value |
|--------|-------|
| Domains benchmarked | 94 |
| No bot detection | 61 |
| Speedup on WAF sites | 2.1x |
| Speedup on cached routes | 100x |

## How to read this guide

Each domain entry includes:

- **Why it's valuable** — what agents need from this site and why the routes earn.
- **Difficulty** — Easy (no bot detection, no auth), Medium (auth needed or light bot detection), Hard (aggressive bot detection, complex auth, or both).
- **Expected routes** — how many distinct API endpoints you'll typically discover.
- **Mining tip** — specific advice for maximizing route yield.

---

## 1. Search Engines

Every agent searches. Search is the most common first step in any agent workflow — finding information, verifying facts, discovering resources. These domains generate the highest resolve volume in the network because search is the universal entry point.

### google.com

**Why it's valuable:** The default search for every agent. Autocomplete, search results, Knowledge Graph panels, and People Also Ask boxes all run through internal JSON endpoints. Agents that can call these directly skip the entire rendered SERP.

**Difficulty:** Hard | **Expected routes:** 15-25

**Mining tip:** Focus on the autocomplete and Knowledge Graph endpoints first — they return structured JSON and are less aggressively rate-limited than the main search results page. Use cookie injection from a real Chrome profile to pass bot detection.

### bing.com

**Why it's valuable:** Microsoft's search powers Copilot and many enterprise agents. The internal API returns structured search results, instant answers, and entity cards. Lower bot detection than Google.

**Difficulty:** Medium | **Expected routes:** 12-18

**Mining tip:** Bing's autosuggest API at /AS/Suggestions is one of the easiest high-value endpoints on the web. Start there. The main search results endpoint uses a different auth flow — capture it from a logged-in Microsoft account for best results.

### duckduckgo.com

**Why it's valuable:** The privacy-first search engine has minimal bot detection and clean JSON APIs. The instant answer API is already semi-public. Agents that need search without tracking constraints route here.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** DuckDuckGo's internal API is almost identical to their public instant answer API but returns richer data. One browse session captures everything. No auth needed.

### search.brave.com

**Why it's valuable:** Brave Search has its own independent index (not a Bing wrapper). The internal endpoints return structured results with a summarizer. Growing agent adoption because of its clean API surface.

**Difficulty:** Easy | **Expected routes:** 6-10

**Mining tip:** Brave's search API endpoints are cleanly namespaced and return well-structured JSON. The summarizer endpoint is particularly valuable — it returns pre-processed answer text that agents can use directly.

### you.com

**Why it's valuable:** AI-native search engine built for agents. The internal APIs power their AI chat, code search, and web search. Clean endpoints, minimal detection. The closest thing to a search API without paying for one.

**Difficulty:** Easy | **Expected routes:** 8-14

**Mining tip:** Browse with the AI chat feature active — it exposes the richest endpoints including the RAG pipeline that combines search results with LLM summarization. These routes are among the most agent-useful in the entire index.

---

## 2. Code Platforms

Developer agents live on these platforms. Code search, repository browsing, package lookup, and dependency analysis are core workflows for any coding agent. These domains have high route density because developer tools expose many granular API endpoints.

### github.com

**Why it's valuable:** The center of developer gravity. Repository search, file browsing, issue tracking, PR reviews, Actions status — all backed by internal APIs that return richer data than the public REST API. Agent volume here is enormous.

**Difficulty:** Medium | **Expected routes:** 30-50

**Mining tip:** GitHub's internal API is separate from their public REST/GraphQL API and returns data that the public API does not expose (hover cards, contribution graphs, code navigation). Log in with a real account to capture authenticated endpoints. Focus on the code search and file content endpoints — they are the most queried by coding agents.

### gitlab.com

**Why it's valuable:** The self-hosted alternative powers millions of enterprise repos. Internal APIs cover merge requests, CI pipelines, and container registries. Many enterprise agents route here because their orgs use GitLab.

**Difficulty:** Medium | **Expected routes:** 20-35

**Mining tip:** GitLab's internal API closely mirrors their public API but includes additional fields for the UI. Capture the CI pipeline status endpoints — agents building deploy workflows query these constantly.

### npmjs.com

**Why it's valuable:** Every JavaScript agent needs package metadata. The internal search, version history, and dependency tree endpoints return structured data that is richer than the public registry API.

**Difficulty:** Easy | **Expected routes:** 10-15

**Mining tip:** The npm search endpoint at /search/suggestions returns autocomplete data. The package page loads version history, download stats, and dependency graphs through separate API calls — capture them all in one browse of a popular package page.

### pypi.org

**Why it's valuable:** Python's package index. Agents building Python projects need package search, version compatibility, and dependency resolution. The internal endpoints power the search and package detail pages.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** PyPI has some of the cleanest internal APIs of any site we tested. The JSON endpoints are well-structured and stable. Browse a package page and a search results page to capture the full set.

### stackoverflow.com

**Why it's valuable:** The canonical Q&A site for developers. Internal APIs serve question search, answer ranking, code snippets, and related questions. Coding agents query StackOverflow more than any other reference site.

**Difficulty:** Easy | **Expected routes:** 15-25

**Mining tip:** The internal search API returns structured question/answer pairs with vote counts and code blocks already parsed. This is dramatically more useful to agents than scraping the HTML. Capture the /api/ endpoints during a search session.

---

## 3. Social & Content

Research agents, monitoring agents, and content analysis agents all need social platform data. These sites have the highest route value because social data is hard to get through official APIs (rate limits, cost, approval processes) but flows freely through internal endpoints.

### reddit.com

**Why it's valuable:** The front page of the internet for agents. Subreddit search, post feeds, comment threads, and user profiles all use internal JSON APIs. Reddit killed their free public API — internal routes are now the primary access path for agents.

**Difficulty:** Medium | **Expected routes:** 20-35

**Mining tip:** Reddit's new UI (new.reddit.com / sh.reddit.com) uses a GraphQL-like API that returns rich structured data. Old Reddit (old.reddit.com) uses simpler JSON endpoints. Mine both — agents use different routes depending on what data they need. Log in to capture authenticated feeds.

### news.ycombinator.com

**Why it's valuable:** Hacker News is the signal source for tech trends, startup launches, and developer sentiment. The Algolia-powered search API is already accessible, but the internal HN endpoints for stories, comments, and user karma return data the Algolia API misses.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** HN is one of the easiest high-value sites to mine. No bot detection, no auth required, clean JSON responses. Browse the front page, a comment thread, and the search page — that captures all the core routes in under 60 seconds.

### x.com

**Why it's valuable:** Twitter/X is the real-time pulse of the internet. Timeline, search, trends, user profiles, and spaces all use internal GraphQL endpoints. Since the API became paid ($100/month minimum), internal routes are the only free path for agents.

**Difficulty:** Hard | **Expected routes:** 25-40

**Mining tip:** X uses POST-based GraphQL with operation names in the request body. You must be logged in — unauthenticated browsing returns almost nothing. Use cookie injection from your real browser session. Focus on the SearchTimeline and UserTweets operations first. The endpoints rotate bearer tokens, so routes need periodic refresh.

### linkedin.com

**Why it's valuable:** Professional network data — job listings, company profiles, people search, and industry insights. LinkedIn's official API is extremely restricted. Internal routes are the only way agents can access the full dataset.

**Difficulty:** Hard | **Expected routes:** 20-30

**Mining tip:** LinkedIn has aggressive bot detection (Arkose Labs). You must use cookie injection from a real logged-in session and browse slowly — do not rapid-fire page loads. Focus on the Voyager API endpoints (/voyager/api/) which power all dynamic content. These routes are extremely valuable because LinkedIn data is otherwise gated.

### youtube.com

**Why it's valuable:** Video search, channel data, transcript extraction, and recommendation feeds all use the InnerTube API (youtubei/v1). Agents need YouTube for research, content analysis, and tutorial discovery.

**Difficulty:** Medium | **Expected routes:** 15-25

**Mining tip:** YouTube's InnerTube API uses POST requests with a complex context object. Browse a search results page, a video watch page, and a channel page to capture the three main endpoint families. The transcript endpoint is particularly valuable — it returns full video transcripts as structured text.

---

## 4. E-commerce

Shopping agents, price comparison tools, and product research agents all need e-commerce data. These domains have high route density because every product page, search result, and filter combination hits separate API endpoints. The commercial value per route is among the highest in the index.

### amazon.com

**Why it's valuable:** The world's largest product catalog. Search, product details, pricing, reviews, and recommendations all use internal APIs. Any agent that does product research or price comparison needs Amazon routes.

**Difficulty:** Hard | **Expected routes:** 25-40

**Mining tip:** Amazon has sophisticated bot detection, but cookie injection from a real session works reliably. Focus on the search autocomplete, product detail, and review endpoints. The /s?k= search results page loads data through multiple API calls — capture them all. Use a Prime account for access to the full pricing endpoints.

### ebay.com

**Why it's valuable:** Auction and fixed-price listings. The internal search, item detail, and bidding status APIs return structured data that the Finding API (public) does not fully cover. Agents doing price research need both Amazon and eBay routes.

**Difficulty:** Medium | **Expected routes:** 15-20

**Mining tip:** eBay's internal API endpoints are well-structured and return clean JSON. The search endpoint supports detailed filters (condition, price range, shipping) through query parameters. Browse a search results page with filters applied to capture the richest endpoint variants.

### shopify.com (storefronts)

**Why it's valuable:** Millions of stores run on Shopify. Every Shopify storefront uses the same internal API pattern (/products.json, /collections.json, /cart.js). Mine one Shopify store and the routes apply to all of them.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** Shopify storefronts are the single best ROI mining target. The /products.json endpoint exists on every Shopify store and returns the full product catalog with no auth. Browse any popular Shopify store (e.g., allbirds.com, gymshark.com) and the discovered routes generalize to millions of stores.

### walmart.com

**Why it's valuable:** Second-largest US retailer. Product search, inventory checking, store availability, and pricing all use internal APIs. Agents doing price comparison across retailers need Walmart routes alongside Amazon.

**Difficulty:** Medium | **Expected routes:** 15-25

**Mining tip:** Walmart's internal API returns structured product data including real-time inventory and store availability — data that no public API provides. Focus on the search and product detail endpoints. The price comparison between online and in-store prices comes from separate API calls.

### etsy.com

**Why it's valuable:** Handmade and vintage marketplace. Search, listing details, shop profiles, and reviews use clean internal APIs. Agents helping with gift finding, custom orders, or niche product discovery route here.

**Difficulty:** Easy | **Expected routes:** 10-18

**Mining tip:** Etsy has minimal bot detection and well-structured API responses. The search endpoint returns rich faceted data (category, price range, shipping, custom options). Browse a search results page and a listing detail page to capture the core routes.

---

## 5. Productivity

Workflow agents that manage tasks, documents, and team communication are among the fastest-growing agent categories. These domains require authentication, which makes their routes more valuable — authenticated routes are harder to discover and serve fewer miners, meaning higher earnings per route.

### notion.so

**Why it's valuable:** The default workspace for startups and knowledge workers. Page content, database queries, search, and block manipulation all use internal APIs that are richer than the public Notion API. Agents managing knowledge bases route here constantly.

**Difficulty:** Medium | **Expected routes:** 20-30

**Mining tip:** Log in with your real account. Notion's internal API (/api/v3/) exposes operations that the public API does not support, including transclusions, synced blocks, and formula evaluation. Browse a database page with filters to capture the query endpoints. These authenticated routes are high-value because few miners have them.

### linear.app

**Why it's valuable:** Issue tracking for engineering teams. Issue search, project boards, cycle views, and team workloads use clean GraphQL endpoints. Agents managing sprints and tickets need Linear routes.

**Difficulty:** Medium | **Expected routes:** 12-20

**Mining tip:** Linear uses a single GraphQL endpoint with operation names. Browse the issues list, a project board, and the cycle view to capture the main query variants. The GraphQL schema is well-typed — captured routes include full type information that agents can use for query construction.

### docs.google.com

**Why it's valuable:** Google Docs, Sheets, and Slides power collaborative work. The internal APIs handle real-time editing, comment threads, revision history, and sharing permissions. Agents that read or modify documents need these routes.

**Difficulty:** Hard | **Expected routes:** 20-35

**Mining tip:** Google Workspace has strong bot detection and complex auth flows. Cookie injection from a logged-in Google account is essential. Focus on the read-only endpoints first — document content, comment threads, and revision lists. The real-time editing endpoints use a different protocol and are harder to capture reliably.

### slack.com

**Why it's valuable:** Team messaging. Channel history, search, user presence, and thread replies use internal APIs. Agents that monitor channels, summarize conversations, or post updates need Slack routes.

**Difficulty:** Hard | **Expected routes:** 15-25

**Mining tip:** Slack's web client uses a mix of REST and WebSocket APIs. The REST endpoints (/api/) are capturable and cover message history, search, and channel listing. Log in to your workspace first. The captured routes are workspace-specific but the endpoint patterns are universal across all Slack workspaces.

### airtable.com

**Why it's valuable:** Flexible database for teams. Table views, record CRUD, form submissions, and automations use internal APIs. Agents managing structured data (CRM, inventory, project tracking) route here.

**Difficulty:** Medium | **Expected routes:** 12-18

**Mining tip:** Airtable's internal API closely mirrors their public REST API but includes additional fields (field configs, view metadata, automation triggers). Browse a base with multiple views to capture the full range of query endpoints.

---

## 6. Travel & Booking

Planning agents are a high-growth category. Travel sites have extremely high commercial value per route because every search involves pricing, availability, and booking — data that agents need in structured form. These sites also have heavy bot detection, which means fewer miners and higher earnings.

### airbnb.com

**Why it's valuable:** Accommodation search, listing details, pricing calendars, and availability checks all use internal APIs. Agents planning trips need Airbnb routes for price comparison and availability checking.

**Difficulty:** Medium | **Expected routes:** 15-25

**Mining tip:** Airbnb's StaysSearch endpoint returns structured listing data with pricing, photos, and amenities. Browse a search results page with dates selected to capture the pricing endpoint variant. The calendar availability endpoint is separate — visit a listing detail page to capture it.

### google.com/travel

**Why it's valuable:** Google Flights and Hotels aggregate pricing across all carriers and booking platforms. The internal APIs return the same comparison data that Google shows in the UI — structured fares, hotel rates, and availability.

**Difficulty:** Hard | **Expected routes:** 12-20

**Mining tip:** Google Travel uses the same bot detection as Google Search. Cookie injection is essential. Focus on the flight search and hotel search endpoints — they return structured pricing data across multiple carriers in a single response. These are among the most commercially valuable routes in the entire index.

### booking.com

**Why it's valuable:** The world's largest hotel booking platform. Hotel search, room availability, pricing, and review summaries use internal APIs. Agents comparing accommodation options need both Airbnb and Booking.com routes.

**Difficulty:** Medium | **Expected routes:** 15-22

**Mining tip:** Booking.com's search API returns rich structured data including real-time pricing, room types, and cancellation policies. Set destination and dates before capturing — the endpoints behave differently without date parameters. Focus on the GraphQL search endpoint, not the legacy REST endpoints.

### kayak.com

**Why it's valuable:** Meta-search for flights, hotels, and car rentals. The internal APIs aggregate results from dozens of providers and return normalized comparison data. Agents doing multi-provider price comparison route here.

**Difficulty:** Medium | **Expected routes:** 10-18

**Mining tip:** Kayak uses a polling pattern — the initial search starts a background job, then the frontend polls for results as they come in from different providers. Capture both the search initiation and the polling endpoints. Wait for results to fully load before closing the session.

### tripadvisor.com

**Why it's valuable:** Reviews, ratings, and recommendations for restaurants, hotels, and attractions. The internal APIs return structured review data, aggregate ratings, and ranked recommendations. Agents doing travel research route here for review intelligence.

**Difficulty:** Easy | **Expected routes:** 12-20

**Mining tip:** TripAdvisor has minimal bot detection compared to other travel sites. The review and rating endpoints return structured data that is immediately useful to agents. Browse a hotel or restaurant page to capture the review feed endpoint — it supports pagination and filtering that the HTML page hides.

---

## 7. Finance

Financial data is among the most commercially valuable on the web. Market data, payment processing, and banking APIs command premium pricing in the route graph because the agents that use them are doing high-value work — trading, accounting, and financial planning.

### stripe.com/dashboard

**Why it's valuable:** Payment processing for internet businesses. The dashboard's internal APIs expose payment history, subscription management, customer data, and analytics. Agents managing billing and revenue operations need these routes.

**Difficulty:** Hard | **Expected routes:** 20-35

**Mining tip:** Stripe's dashboard requires authentication. Log in with your real account and browse the payments, customers, and analytics pages. The captured routes are scoped to your account but the endpoint patterns work for any Stripe account. These authenticated financial routes command premium pricing in the route graph.

### finance.yahoo.com

**Why it's valuable:** The most widely used free financial data source. Stock quotes, historical prices, financial statements, and analyst estimates all use internal APIs that return structured market data. Every financial agent routes here.

**Difficulty:** Easy | **Expected routes:** 15-25

**Mining tip:** Yahoo Finance is one of the easiest high-value financial sites to mine. No auth required, minimal bot detection, clean JSON responses. Browse a stock quote page (e.g., AAPL), the historical data tab, and the financials tab to capture the three main endpoint families. The /v8/finance/chart/ endpoint is particularly valuable.

### coinmarketcap.com

**Why it's valuable:** The reference site for cryptocurrency market data. Token prices, market caps, volume, and exchange data use internal APIs. Crypto trading agents and portfolio trackers route here for real-time data.

**Difficulty:** Easy | **Expected routes:** 12-18

**Mining tip:** CoinMarketCap's internal API returns richer data than their paid public API tier. Browse the main ranking page and a coin detail page to capture the core endpoints. The /data-api/ endpoints return structured market data with no auth required.

### tradingview.com

**Why it's valuable:** Charting and technical analysis. The internal APIs serve real-time price data, indicator calculations, and screener results. Agents doing technical analysis or market screening route here for data that is not available through free market data APIs.

**Difficulty:** Medium | **Expected routes:** 15-22

**Mining tip:** TradingView uses WebSocket for real-time data and REST for historical/screener data. Focus on the REST endpoints — they are capturable and cover the stock screener, economic calendar, and ideas feed. The screener endpoint is especially valuable for agents filtering stocks by technical criteria.

### wise.com

**Why it's valuable:** International money transfers. Exchange rate quotes, transfer fee calculations, and corridor availability use internal APIs. Agents helping with cross-border payments and forex comparison need these routes.

**Difficulty:** Medium | **Expected routes:** 8-14

**Mining tip:** Wise's exchange rate and fee calculator endpoints are accessible without auth and return structured pricing data. Browse the send money flow with different currency pairs to capture route variants. The rate endpoint supports all currency pairs in a single parameterized route.

---

## 8. Infrastructure

DevOps agents manage deployments, monitor services, and configure infrastructure. These platforms are mostly dashboard-based, meaning their internal APIs are rich and well-structured. Authenticated routes from infrastructure platforms are high-value because they enable agents to manage production systems.

### console.aws.amazon.com

**Why it's valuable:** AWS powers a third of the cloud. The console's internal APIs cover service status, resource management, billing, and CloudWatch metrics. DevOps agents managing AWS infrastructure need these routes.

**Difficulty:** Hard | **Expected routes:** 30-50+

**Mining tip:** AWS Console has complex authentication (SigV4 + session tokens). Log in with your real AWS account. Focus on the service-specific API calls rather than the console framework endpoints. CloudWatch metrics, EC2 instance listing, and S3 bucket management endpoints are the most queried by DevOps agents.

### vercel.com

**Why it's valuable:** The deployment platform for frontend projects. Build status, deployment logs, analytics, and domain management use clean internal APIs. Agents managing Vercel deployments route here for status checks and configuration.

**Difficulty:** Medium | **Expected routes:** 15-22

**Mining tip:** Vercel's internal API is well-structured and closely mirrors their public API. Log in and browse the project dashboard, deployments list, and analytics page. The deployment status and build log endpoints are the most valuable — agents check these during CI/CD workflows.

### dash.cloudflare.com

**Why it's valuable:** CDN, DNS, and security. The dashboard APIs manage DNS records, WAF rules, analytics, and Workers deployment. Agents managing web infrastructure route here.

**Difficulty:** Medium | **Expected routes:** 20-30

**Mining tip:** Cloudflare's dashboard API uses the same /client/v4/ prefix as their public API but includes additional internal-only endpoints for analytics and diagnostics. Log in and browse the DNS, analytics, and security pages to capture the core routes.

### app.netlify.com

**Why it's valuable:** Alternative deployment platform. Build logs, deploy previews, form submissions, and serverless function logs use internal APIs. Agents managing Netlify projects need these routes alongside Vercel routes.

**Difficulty:** Easy | **Expected routes:** 10-15

**Mining tip:** Netlify has minimal bot detection and well-structured API responses. Log in and browse the site dashboard and deploy list. The build log streaming endpoint is useful for agents monitoring deployment status in real time.

### app.datadog.com

**Why it's valuable:** Monitoring and observability. The dashboard APIs serve metric queries, log searches, alert status, and APM traces. Agents doing incident response and performance monitoring route here.

**Difficulty:** Hard | **Expected routes:** 20-30

**Mining tip:** Datadog's internal API is extensive. Focus on the metric query and log search endpoints — these are what incident response agents query most. The APM trace endpoint returns structured span data that agents can analyze for performance bottlenecks. Authentication is required.

---

## 9. Knowledge

Research agents need structured knowledge. These domains are typically the easiest to mine — knowledge platforms tend to have minimal bot detection and return well-structured data. They are high-volume routes because every research task starts with a knowledge lookup.

### en.wikipedia.org

**Why it's valuable:** The world's encyclopedia. Article content, search, category listings, and citation data use the MediaWiki API. Every research agent queries Wikipedia. The internal endpoints return structured content that is cleaner than parsing HTML.

**Difficulty:** Easy | **Expected routes:** 10-15

**Mining tip:** Wikipedia's API is semi-public (/w/api.php) but the internal endpoints used by the modern UI return richer structured data including section parsing, quick facts, and related articles. Browse a search results page and an article page to capture both endpoint families.

### arxiv.org

**Why it's valuable:** The pre-print server for scientific papers. Search, paper metadata, abstract retrieval, and PDF links use internal APIs. Research agents working with academic papers route here. The API returns structured metadata including author lists, categories, and citation counts.

**Difficulty:** Easy | **Expected routes:** 6-10

**Mining tip:** arXiv has no bot detection and clean API endpoints. The search endpoint returns structured paper metadata. Browse a search results page and a paper abstract page to capture the full set. The /api/ endpoint supports complex query syntax that agents can use for filtered searches.

### developer.mozilla.org

**Why it's valuable:** MDN Web Docs — the canonical reference for web standards. The internal search and document APIs return structured technical documentation. Coding agents look up MDN constantly for HTML, CSS, and JavaScript reference.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** MDN's internal API returns parsed, structured documentation including code examples, browser compatibility tables, and specification links. One search session captures the core endpoints. The /api/v1/search endpoint is particularly clean.

### docs.python.org

**Why it's valuable:** Python's official documentation. The internal search and page content endpoints return structured reference material. Python coding agents query this for standard library documentation, function signatures, and usage examples.

**Difficulty:** Easy | **Expected routes:** 5-8

**Mining tip:** Python docs are static but the search functionality uses an internal API that returns structured results. Simple to mine — one search query captures the endpoint. Combine with PyPI routes for full Python development agent coverage.

### devdocs.io

**Why it's valuable:** Aggregated documentation for 100+ languages and frameworks. The internal API serves documentation content, search results, and framework-specific reference. Agents that work across multiple languages use DevDocs as a single lookup point.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** DevDocs preloads documentation as JSON blobs. Browse the search interface and load a few different framework docs to capture the content delivery endpoints. These routes cover over 100 frameworks through parameterized URL patterns.

---

## 10. News

Monitoring agents track news for market signals, competitive intelligence, and trend detection. News domains have moderate route counts but high query volume — agents monitoring multiple topics make repeated calls throughout the day. Fresh news routes earn more because the demand is time-sensitive.

### techcrunch.com

**Why it's valuable:** The default news source for tech and startups. Article feeds, search, and category pages use internal APIs. Agents monitoring startup launches, funding rounds, and tech trends route here.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** TechCrunch runs on WordPress, and the internal REST API (/wp-json/wp/v2/) returns structured article data including categories, tags, and excerpts. Browse the homepage and a category page to capture the core feed endpoints. WordPress-based routes generalize to thousands of news sites.

### bloomberg.com

**Why it's valuable:** Financial news and market analysis. The internal APIs serve article content, market data widgets, and economic indicators. Agents doing financial research and market monitoring route here for premium analysis.

**Difficulty:** Hard | **Expected routes:** 12-18

**Mining tip:** Bloomberg has a paywall and bot detection. Cookie injection from a subscriber account is needed for full access. Focus on the market data widgets and economic calendar endpoints — they return structured data that is more valuable to agents than article text. Even the free-tier endpoints (market overview, stock quotes) are worth mining.

### reuters.com

**Why it's valuable:** Wire service powering global news. Article feeds, topic search, and market data use internal APIs. Agents monitoring global events and market-moving news route here for speed — Reuters publishes faster than most outlets.

**Difficulty:** Medium | **Expected routes:** 10-15

**Mining tip:** Reuters recently rebuilt their frontend and the new internal API returns clean structured data. Browse the homepage, a topic page (e.g., /technology/), and the market data section to capture the core endpoints. The wire feed endpoint is the most valuable — it returns breaking news faster than RSS.

### news.google.com

**Why it's valuable:** Aggregated news from all sources. The internal APIs return article clusters, topic feeds, and personalized recommendations across publishers. Agents that need multi-source news monitoring route here instead of mining individual publishers.

**Difficulty:** Hard | **Expected routes:** 10-15

**Mining tip:** Google News shares Google's bot detection. Cookie injection is required. The article cluster endpoint is the key target — it returns related articles from multiple sources grouped by story, which is exactly what monitoring agents need. One Google News route replaces dozens of individual publisher routes.

### apnews.com

**Why it's valuable:** Associated Press — the wire service that feeds every major outlet. Clean internal APIs for article feeds, topic search, and breaking news. Lower bot detection than Bloomberg or Reuters, making it accessible for early miners.

**Difficulty:** Easy | **Expected routes:** 8-12

**Mining tip:** AP News has clean, well-structured internal APIs and minimal bot detection. The article feed endpoint supports topic filtering and pagination. Browse the homepage and a topic page to capture the core routes. These are high-value news routes because AP content is the source for thousands of downstream outlets.

---

## Mining strategy

**Start with Easy domains.** Your first mining sessions should target Easy-rated domains like Hacker News, DuckDuckGo, npm, and Wikipedia. These sites have no bot detection, require no authentication, and produce clean routes in a single browse session. Build your route portfolio with reliable wins before tackling harder targets.

**Hard domains pay more.** Sites with aggressive bot detection (Google, LinkedIn, X, Bloomberg) have fewer miners competing for their routes. If you can successfully mine them using cookie injection from your real browser sessions, your routes earn disproportionately more because supply is constrained while demand is high.

**Think in categories, not individual sites.** A Shopify storefront route works on millions of stores. A WordPress REST API route works on 40% of the web. When you mine a platform, you are mining every site built on that platform. Prioritize platforms over individual websites.

**Authenticated routes are premium routes.** Routes that require login (Notion, Slack, Stripe, AWS) are inherently more valuable because they enable agents to do things that unauthenticated routes cannot. They also have fewer miners. If you already use these services, mining them while you work is free money.

**Keep routes fresh.** Websites change their internal APIs. A route that worked last month might return errors today. The route graph automatically deprioritizes stale routes. Re-mine your highest-value domains periodically to keep your routes at the top of the quality ranking.

---

## Get started

```bash
# Install Unbrowse
npm install -g unbrowse

# Mine your first domain
unbrowse go https://news.ycombinator.com

# Browse normally. Close the tab. Routes are captured and published.

# Check what you discovered
unbrowse skills
```

Every domain you mine earns when agents use the routes. The first person to index a domain earns a **2x reward multiplier** for 30 days. Many of the domains on this list have not been indexed yet. The earlier you mine them, the more you earn.

**Go deeper:**

- [Internal APIs Are All You Need](https://arxiv.org/abs/2604.00694) — the research paper
- [Proof of Indexing](/proof-of-indexing) — the full economics of mining
- [Shadow APIs Explained](/shadow-apis-explained) — what Unbrowse discovers and how
- [GitHub](https://github.com/unbrowse-ai/unbrowse) — source code and documentation
