import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ — Unbrowse",
  description: "Frequently asked questions about Unbrowse — the API-native browser for AI agents.",
  alternates: {
    canonical: "https://www.unbrowse.ai/faq",
  },
  openGraph: {
    title: "FAQ — Unbrowse",
    description: "Frequently asked questions about Unbrowse — the API-native browser for AI agents.",
    url: "https://www.unbrowse.ai/faq",
    type: "article",
  },
};

const faqs = [
  {
    q: "How does Unbrowse work?",
    a: "Unbrowse is the API layer for AI agents. The first time your agent visits a site, it captures the real APIs the site uses to render itself, then reuses them on every subsequent call. The shared marketplace already covers 600+ domains and 18,000+ endpoints, so most calls skip the browser entirely and return in 50 to 200 milliseconds. That turns a slow, flaky browser step into a single HTTP call your agent can rely on.",
  },
  {
    q: "How much faster is Unbrowse than headless browser automation?",
    a: "Unbrowse is roughly 100x faster per page than headless browser automation. Headless browsers take 5 to 30 seconds per interaction; Unbrowse makes direct API calls in 50 to 200 milliseconds and uses about 200 tokens per action against 8,000 for scraped HTML. The gap compounds because cached marketplace routes skip discovery entirely on first try. For agent loops where the web step is the bottleneck, that turns minutes of work into seconds.",
  },
  {
    q: "Is Unbrowse free?",
    a: "Yes. Unbrowse is 100% free and open source under the AGPL-3.0 license. There are no paid tiers, no cloud proxies, no usage credits; everything runs locally on your machine. The project is funded by a small fee on agent-to-agent route payments, not by you. So installing costs nothing and stays that way.",
  },
  {
    q: "What websites does Unbrowse support?",
    a: "Unbrowse works with any website that uses APIs to render its frontend, which covers most modern web applications. 600+ domains and 18,000+ endpoints are in the live marketplace today, including Airbnb, LinkedIn, x.com, Reddit, and hundreds of others. When a reusable route cannot be learned, Unbrowse falls back to standard browser automation so your agent never gets stuck. The list grows on its own: every new capture adds a domain and helps the next agent on the same site.",
  },
  {
    q: "Is Unbrowse secure? Do my credentials leave my machine?",
    a: "Unbrowse runs entirely locally and your credentials never leave your device. There are no cloud proxies, no man-in-the-middle interception, browser cookies stay on your machine, and authentication credentials are encrypted with AES-256-CBC in a local vault. Only the discovered URL templates and schemas (never your data or credentials) are shared with the registry, and only when you opt in via unbrowse mode. That makes Unbrowse safe to install on a work machine without changing your existing security posture.",
  },
  {
    q: "How do I install Unbrowse?",
    a: "Run npx unbrowse setup --mcp for a one-command installation that wires Unbrowse up as an MCP server in Claude Code, Cursor, Windsurf, Claude Desktop, Codex, OpenClaw, or any MCP-aware host. If Unbrowse is already installed, upgrade with npm install -g unbrowse@latest and rerun unbrowse setup --mcp. For Claude Code specifically you can also use claude mcp add unbrowse -- npx -y unbrowse mcp. Restart the host once and unbrowse:// resources show up automatically.",
  },
  {
    q: "What is the skill registry?",
    a: "The skill registry is a shared marketplace of reusable API skills. When one agent discovers how to interact with a website's API, the reviewed route metadata is published so every other agent can call those endpoints without re-discovering them. Value compounds because every new capture lowers the cost for the next agent that needs the same data, the way Wikipedia gets more useful with every edit. That is what turns Unbrowse from a per-agent tool into shared infrastructure for the agent web.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.a,
    },
  })),
};

const breadcrumbJsonLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://www.unbrowse.ai",
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "FAQ",
      item: "https://www.unbrowse.ai/faq",
    },
  ],
};

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-28 pb-20">
        <div className="mb-12">
          <Link href="/" className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted hover:text-text-primary transition-colors">
            ← Back
          </Link>
          <h1 className="mt-8 text-4xl sm:text-5xl font-bold tracking-tight text-text-primary">
            Frequently Asked Questions
          </h1>
        </div>

        <div className="divide-y divide-border">
          {faqs.map((faq) => (
            <div key={faq.q} className="py-8">
              <h2 className="text-lg font-semibold mb-3 text-text-primary">{faq.q}</h2>
              <p className="text-text-secondary leading-relaxed">{faq.a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
