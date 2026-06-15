import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ — Unbrowse",
  description: "Frequently asked questions about Unbrowse — the API-native browser for AI agents.",
};

const faqs = [
  {
    q: "How does Unbrowse work?",
    a: "Unbrowse is a route layer for AI agents on the web. It learns the first-party routes a site already calls behind its UI, then reuses those routes when they are still valid. If a route is missing or stale, the runtime falls back to browser capture or ordinary browser automation rather than pretending the cache hit.",
  },
  {
    q: "How much faster is Unbrowse than headless browser automation?",
    a: "In the Internal APIs Are All You Need benchmark, warmed cached routes averaged a 3.6x mean speedup and 5.4x median speedup over Playwright across 94 live domains. The reason is simple: a known route avoids repeated page rendering, DOM inspection, and token-heavy HTML parsing.",
  },
  {
    q: "Is Unbrowse free?",
    a: "The CLI client and SDKs are open source and free to install and run locally. Marketplace lookups or paid route execution can require x402 payment in USDC; route capture and local execution remain separate from those paid paths. Contributors can also earn when maintained routes they indexed are reused.",
  },
  {
    q: "What websites does Unbrowse support?",
    a: "Unbrowse works best on sites whose frontends call structured first-party routes, which is common on modern web applications. Some routes are already cached; unknown or hostile sites may require browser capture or remain misses. Misses are recorded honestly rather than counted as route successes.",
  },
  {
    q: "Is Unbrowse secure? Do my credentials leave my machine?",
    a: "Unbrowse runs entirely locally and your credentials never leave your device. There are no cloud proxies, no man-in-the-middle interception, browser cookies stay on your machine, and authentication credentials are encrypted with AES-256-CBC in a local vault. Only the discovered URL templates and schemas (never your data or credentials) are shared with the registry, and only when you opt in via unbrowse mode. That makes Unbrowse safe to install on a work machine without changing your existing security posture.",
  },
  {
    q: "How do I install Unbrowse?",
    a: "Run npm install -g unbrowse, then unbrowse setup. Setup installs the Agent Skill and browser engine; it does not write MCP host configs. If Unbrowse is already installed, upgrade with npm install -g unbrowse@latest and rerun unbrowse setup.",
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
