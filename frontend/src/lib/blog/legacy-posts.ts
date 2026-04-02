import type { LegacyBlogPost } from "./types";

/**
 * Manifest of the existing static articles.
 * Each entry mirrors the metadata exported from its own page.tsx so the blog
 * index can list them without importing React components.
 *
 * `canonicalPath` is the route the static page lives at (no /blog prefix).
 */
export const LEGACY_BLOG_POSTS: LegacyBlogPost[] = [
  {
    slug: "internal-apis-are-all-you-need",
    title: "Internal APIs Are All You Need",
    description:
      "Autonomous agents increasingly interact with the web, yet most websites remain designed for human browsers. Internal APIs Are All You Need presents Unbrowse, a shared route graph that transforms browser-based route discovery into a collectively maintained index of callable first-party interfaces.",
    canonicalPath: "/internal-apis-are-all-you-need",
    published_at: "2026-04-01",
    author: "Lewis Tham",
    category: "Whitepaper",
  },
  {
    slug: "shadow-apis-are-all-you-need",
    title: "Shadow APIs Are All You Need",
    description:
      "Redirects to Internal APIs Are All You Need — the canonical paper page.",
    canonicalPath: "/shadow-apis-are-all-you-need",
    published_at: "2026-04-01",
    author: "Lewis Tham",
    category: "Whitepaper",
  },
  {
    slug: "browser-automation-is-dead",
    title: "Browser Automation Is Dead. Here's What Replaces It.",
    description:
      "Every AI agent web action pays a hidden $0.53 tax -- the cost of launching a browser, rendering pixels, and converting structured data back into structured data. Across 94 domains, direct API calls achieved 3.6x mean speedup, 106x cost reduction, and eliminated 500 MB RAM per instance.",
    canonicalPath: "/browser-automation-is-dead",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Opinion",
  },
  {
    slug: "mcp-servers-mass-hallucination",
    title: "Every MCP Server Is a Mass Hallucination",
    description:
      "There are 10,000+ MCP servers on GitHub. Each is a hand-written wrapper around one API. But most websites don't have official APIs, and the ones that do change constantly. The entire approach doesn't scale.",
    canonicalPath: "/mcp-servers-mass-hallucination",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Opinion",
  },
  {
    slug: "shadow-apis-explained",
    title: "Shadow APIs: The Hidden API Layer Every Website Already Has",
    description:
      "Every modern website calls internal API endpoints behind its UI. These shadow APIs are not documented, not public, but fully functional. Unbrowse discovers them by intercepting network traffic during normal browsing.",
    canonicalPath: "/shadow-apis-explained",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Technical",
  },
  {
    slug: "benchmark-deep-dive",
    title: "94 Domains, 100% Win Rate: The Full Benchmark",
    description:
      "We tested Unbrowse against Playwright on every major website category. Browser automation lost every time.",
    canonicalPath: "/benchmark-deep-dive",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Benchmark",
  },
  {
    slug: "proof-of-indexing",
    title:
      "Google Indexed the Web for Humans. Here's Who Indexes It for Agents.",
    description:
      "The agentic web needs its own index — machine-readable routes, not HTML pages. Unbrowse lets anyone contribute to this index and earn from it. Proof of indexing is to the agentic web what proof of work was to Bitcoin.",
    canonicalPath: "/proof-of-indexing",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Economics",
    draft: true,
  },
  {
    slug: "proof-of-indexing-vs-proof-of-work",
    title: "Proof of Indexing: The Consensus Mechanism for the Agentic Web",
    description:
      "Bitcoin burns electricity to secure transactions. Unbrowse burns browsing effort to secure routes. One built a ledger. The other is building the index.",
    canonicalPath: "/proof-of-indexing-vs-proof-of-work",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Economics",
  },
  {
    slug: "routing-layer",
    title:
      "Google Indexed the Web for Humans. Who Indexes It for Agents?",
    description:
      "Google captured $2T in value by indexing HTML pages for human eyeballs. The agentic web needs its own index. Not an index of pages, but an index of machine-readable API routes. Unbrowse is building it, collectively, through proof of indexing.",
    canonicalPath: "/routing-layer",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Vision",
  },
  {
    slug: "personal-agents",
    title: "Your Personal Agent Is 3.6x Slower Than It Should Be",
    description:
      "Personal AI agents spend 80% of their time waiting for web pages to load — rendering pixels they will never see, parsing DOM they do not need, burning API credits on vision tokens. The Unbrowse plugin for OpenClaw gives your agent direct access to those APIs. 3.6x faster, 106x cheaper, zero browser overhead.",
    canonicalPath: "/personal-agents",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Product",
  },
  {
    slug: "openclaw-earn",
    title: "Your OpenClaw Agent Can Earn Money While It Works For You",
    description:
      "You already use your OpenClaw agent to browse the web, search, book things, and research. With one plugin, every web interaction your agent makes starts earning you USDC.",
    canonicalPath: "/openclaw-earn",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Product",
  },
  {
    slug: "mine-the-internet",
    title: "Mine the Internet",
    description:
      "The agentic web needs a new kind of index — not HTML pages, but machine-readable API routes. Unbrowse turns normal web browsing into mining: every site you visit contributes routes to a shared graph. When AI agents use those routes, you earn USDC micropayments.",
    canonicalPath: "/mine-the-internet",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Economics",
  },
  {
    slug: "top-domains-to-mine",
    title: "The 50 Most Valuable Domains to Mine (And Why)",
    description:
      "Not all domains are equal for mining. We benchmarked 94 domains in our paper — 61 had no bot detection at all, and even WAF-protected sites yielded a 2.1x speedup over headless browsers. This is the definitive list of the 50 most valuable domains to mine with Unbrowse.",
    canonicalPath: "/top-domains-to-mine",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Guide",
  },
  {
    slug: "agent-fleet-economics",
    title: "Your Agent Fleet Can Fund Itself",
    description:
      "If you're running 10, 50, or 100 AI agents that interact with websites, each one is a cost center burning $0.53 per browser action. With Unbrowse, every agent passively discovers API routes that get shared to a marketplace.",
    canonicalPath: "/agent-fleet-economics",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Economics",
  },
];
