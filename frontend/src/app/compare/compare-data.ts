export interface Competitor {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  /** What the competitor is, in one sentence. */
  what: string;
  /** Where it falls short for AI agent use cases. */
  limitations: string[];
  /** Keywords for meta tags. */
  keywords: string[];
}

export const competitors: Record<string, Competitor> = {
  playwright: {
    slug: "playwright",
    name: "Playwright",
    tagline: "Unbrowse vs Playwright",
    description:
      "Playwright automates browsers with a powerful API, but every action requires rendering a full page. Unbrowse learns first-party routes behind those pages so AI agents can call a known route directly — 3.6x faster on average in the 94-domain paper benchmark.",
    what: "Playwright is a cross-browser automation framework by Microsoft. It controls Chromium, Firefox, and WebKit through the DevTools Protocol, rendering full pages for every interaction.",
    limitations: [
      "Every action renders a full browser page (5-30 seconds per step)",
      "Agents must parse ~8,000 tokens of DOM/HTML per page",
      "Fragile selectors break when sites update their UI",
      "Headless detection is an arms race — CAPTCHAs, fingerprint checks",
      "Parallel sessions require proportional CPU and memory",
    ],
    keywords: [
      "Playwright alternative",
      "Playwright alternative for AI agents",
      "Playwright vs Unbrowse",
      "headless browser alternative",
      "browser automation alternative",
      "Playwright AI agent",
      "faster than Playwright",
    ],
  },
  puppeteer: {
    slug: "puppeteer",
    name: "Puppeteer",
    tagline: "Unbrowse vs Puppeteer",
    description:
      "Puppeteer gives fine-grained Chrome control via CDP, but agents still pay the full rendering cost. Unbrowse tries a known first-party route first, then falls back to the browser when needed.",
    what: "Puppeteer is a Node.js library by Google that controls Chrome/Chromium via the Chrome DevTools Protocol. It is the most popular headless browser tool in the Node ecosystem.",
    limitations: [
      "Chrome-only — no Firefox or WebKit support",
      "Full page rendering for every navigation (5-30 seconds)",
      "Heavy memory footprint per browser instance (~200-500 MB)",
      "DOM scraping produces thousands of tokens agents must parse",
      "No built-in anti-detection — sites block headless Chrome easily",
    ],
    keywords: [
      "Puppeteer alternative",
      "Puppeteer alternative for AI agents",
      "Puppeteer vs Unbrowse",
      "headless Chrome alternative",
      "Puppeteer AI agent",
      "faster than Puppeteer",
      "CDP alternative",
    ],
  },
  "browser-use": {
    slug: "browser-use",
    name: "Browser Use",
    tagline: "Unbrowse vs Browser Use",
    description:
      "Browser Use connects LLMs to a live browser with vision and action. Unbrowse eliminates the browser entirely — agents call the same APIs websites use internally, cutting cost from $0.53 to $0.005 per task.",
    what: "Browser Use is an open-source framework that lets LLMs control a browser with vision-based understanding and DOM interaction. It wraps Playwright and adds LLM-driven navigation loops.",
    limitations: [
      "Every step requires an LLM call to interpret a screenshot or DOM — compounding cost",
      "Vision model inference adds 2-10 seconds latency per action",
      "Token usage scales with page complexity (screenshots are thousands of tokens)",
      "Still fundamentally browser automation — subject to CAPTCHAs and rate limits",
      "Multi-step tasks multiply the per-step cost and latency",
    ],
    keywords: [
      "Browser Use alternative",
      "Browser Use alternative for AI agents",
      "Browser Use vs Unbrowse",
      "AI browser agent alternative",
      "browser agent framework alternative",
      "cheaper than Browser Use",
    ],
  },
  crawl4ai: {
    slug: "crawl4ai",
    name: "Crawl4AI",
    tagline: "Unbrowse vs Crawl4AI",
    description:
      "Crawl4AI crawls and converts pages to LLM-friendly markdown. Unbrowse skips the page entirely — it calls the internal APIs behind the content, returning structured JSON instead of scraped text.",
    what: "Crawl4AI is an open-source web crawler designed for LLMs and AI agents. It renders pages with a headless browser, then converts the HTML to clean markdown suitable for LLM consumption.",
    limitations: [
      "Still renders full pages — crawling is slow (seconds per page)",
      "Output is markdown text, not structured data — agents must parse it",
      "No ability to submit forms, authenticate, or perform write operations",
      "Scraping-based approach breaks when page layouts change",
      "No shared knowledge — every user re-crawls the same sites",
    ],
    keywords: [
      "Crawl4AI alternative",
      "Crawl4AI alternative for AI agents",
      "Crawl4AI vs Unbrowse",
      "web crawler alternative for AI",
      "AI web scraper alternative",
      "faster than Crawl4AI",
      "structured data from websites",
    ],
  },
  firecrawl: {
    slug: "firecrawl",
    name: "Firecrawl",
    tagline: "Unbrowse vs Firecrawl",
    description:
      "Firecrawl charges 1 credit per page scraped. Unbrowse charges $0 on cache hits — and our @unbrowse/firecrawl-shim lets you swap their SDK with one import line, falling back to your existing Firecrawl key only when we miss.",
    what: "Firecrawl is a managed scraping API that converts websites into LLM-ready markdown via scrape/crawl/map/extract/search endpoints. Plans run $16-$599/mo for 5k-1M credits; 1 credit per page, 2 credits per browser-minute.",
    limitations: [
      "Pay per page even when the same URL has been scraped by another customer minutes ago",
      "No marketplace — every customer's scraped routes are siloed, no shared cache",
      "Recursive crawl + map require predictable billable units; no usage forecasting",
      "Browser-based render path costs 2 credits/min on Interact",
      "Standard plan caps at 100k credits; over-cap teams jump to $333/mo Growth tier",
    ],
    keywords: [
      "Firecrawl alternative",
      "Firecrawl alternative for AI agents",
      "Firecrawl vs Unbrowse",
      "cheaper than Firecrawl",
      "Firecrawl drop-in replacement",
      "@unbrowse/firecrawl-shim",
      "scrape API alternative",
      "Firecrawl pricing",
    ],
  },
  browserbase: {
    slug: "browserbase",
    name: "Browserbase",
    tagline: "Unbrowse vs Browserbase + Stagehand",
    description:
      "Browserbase charges $0.10-$0.12 per browser-hour and Stagehand spins one for every act/extract call. Unbrowse resolves the URL+intent against a cached marketplace endpoint first — and our @unbrowse/stagehand-shim is a one-line drop-in that pays Browserbase only on cache miss.",
    what: "Browserbase is a managed Chrome runtime for AI agents (Stagehand is their high-level act/extract/observe SDK). Free 1hr/mo → Dev $20/mo for 100hr → Startup $99/mo for 500hr; $0.10-$0.12/browser-hour after included tier; residential proxies $10-$12/GB.",
    limitations: [
      "Every act/extract/observe spins up a billed browser session even if the data was cacheable",
      "Browser-hour pricing punishes long-tail and idle sessions",
      "Proxy bandwidth is charged separately at $10-$12/GB",
      "Stagehand's vision/DOM loop still calls an LLM per action — token cost compounds",
      "Self-hosted fallback is real Playwright + your own infra — no marketplace cache",
    ],
    keywords: [
      "Browserbase alternative",
      "Stagehand alternative",
      "Browserbase vs Unbrowse",
      "Stagehand drop-in replacement",
      "@unbrowse/stagehand-shim",
      "cheaper than Browserbase",
      "Browserbase pricing",
      "AI browser agent alternative",
    ],
  },
};

