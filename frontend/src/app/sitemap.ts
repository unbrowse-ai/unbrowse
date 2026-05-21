import type { MetadataRoute } from "next";

/**
 * Sitemap: all static public routes under app/.
 * Dynamic routes (/blog/[slug], /agents/[id], /skills/[id], /[domain]) need
 * getStaticParams enumeration; tracked as a follow-up to wave 2 of the
 * ongoing-geo-ai-search-visibility-audit-remediati harness.
 * Internal/auth-gated routes excluded: /account/*, /dashboard/*, /ops,
 * /billing/success.
 */
const BASE = "https://www.unbrowse.ai";

type Entry = {
  path: string;
  priority: number;
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  lastModified?: string;
};

const STATIC_ROUTES: Entry[] = [
  // root
  { path: "/", priority: 1.0, changeFrequency: "weekly" },

  // funnel + content surfaces (high priority)
  { path: "/papers", priority: 0.95, changeFrequency: "weekly" },
  { path: "/search", priority: 0.9, changeFrequency: "daily" },
  { path: "/blog", priority: 0.9, changeFrequency: "daily" },
  { path: "/faq", priority: 0.85, changeFrequency: "weekly" },
  { path: "/how-unbrowse-pays", priority: 0.85, changeFrequency: "weekly" },
  { path: "/leaderboard", priority: 0.85, changeFrequency: "daily" },
  { path: "/miners", priority: 0.85, changeFrequency: "weekly" },
  { path: "/openclaw-earn", priority: 0.8, changeFrequency: "weekly" },

  // GEO definition page (cited by AI search for "what is Unbrowse"-shaped queries)
  { path: "/what-is-unbrowse", priority: 0.95, changeFrequency: "monthly", lastModified: "2026-05-21" },

  // POV essays (high investment, high AI-citation value)
  { path: "/internal-apis-are-all-you-need", priority: 0.95, changeFrequency: "monthly", lastModified: "2026-03-25" },
  { path: "/mcp-is-now-the-default", priority: 0.95, changeFrequency: "monthly", lastModified: "2026-05-12" },
  { path: "/shadow-apis-are-all-you-need", priority: 0.9, changeFrequency: "monthly" },
  { path: "/shadow-apis-explained", priority: 0.9, changeFrequency: "monthly" },
  { path: "/browser-automation-is-dead", priority: 0.9, changeFrequency: "monthly" },
  { path: "/mcp-servers-mass-hallucination", priority: 0.85, changeFrequency: "monthly" },
  { path: "/proof-of-indexing", priority: 0.85, changeFrequency: "monthly" },
  { path: "/proof-of-indexing-vs-proof-of-work", priority: 0.85, changeFrequency: "monthly" },
  { path: "/personal-agents", priority: 0.85, changeFrequency: "monthly" },
  { path: "/mine-the-internet", priority: 0.85, changeFrequency: "monthly" },
  { path: "/routing-layer", priority: 0.85, changeFrequency: "monthly" },
  { path: "/agent-fleet-economics", priority: 0.85, changeFrequency: "monthly" },
  { path: "/benchmark-deep-dive", priority: 0.85, changeFrequency: "monthly" },
  { path: "/top-domains-to-mine", priority: 0.8, changeFrequency: "weekly" },

  // comparison pages
  { path: "/compare/playwright", priority: 0.85, changeFrequency: "monthly" },
  { path: "/compare/puppeteer", priority: 0.85, changeFrequency: "monthly" },
  { path: "/compare/browser-use", priority: 0.85, changeFrequency: "monthly" },
  { path: "/compare/crawl4ai", priority: 0.85, changeFrequency: "monthly" },

  // public entry points (low priority but real)
  { path: "/login", priority: 0.6, changeFrequency: "yearly" },
  { path: "/claim", priority: 0.6, changeFrequency: "monthly" },

  // legal
  { path: "/terms", priority: 0.3, changeFrequency: "yearly", lastModified: "2026-02-22" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly", lastModified: "2026-02-22" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return STATIC_ROUTES.map((r) => ({
    url: `${BASE}${r.path}`,
    lastModified: r.lastModified ? new Date(r.lastModified) : now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
