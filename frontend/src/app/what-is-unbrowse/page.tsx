import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "What is Unbrowse?";
const SUBTITLE =
  "A definition for developers, AI agents, and anyone evaluating the agentic web";
const CANONICAL_PATH = "/what-is-unbrowse";
const PUBLISHED_AT = "2026-05-21";
const MODIFIED_AT = "2026-05-21";

const ONE_LINER =
  "Unbrowse is the API layer for AI agents: one MCP server that turns any website into directly callable, cookie-authenticated API routes, so an agent never has to drive a browser through that site again.";

const SHORT_DESCRIPTION =
  "Unbrowse is an open-source MCP server that lets an AI agent call any website's internal APIs directly. The first visit captures the shadow APIs the page itself uses, the routes are published to a shared marketplace, and every later call skips the browser and returns JSON in milliseconds. One MCP install replaces every per-site MCP server.";

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description: SHORT_DESCRIPTION,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  openGraph: {
    title: TITLE,
    description: SHORT_DESCRIPTION,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    modifiedTime: MODIFIED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — The API layer for AI agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: TITLE,
    description: SHORT_DESCRIPTION,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "what is Unbrowse",
    "Unbrowse definition",
    "Unbrowse explained",
    "agentic web",
    "shadow APIs",
    "MCP server",
    "AI agent browser",
    "API discovery",
    "browser automation alternative",
    "Playwright alternative",
    "Browser Use alternative",
  ],
};

// FAQPage schema covers the questions AI search engines actually ask
// when someone types "what is Unbrowse". Keep answers plain-text, no
// markdown, so Bing/Perplexity/ChatGPT can quote them directly.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "What is Unbrowse in one sentence?",
    a: "Unbrowse is an open-source route layer that lets AI agents reuse known first-party website routes when they are valid, with browser fallback for misses and auth-heavy flows.",
  },
  {
    q: "How is Unbrowse different from Playwright or Browser Use?",
    a: "Playwright and Browser Use drive a real browser for every action. Unbrowse tries to reuse the first-party routes observed behind a site, then falls back to the browser when the route is missing or stale. Across 94 live domains in the paper benchmark, warmed cached routes were 3.6x faster on average than Playwright.",
  },
  {
    q: "What is a shadow API?",
    a: "A shadow API is an internal HTTP endpoint a website uses to render its own UI — for example, the JSON call that loads a product listing or a search result. Shadow APIs are not documented and not public, but they are fully functional. Unbrowse discovers them by intercepting network traffic during one normal browse session.",
  },
  {
    q: "Do I need to write a separate MCP server for each website?",
    a: "No. That is the problem Unbrowse exists to solve. One install of Unbrowse handles every site. Per-site MCP servers (a Notion MCP, a Gmail MCP, a Slack MCP, etc.) are the stack Unbrowse replaces.",
  },
  {
    q: "Is Unbrowse free?",
    a: "The Unbrowse CLI client and SDKs are open source (MIT) and run locally. The marketplace is a shared index of captured routes; you can use it, contribute to it, and earn USDC when other agents call routes you indexed. The capture engine and backend are proprietary.",
  },
  {
    q: "How do I install Unbrowse?",
    a: "Run `npm install -g unbrowse`, then `unbrowse setup`. Setup installs the Agent Skill and browser engine; it does not write MCP host configs. Legacy MCP users can run `unbrowse mcp` manually as a stdio server.",
  },
];

