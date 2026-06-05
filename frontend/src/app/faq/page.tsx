import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ — Unbrowse",
  description: "Frequently asked questions about Unbrowse — the API-native browser for AI agents.",
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
    a: "Unbrowse is open-core. The CLI client and SDKs are open source (MIT) and free to install and run locally on your machine. The capture engine and backend are proprietary. You pay only per-use in USDC when your agent executes a route through the shared marketplace — and you can earn USDC for routes you index. There are no subscriptions: a small per-use marketplace fee is the only cost.",
  },
  {
    q: "What websites does Unbrowse support?",
    a: "Unbrowse works with any website that uses APIs to render its frontend, which covers most modern web applications. 600+ domains and 18,000+ endpoints are in the live marketplace today, including Airbnb, LinkedIn, x.com, Reddit, and hundreds of others. When a site's routes cannot be mapped, Unbrowse falls back to standard browser automation so your agent never gets stuck. The list grows on its own: every new capture adds a domain and helps the next agent on the same site.",
  },
  {
    q: "Is Unbrowse secure? Do my credentials leave my machine?",
    a: "Unbrowse runs entirely locally and your credentials never leave your device. There are no cloud proxies, no man-in-the-middle interception, browser cookies stay on your machine, and authentication credentials are encrypted with AES-256-CBC in a local vault. Only the discovered URL templates and schemas (never your data or credentials) are shared with the registry, and only when you opt in via unbrowse mode. That makes Unbrowse safe to install on a work machine without changing your existing security posture.",
  },
  {
    q: "How do I install Unbrowse?",
    a: "Run npx unbrowse setup for a one-command installation that wires up the local runtime and configures your agent host. If Unbrowse is already installed, upgrade with npm install -g unbrowse@latest and rerun unbrowse setup. For skill-based agent platforms like OpenClaw, use npx skills add unbrowse-ai/unbrowse. One install covers Cursor, Windsurf, Claude Code, Claude Desktop, Codex, and any other MCP-aware framework.",
  },
  {
    q: "What is the skill registry?",
    a: "The skill registry is a shared marketplace of mapped API routes. When one agent discovers how to interact with a website's API, the result is published so every other agent can call those endpoints without re-discovering them. Value compounds because every new capture lowers the cost for the next agent that needs the same data, the way Wikipedia gets more useful with every edit. That is what turns Unbrowse from a per-agent tool into shared infrastructure for the agent web.",
  },
];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-28 pb-20">
        <div className="mb-12">
          <Link href="/" className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted hover:text-text-primary transition-colors">
            ← Back
          </Link>
          <span className="eyebrow mt-8" style={{ display: "block" }}>FAQ</span>
          <h1 className="mt-3 text-4xl sm:text-5xl font-bold tracking-tight text-text-primary">
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
