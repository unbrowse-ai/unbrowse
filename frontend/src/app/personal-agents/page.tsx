import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Your Personal Agent Is 3.6x Slower Than It Should Be";
const SUBTITLE =
  "One plugin gives your OpenClaw agent instant API access to any website — no browser needed.";
const CANONICAL_PATH = "/personal-agents";
const PUBLISHED_AT = "2026-04-02";
const ARXIV_URL = "https://arxiv.org/abs/2604.00694";
const INSTALL_CMD = "openclaw plugins install unbrowse-openclaw";

const description = `Personal AI agents spend 80% of their time waiting for web pages to load — rendering pixels they will never see, parsing DOM they do not need, burning API credits on vision tokens. The websites your agent visits already have clean JSON APIs behind their UI. The Unbrowse plugin for OpenClaw gives your agent direct access to those APIs. 3.6x faster, 106x cheaper, zero browser overhead.`;

const examples = [
  {
    task: "Search Airbnb for Tokyo stays",
    browser: { time: "3.4 seconds", tokens: "~8,000", reliability: "Works most of the time" },
    unbrowse: { time: "0.4 seconds", tokens: "~200", reliability: "Works every time" },
  },
  {
    task: "Find cheapest flights on Google Flights",
    browser: { time: "8–12 seconds", tokens: "~15,000", reliability: "Fails ~50% of the time" },
    unbrowse: { time: "0.6 seconds", tokens: "~350", reliability: "Works every time" },
  },
  {
    task: "Check GitHub notifications",
    browser: { time: "4.2 seconds", tokens: "~6,000", reliability: "Fragile — DOM changes break it" },
    unbrowse: { time: "47 milliseconds", tokens: "~120", reliability: "One GET request, always works" },
  },
];

const sections = [
  {
    title: "The problem: your agent browses like a human",
    body: `When your personal agent needs to check flight prices, search for an apartment, or look up your GitHub notifications, it does something absurd. It launches a headless browser, loads the full page with all its JavaScript, CSS, and images, takes a screenshot, sends those pixels to a vision model, and asks the model to figure out what is on the screen. Then it clicks something and does it all again.

The website your agent just "visited" returned clean, structured JSON from its own API before a single pixel was rendered. Your agent threw that away and reconstructed it from screenshots.

This is like printing a spreadsheet, taking a photo of it, and using OCR to get the numbers back.`,
  },
  {
    title: "What the Unbrowse plugin actually does",
    body: `When your OpenClaw agent gets a web task — "find me flights to Tokyo" or "check my GitHub notifications" — the Unbrowse plugin intercepts it before the browser launches. It checks a shared index of known API routes. If a route exists (and for popular sites, it almost always does), your agent gets clean JSON data back in under 100 milliseconds. No browser. No screenshots. No vision tokens.

If no route exists yet, the plugin falls back to normal browser automation. But here is the key part: while the browser runs, Unbrowse watches the network traffic, discovers the API calls the website made, reverse-engineers their schemas, and publishes them to the shared index. The next agent that hits the same site gets instant API access.

One person browses Airbnb. Every agent after that gets the API route for free.`,
  },
  {
    title: "Why this matters for personal agents",
    body: `Personal agents are different from enterprise automation, because every wasted token comes out of your pocket. You run them on your own machine, often with local models, paying per call. Browser automation alone burns roughly $0.53 per action when you add compute, vision tokens, and the LLM calls needed to interpret screenshots, against $0.005 for a cached API hit. The gap is 106x, and it shows up directly on your bill.

Run twenty web tasks a day and the difference is concrete: about $10.60 daily through a browser, or $0.10 through Unbrowse. Over a month, that is $318 versus $3, on the same workload. Cost is the throttle on how often you actually let your agent work for you, so closing the gap turns "ask sometimes" into "run all day".`,
  },
  {
    title: "40x fewer tokens — critical for local models",
    body: `If you are running your agent on a local model — Llama, Mistral, Phi, or anything else that fits on your hardware — context window is everything. Browser automation burns through your context window at an alarming rate. A single page screenshot converted to text can consume 8,000 to 15,000 tokens. Your model's entire context window might only be 32K or 64K tokens.

Unbrowse returns structured JSON that typically uses 200 to 400 tokens. That means your local model can handle 40 times more web interactions before hitting its context limit. For multi-step tasks like "research flights, compare prices, and book the cheapest one," this is the difference between completing the task and running out of context halfway through.`,
  },
  {
    title: "Routes are shared — the network gets smarter",
    body: `Every Unbrowse user contributes to the shared route graph. When someone browses a new website, the API routes they discover become available to every other agent on the network. Right now, the index covers hundreds of popular sites with thousands of verified API endpoints.

This creates a flywheel: more users means more routes discovered, which means more cache hits, which means faster agents, which means more users. The most popular sites — the ones your agent visits most often — are the ones with the best coverage.

And with x402 micropayments, your agent can earn USDC when other agents use routes it discovered. Your browsing session on a niche site becomes passive income every time another agent hits those routes.`,
  },
];

