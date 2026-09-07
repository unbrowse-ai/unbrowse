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
      "Browser-first agent work often pays for rendering and page parsing when the structured route already exists underneath. Across 94 domains in the paper benchmark, warmed cached routes averaged a 3.6x mean speedup over Playwright.",
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
    title: "94 Domains: The Warmed-Cache Benchmark",
    description:
      "The paper benchmark compares warmed cached route execution against Playwright across 94 live domains, with 3.6x mean and 5.4x median speedup.",
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
      "Personal AI agents waste time when every web task starts with browser rendering. Unbrowse lets an OpenClaw agent try a known first-party route first and fall back to the browser when needed.",
    canonicalPath: "/personal-agents",
    published_at: "2026-04-02",
    author: "Lewis Tham",
    category: "Product",
  },
];