export interface ComparisonRow {
  dimension: string;
  unbrowse: string;
  competitor: (name: string) => string;
  /** Optional footnote reference. */
  note?: string;
}

export const comparisonRows: ComparisonRow[] = [
  {
    dimension: "Architecture",
    unbrowse: "API-first: discovers internal APIs, calls them directly",
    competitor: (name) =>
      name === "Crawl4AI"
        ? "Crawl-first: renders pages, converts HTML to markdown"
        : name === "Browser Use"
          ? "Browser + LLM loop: vision/DOM interpretation per step"
          : "Browser automation: renders full pages via DevTools Protocol",
  },
  {
    dimension: "Speed (mean)",
    unbrowse: "950 ms per task (warmed cache)",
    competitor: () => "3,404 ms per task (Playwright baseline)",
    note: "arXiv:2604.00694, 94 domains",
  },
  {
    dimension: "Speedup",
    unbrowse: "3.6x faster (mean), 5.4x faster (median)",
    competitor: () => "1x baseline",
    note: "arXiv:2604.00694",
  },
  {
    dimension: "Cost per task",
    unbrowse: "$0.005 (cached API call)",
    competitor: () => "$0.53 (browser automation)",
    note: "90-96% reduction",
  },
  {
    dimension: "Token usage",
    unbrowse: "~200 tokens (structured JSON response)",
    competitor: (name) =>
      name === "Crawl4AI"
        ? "~8,000 tokens (converted markdown)"
        : "~8,000 tokens (DOM/HTML per page)",
    note: "40x reduction",
  },
  {
    dimension: "Setup",
    unbrowse: "curl -fsSL https://unbrowse.ai/install.sh | bash (one command)",
    competitor: (name) =>
      name === "Crawl4AI"
        ? "pip install crawl4ai + browser binary download"
        : name === "Browser Use"
          ? "pip install browser-use + Playwright browsers + LLM API key"
          : name === "Puppeteer"
            ? "npm install puppeteer (downloads ~400 MB Chromium)"
            : "npm install playwright && npx playwright install (~400 MB browsers)",
  },
  {
    dimension: "Output format",
    unbrowse: "Structured JSON from real API responses",
    competitor: (name) =>
      name === "Crawl4AI"
        ? "Markdown text extracted from rendered HTML"
        : "Raw HTML/DOM that agents must parse",
  },
  {
    dimension: "Shared knowledge",
    unbrowse: "Skill registry: discoveries shared across all agents",
    competitor: () => "None: every user re-discovers the same site patterns",
  },
  {
    dimension: "Authentication",
    unbrowse: "Auto-injects cookies from real browser profiles",
    competitor: (name) =>
      name === "Browser Use"
        ? "Manual login flows driven by LLM"
        : "Manual cookie/session management in code",
  },
  {
    dimension: "Anti-bot resistance",
    unbrowse: "Real API calls with real cookies — indistinguishable from user traffic",
    competitor: (name) =>
      name === "Browser Use"
        ? "Full browser fingerprint but LLM-driven patterns are detectable"
        : "Headless fingerprint detection, CAPTCHAs, IP blocking",
  },
];