const stats = [
  { value: "3.6x", label: "mean speedup over Playwright" },
  { value: "5.4x", label: "median speedup" },
  { value: "106x", label: "cheaper per action" },
  { value: "40x", label: "fewer tokens per task" },
  { value: "<100ms", label: "cached route response" },
  { value: "94", label: "domains benchmarked" },
];

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  openGraph: {
    title: TITLE,
    description,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — Your personal agent is 3.6x slower than it should be",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@getFoundry",
    title: TITLE,
    description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "openclaw plugin",
    "personal AI agent",
    "AI agent browser speed",
    "openclaw unbrowse",
    "AI agent web automation",
    "agent-native browser",
    "unbrowse openclaw plugin",
    "AI agent API access",
    "personal agent faster",
    "openclaw plugins",
    "AI agent browser alternative",
    "web automation for AI agents",
  ],
};

export default function PersonalAgentsPage() {
  const blogPosting = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: TITLE,
    description,
    author: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    mainEntityOfPage: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    keywords: (metadata.keywords as string[]).join(", "),
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPosting) }}
      />

      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-orange-600 hover:text-orange-500 transition-colors"
          >
            &larr; Back to Unbrowse
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Blog
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {SUBTITLE}
          </p>
          <p className="mt-4 text-sm text-text-secondary">
            Published {PUBLISHED_AT}
          </p>
        </header>

        {/* Lede */}
        <section className="mb-12">
          <p className="text-lg sm:text-xl leading-8 text-text-secondary">
            Your personal AI agent spends most of its time doing something
            remarkably wasteful: browsing the web like a human. It launches a
            browser, loads full pages of JavaScript, takes screenshots, and sends
            pixels to a vision model just to extract data that was already
            available as clean JSON before the page even rendered. Every website
            your agent visits has structured APIs behind its UI. Your agent just
            does not know about them yet.
          </p>
          <p className="mt-4 text-lg sm:text-xl leading-8 text-text-secondary">
            One plugin changes that.
          </p>
        </section>

        {/* Install CTA */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Install in one command
          </h2>
          <div className="bg-surface-sunken rounded-lg p-4 font-mono text-sm sm:text-base overflow-x-auto">
            <code className="text-orange-600">{INSTALL_CMD}</code>
          </div>
          <p className="mt-3 text-sm text-text-secondary">
            Works with OpenClaw v0.7.17 and above. Your agent will try Unbrowse
            first for any web task, and fall back to the browser only when no
            route exists.
          </p>
        </section>

        {/* Stats grid */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            The numbers
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-border p-4 sm:p-5"
              >
                <div className="text-3xl sm:text-4xl font-bold text-orange-600">
                  {stat.value}
                </div>
                <div className="mt-1 text-sm text-text-secondary">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-text-secondary">
            Benchmarked across 94 live domains.{" "}
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500"
            >
              Read the full paper on arXiv&nbsp;&rarr;
            </a>
          </p>
        </section>

        {/* Real examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            Real examples: browser vs. Unbrowse
          </h2>
          <div className="space-y-6">
            {examples.map((ex) => (
              <div
                key={ex.task}
                className="rounded-xl border border-border overflow-hidden"
              >
                <div className="bg-surface-sunken px-4 py-3 sm:px-6 sm:py-4 border-b border-border">
                  <h3 className="font-semibold text-base sm:text-lg">
                    &ldquo;{ex.task}&rdquo;
                  </h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
                  <div className="p-4 sm:p-6">
                    <div className="text-xs font-mono uppercase tracking-widest text-text-secondary mb-3">
                      Browser automation
                    </div>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-text-secondary">Time:</span>{" "}
                        <span className="font-medium">{ex.browser.time}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Tokens:</span>{" "}
                        <span className="font-medium">
                          {ex.browser.tokens}
                        </span>
                      </div>
                      <div>
                        <span className="text-text-secondary">
                          Reliability:
                        </span>{" "}
                        <span className="font-medium">
                          {ex.browser.reliability}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="p-4 sm:p-6">
                    <div className="text-xs font-mono uppercase tracking-widest text-orange-600 mb-3">
                      With Unbrowse
                    </div>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-text-secondary">Time:</span>{" "}
                        <span className="font-medium text-orange-600">
                          {ex.unbrowse.time}
                        </span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Tokens:</span>{" "}
                        <span className="font-medium text-orange-600">
                          {ex.unbrowse.tokens}
                        </span>
                      </div>
                      <div>
                        <span className="text-text-secondary">
                          Reliability:
                        </span>{" "}
                        <span className="font-medium text-orange-600">
                          {ex.unbrowse.reliability}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Main content sections */}
        <section className="space-y-10 mb-12">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="text-2xl font-semibold tracking-tight mb-3">
                {section.title}
              </h2>
              {section.body.split("\n\n").map((paragraph, i) => (
                <p
                  key={i}
                  className="text-base sm:text-lg leading-8 text-text-secondary mt-3 first:mt-0"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
        </section>

        {/* How it works */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How it works in practice
          </h2>
          <div className="space-y-4 text-base sm:text-lg leading-8 text-text-secondary">
            <p>After installing the plugin, you do not need to change anything about how you use your agent. Just give it tasks the way you normally would.</p>
            <ol className="list-decimal pl-5 space-y-3">
              <li>
                You tell your agent: &ldquo;Find me a one-bedroom in Tokyo for
                next week on Airbnb.&rdquo;
              </li>
              <li>
                The plugin checks the shared route index. Airbnb&apos;s search
                API is already cached.
              </li>
              <li>
                Your agent gets structured JSON results in 400 milliseconds.
                No browser launched. No screenshots taken.
              </li>
              <li>
                If you ask about a niche site with no cached routes, the plugin
                falls back to the browser, discovers the routes while browsing,
                and shares them.
              </li>
            </ol>
            <p>
              The experience is invisible. Your agent just gets faster. Tasks
              that used to take 5 to 10 seconds happen in under a second. Tasks
              that used to fail because the DOM changed now work reliably every
              time.
            </p>
          </div>
        </section>

        {/* Cost breakdown */}
        <section className="mb-12 rounded-2xl border border-border p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Cost comparison: 20 web tasks per day
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:text-base">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 text-text-secondary font-medium">
                    &nbsp;
                  </th>
                  <th className="text-left py-3 pr-4 text-text-secondary font-medium">
                    Browser automation
                  </th>
                  <th className="text-left py-3 text-orange-600 font-medium">
                    With Unbrowse
                  </th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">
                    Per action
                  </td>
                  <td className="py-3 pr-4">$0.53</td>
                  <td className="py-3 text-orange-600 font-medium">$0.005</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-3 pr-4 font-medium text-text-primary">
                    Daily (20 tasks)
                  </td>
                  <td className="py-3 pr-4">$10.60</td>
                  <td className="py-3 text-orange-600 font-medium">$0.10</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-medium text-text-primary">
                    Monthly
                  </td>
                  <td className="py-3 pr-4">$318</td>
                  <td className="py-3 text-orange-600 font-medium">$3</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Works with everything */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Works with every agent framework
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            The OpenClaw plugin is the fastest way to get started, but Unbrowse
            works with any agent that can make HTTP calls. Claude Code, Cursor,
            Windsurf, custom agents built with LangChain or CrewAI — if your
            agent can call a CLI or make an HTTP request, it can use Unbrowse.
          </p>
          <div className="bg-surface-sunken rounded-lg p-4 font-mono text-sm overflow-x-auto space-y-2">
            <div>
              <span className="text-text-secondary"># OpenClaw plugin</span>
            </div>
            <div>
              <code className="text-orange-600">{INSTALL_CMD}</code>
            </div>
            <div className="mt-3">
              <span className="text-text-secondary"># Any agent via npm</span>
            </div>
            <div>
              <code className="text-orange-600">curl -fsSL https://unbrowse.ai/install.sh | bash</code>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Stop paying the browser tax
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Your agent deserves to be fast. Install the plugin, and every web
            task your agent runs gets faster, cheaper, and more reliable
            starting immediately. No configuration. No API keys. One command.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="bg-surface-sunken rounded-lg px-5 py-3 font-mono text-sm sm:text-base">
              <code className="text-orange-600">{INSTALL_CMD}</code>
            </div>
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors text-sm sm:text-base"
            >
              Read the paper on arXiv
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors text-sm sm:text-base"
            >
              View on GitHub
            </a>
          </div>
        </section>
      </article>
    </div>
  );
}