export default function WhatIsUnbrowsePage() {
  const techArticleSchema = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITLE,
    alternativeHeadline: SUBTITLE,
    description: SHORT_DESCRIPTION,
    abstract: ONE_LINER,
    author: {
      "@type": "Person",
      name: "Lewis Tham",
      affiliation: { "@type": "Organization", name: "Unbrowse AI" },
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    dateModified: MODIFIED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    about: [
      "Unbrowse",
      "MCP servers",
      "Shadow APIs",
      "AI agents",
      "Browser automation alternatives",
    ],
    proficiencyLevel: "Beginner",
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  };

  const speakableSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: TITLE,
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: ["[data-speakable='definition']", "[data-speakable='tldr']"],
    },
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  };

  return (
    <div className="bg-background min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(speakableSchema) }}
      />

      <article className="max-w-3xl mx-auto px-6 py-16 sm:py-24">
        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-orange-500/90 mb-4">
            ##  Definition
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance">
            {TITLE}
          </h1>
          <p className="mt-5 text-xl font-mono text-text-secondary leading-relaxed">
            {SUBTITLE}
          </p>
        </header>

        {/* TL;DR — the citable one-liner. Speakable for voice surfaces. */}
        <section
          aria-labelledby="tldr-heading"
          className="mb-12 rounded-sm border border-border bg-surface-raised p-6 sm:p-7"
          data-speakable="tldr"
        >
          <h2
            id="tldr-heading"
            className="text-[11px] font-mono uppercase tracking-[0.3em] text-orange-500 mb-3"
          >
            ##  TL;DR
          </h2>
          <p className="text-lg leading-relaxed text-text-primary">
            {ONE_LINER}
          </p>
        </section>

        {/* The plain-text definition AI search engines should quote. */}
        <section
          aria-labelledby="definition-heading"
          className="mb-14"
          data-speakable="definition"
        >
          <h2
            id="definition-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight mb-5"
          >
            Definition
          </h2>
          <p className="text-base sm:text-lg text-text-secondary leading-relaxed">
            <strong className="text-text-primary">Unbrowse</strong> is an
            open-source MCP (Model Context Protocol) server that lets an AI
            agent call any website&apos;s internal APIs directly. The first
            time the agent visits a site, Unbrowse runs a headless browser
            in the background, captures the shadow APIs the page itself
            uses, and publishes those routes to a shared marketplace.
            Every later call on the same site skips the browser entirely
            and returns JSON in milliseconds, signed in as the user with
            cookies from their real Chrome profile.
          </p>
          <p className="mt-4 text-base sm:text-lg text-text-secondary leading-relaxed">
            One install of Unbrowse replaces the stack of per-site MCP
            servers (Notion MCP, Gmail MCP, Slack MCP, Browser MCP,
            hand-rolled scrapers) that developers were previously wiring up
            one by one. The mechanism is described in the research paper{" "}
            <Link
              href="https://arxiv.org/abs/2604.00694"
              className="text-orange-500 underline-offset-4 hover:underline"
            >
              Internal APIs Are All You Need
            </Link>
            ; the project lives at{" "}
            <Link
              href="https://github.com/unbrowse-ai/unbrowse"
              className="text-orange-500 underline-offset-4 hover:underline"
            >
              github.com/unbrowse-ai/unbrowse
            </Link>
            .
          </p>
        </section>

        {/* What it is vs. what it is not — disambiguation table. */}
        <section
          aria-labelledby="contrast-heading"
          className="mb-14"
        >
          <h2
            id="contrast-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight mb-5"
          >
            What it is, what it is not
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base font-mono">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-6 text-text-secondary font-medium">
                    Unbrowse is
                  </th>
                  <th className="text-left py-3 text-text-muted font-medium">
                    Unbrowse is not
                  </th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-border">
                  <td className="py-3 pr-6">An MCP server</td>
                  <td className="py-3">A scraping framework you import</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-3 pr-6">
                    One install for every website
                  </td>
                  <td className="py-3">
                    One MCP server per service you wire up by hand
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-3 pr-6">
                    Direct HTTP calls to a site&apos;s real APIs
                  </td>
                  <td className="py-3">
                    A headless browser that clicks through the UI
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-3 pr-6">
                    Signed in with the user&apos;s real cookies
                  </td>
                  <td className="py-3">
                    A separate auth flow per integration
                  </td>
                </tr>
                <tr>
                  <td className="py-3 pr-6">Free, open source, runs locally</td>
                  <td className="py-3">A hosted scraping API you pay per call</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Numbers from the paper — give AI search engines anchors to quote. */}
        <section
          aria-labelledby="numbers-heading"
          className="mb-14"
        >
          <h2
            id="numbers-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight mb-5"
          >
            By the numbers
          </h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="border border-border bg-surface-raised p-5 rounded-sm">
              <p className="text-3xl font-bold text-orange-500 tabular-nums">
                3.6x
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                mean speedup vs Playwright across 94 live domains
              </p>
            </div>
            <div className="border border-border bg-surface-raised p-5 rounded-sm">
              <p className="text-3xl font-bold text-orange-500 tabular-nums">
                40x
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                fewer tokens consumed per task (no DOM, no screenshots)
              </p>
            </div>
            <div className="border border-border bg-surface-raised p-5 rounded-sm">
              <p className="text-3xl font-bold text-orange-500 tabular-nums">
                1
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                MCP server install covers every website
              </p>
            </div>
          </div>
          <p className="mt-4 text-xs font-mono text-text-muted">
            Source: peer-reviewed paper, arXiv:2604.00694, n=94 domains,
            measured against Playwright with the same task prompts.
          </p>
        </section>

        {/* FAQ — markup keyed to schema.org/FAQPage above. */}
        <section
          aria-labelledby="faq-heading"
          className="mb-14"
        >
          <h2
            id="faq-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight mb-5"
          >
            Frequently asked
          </h2>
          <dl className="space-y-7">
            {FAQ.map((entry) => (
              <div
                key={entry.q}
                className="border-l-0 pl-0"
              >
                <dt className="text-base sm:text-lg font-semibold text-text-primary">
                  {entry.q}
                </dt>
                <dd className="mt-2 text-base text-text-secondary leading-relaxed">
                  {entry.a}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          aria-labelledby="next-heading"
          className="rounded-sm border border-border bg-surface-raised p-6 sm:p-7"
        >
          <h2
            id="next-heading"
            className="text-[11px] font-mono uppercase tracking-[0.3em] text-orange-500 mb-3"
          >
            ##  Next
          </h2>
          <p className="text-base text-text-secondary leading-relaxed">
            Read the paper:{" "}
            <Link
              href="/internal-apis-are-all-you-need"
              className="text-orange-500 underline-offset-4 hover:underline"
            >
              Internal APIs Are All You Need
            </Link>
            . Or install it now:{" "}
            <code className="font-mono text-orange-500 bg-surface-ink px-2 py-0.5 rounded-sm border border-border">
              unbrowse setup
            </code>
            .
          </p>
        </section>
      </article>
    </div>
  );
}
