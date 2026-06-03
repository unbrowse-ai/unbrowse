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
    slug: "routing-layer",
    title:
      "Google Indexed the Web for Humans. Who Indexes It for Agents?",
    description:
      "Google captured $2T in value by indexing HTML pages for human eyeballs. The agentic web needs its own index. Not an index of pages, but an index of machine-readable API routes. Unbrowse is building it, collectively, from the routes agents discover as they work.",
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
];
