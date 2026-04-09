import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ — Unbrowse",
  description: "Frequently asked questions about Unbrowse — the API-native browser for AI agents.",
};

const faqs = [
  {
    q: "How does Unbrowse work?",
    a: "Unbrowse is a drop-in replacement for browser automation when you want API-native access to the web. It opens a local browser, captures network traffic as you interact with a site, and reverse-engineers the shadow API endpoints that power the frontend. Once discovered, these endpoints are stored as reusable skills so your agent can call them directly — no browser required.",
  },
  {
    q: "How much faster is Unbrowse than headless browser automation?",
    a: "Unbrowse is approximately 100x faster per page. Headless browsers typically take 5–30 seconds per page interaction. Unbrowse makes direct API calls in 50–200 milliseconds. It also uses ~200 tokens per action compared to ~8,000 tokens for scraped HTML, a 40x reduction.",
  },
  {
    q: "Is Unbrowse free?",
    a: "Yes. Unbrowse is 100% free and open source under the AGPL-3.0 license. There are no paid tiers, cloud proxies, or usage credits. Everything runs locally on your machine.",
  },
  {
    q: "What websites does Unbrowse support?",
    a: "Unbrowse works with any website that uses shadow APIs to power its frontend — which includes most modern web applications. Sites like Airbnb, LinkedIn, and hundreds of others have been successfully mapped. When a site cannot be reverse-engineered, Unbrowse falls back to standard browser automation.",
  },
  {
    q: "Is Unbrowse secure? Do my credentials leave my machine?",
    a: "Unbrowse runs entirely locally. There are no cloud proxies, no man-in-the-middle interception, and your browser cookies never leave your device. Authentication credentials are encrypted with AES-256-CBC in a local vault. Only discovered API endpoint patterns (not data or credentials) are shared with the registry.",
  },
  {
    q: "How do I install Unbrowse?",
    a: "Run npx unbrowse setup for a one-command installation that sets up browser assets and configures your agent host. If Unbrowse is already installed, upgrade with npm install -g unbrowse@latest and rerun unbrowse setup. For skill-based agent platforms like OpenClaw, use npx skills add unbrowse-ai/unbrowse.",
  },
  {
    q: "What is the skill registry?",
    a: "The skill registry is a shared marketplace of reverse-engineered API skills. When one agent discovers how to interact with a website's API, that knowledge is published to the registry so every other agent can use it instantly — no need to re-discover the same endpoints.",
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
