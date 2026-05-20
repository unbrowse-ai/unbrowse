import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Your OpenClaw Agent Can Earn Money While It Works For You";
const SUBTITLE =
  "Every web task your agent runs discovers API routes. Other agents pay to use them. You earn USDC.";
const CANONICAL_PATH = "/openclaw-earn";
const PUBLISHED_AT = "2026-04-02";
const INSTALL_CMD = "openclaw plugins install unbrowse-openclaw";

const description = `You already use your OpenClaw agent to browse the web, search, book things, and research. With one plugin, every web interaction your agent makes starts earning you USDC. Your agent discovers API routes that other people's agents pay to use. You do nothing different — your agent just got a side hustle.`;

const dayTimeline = [
  {
    time: "8:00 AM",
    task: "Agent checks your email",
    detail:
      "Your agent opens Gmail to scan your inbox. While it works, the Unbrowse plugin quietly captures Gmail's internal API routes — message list, thread fetch, label filters. These get indexed and published to the shared route graph.",
    routes: "4 Gmail API routes indexed",
    icon: "mail",
  },
  {
    time: "10:00 AM",
    task: "Agent researches competitors",
    detail:
      "You ask your agent to pull the latest posts from Hacker News and check a competitor's LinkedIn page. Both sites have internal APIs your agent discovers on the fly. HN's Algolia search endpoint, LinkedIn's profile data API — all captured, all published.",
    routes: "7 routes across HN + LinkedIn",
    icon: "search",
  },
  {
    time: "12:00 PM",
    task: "Agent books lunch",
    detail:
      "\"Find me a table for two at an Italian place near the office.\" Your agent hits OpenTable, discovers the restaurant search and availability endpoints, and books your reservation. Those routes are now in the graph for every other agent to use.",
    routes: "3 OpenTable API routes indexed",
    icon: "calendar",
  },
  {
    time: "3:00 PM",
    task: "Agent deploys your code",
    detail:
      "Your agent checks your Vercel dashboard, triggers a deployment, and monitors the build. The Vercel project list, deployment trigger, and build status endpoints all get captured. Developer tools are high-value routes — other agents need them constantly.",
    routes: "5 Vercel API routes indexed",
    icon: "code",
  },
  {
    time: "6:00 PM",
    task: "You check your earnings",
    detail:
      "You did nothing special today. Your agent just did its job. But 94 other agents used routes your agent discovered — the Gmail thread endpoint was especially popular. Your wallet shows $0.47 in USDC earned today, up from $0.31 yesterday.",
    routes: "$0.47 earned from 94 route uses",
    icon: "wallet",
  },
];

const earnings = [
  { label: "Per route use", value: "$0.0035", note: "70% of $0.005 fee" },
  { label: "Today", value: "$0.47", note: "94 route uses by other agents" },
  { label: "This week", value: "$2.84", note: "building momentum" },
  { label: "This month (projected)", value: "$14.20", note: "as your routes gain traffic" },
];

const sections: { title: string; body: string[] }[] = [
  {
    title: "One plugin. Zero behavior change.",
    body: [
      "Install the Unbrowse plugin for OpenClaw and forget about it. Your agent keeps doing exactly what it already does — browsing websites, filling forms, pulling data, completing tasks. The only difference is that now, every website your agent touches gets its internal API routes captured, indexed, and published to a shared network.",
      "These are not scraping hacks or brittle workarounds. Every modern website uses internal APIs to power its own interface. When you load Gmail, your browser makes clean JSON API calls to fetch your messages. When you search Airbnb, the results come from a structured search endpoint before any pixel renders. Your agent discovers these real APIs and makes them available to every other agent on the network.",
    ],
  },
  {
    title: "Other agents pay to use your routes",
    body: [
      "Here is how the money works. When your agent discovers a route — say, OpenTable's restaurant search API — that route gets published to the shared route graph. The next time any agent on the network needs to search OpenTable, it uses your cached route instead of launching a slow, expensive browser session. That agent pays $0.005 for the route use. You get 70% of that — $0.0035 — deposited directly to your wallet in USDC.",
      "This is not a token. It is not points. It is not credits. It is USDC — a dollar-pegged stablecoin on Solana and Base. Real money you can withdraw, swap to your bank account, or spend however you want. The payment happens inline with every route use, settled instantly on-chain.",
    ],
  },
  {
    title: "Why agents pay for routes",
    body: [
      "This is not charity. Agents pay for cached routes because they are dramatically better than the alternative. A browser-based web action costs roughly $0.53 when you factor in compute, vision model tokens, and the time to render and screenshot a page. A cached route costs $0.005. That is 106 times cheaper.",
      "Speed matters too. A cached route returns data in under 100 milliseconds. A browser session takes 3 to 12 seconds. For agents running multi-step tasks, the difference between a sub-second response and a 10-second browser load is the difference between completing the task and timing out.",
      "Agents are economically rational. Given the choice, they will always pick the faster, cheaper option. Your routes are that option.",
    ],
  },
  {
    title: "First to index a site? Earn 2x for 30 days.",
    body: [
      "Be the first person whose agent indexes a domain and you earn a 2x reward multiplier on every route from that domain for 30 days. If your agent is the first to discover Notion's internal APIs, you earn $0.007 per route use instead of $0.0035. For popular domains, that adds up fast.",
      "This is not about racing to claim worthless territory. The bonus only applies when agents actually use the routes. There is no incentive to index obscure sites nobody visits. The reward goes to people whose agents discover useful, high-demand routes that other agents need.",
      "Right now, thousands of websites have not been indexed yet. Every site your agent visits for the first time is a potential first-mover claim.",
    ],
  },
  {
    title: "Your agent pays for itself",
    body: [
      "Most OpenClaw users spend $30 to $100 per month running their agent — API costs, compute, model tokens. The routes your agent discovers while doing its normal work generate passive income that offsets those costs. At current network growth rates, active users are covering their agent costs within the first month.",
      "And it compounds. The more your agent browses, the more routes it discovers. The more routes you have in the graph, the more you earn. A user who has been on the network for three months has hundreds of routes generating daily income. Six months in, many contributors earn more from route payments than they spend on their agent.",
      "Your agent is not just a productivity tool anymore. It is an asset that appreciates with use.",
    ],
  },
  {
    title: "USDC on Solana and Base — not another token",
    body: [
      "There is no Unbrowse token. There is no speculative asset to buy and hope goes up. Contributors earn in USDC — a stable dollar-equivalent currency. When your wallet shows $0.47, that is $0.47 you can withdraw today.",
      "Payments settle on Solana and Base, chosen for fast finality and low transaction costs. A micropayment of $0.0035 would be impossible on traditional payment rails — Stripe's minimum fee alone would eat the entire amount. Crypto rails make sub-cent payments practical.",
      "You can connect any Solana or Base wallet. Earnings accumulate and you can withdraw at any time. No minimums, no lock-ups, no vesting schedules.",
    ],
  },
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
    publishedTime: PUBLISHED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/og-image.png",
        width: 1200,
        height: 630,
        alt: "Unbrowse — Your OpenClaw agent can earn money while it works for you",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: TITLE,
    description,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
  keywords: [
    "openclaw earn money",
    "AI agent passive income",
    "personal agent earnings",
    "openclaw plugin earn",
    "AI agent earn USDC",
    "openclaw unbrowse",
    "personal AI agent income",
    "agent side hustle",
    "earn from browsing",
    "openclaw passive earning",
    "AI agent micropayments",
    "unbrowse earn",
    "agent route marketplace",
    "earn crypto browsing",
  ],
};

export default function OpenClawEarnPage() {
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
            You already use your OpenClaw agent to browse the web, research
            topics, book reservations, manage your inbox, and deploy code. It is
            your personal assistant that handles the internet for you.
          </p>
          <p className="mt-4 text-lg sm:text-xl leading-8 text-text-secondary">
            What if every one of those tasks also earned you money?
          </p>
          <p className="mt-4 text-lg sm:text-xl leading-8 text-text-secondary">
            With one plugin, your agent starts discovering the hidden API routes
            behind every website it visits. Other people&apos;s agents pay to use
            those routes. You earn USDC. You do not change how you use your agent
            at all.
          </p>
        </section>

        {/* Install CTA */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Install in one command
          </h2>
          <div className="bg-surface-sunken rounded-lg p-4 font-mono text-sm sm:text-base overflow-x-auto">
            <span className="text-text-secondary/60 select-none">$ </span>
            <code className="text-orange-600">{INSTALL_CMD}</code>
          </div>
          <p className="mt-3 text-sm text-text-secondary">
            Works with OpenClaw v0.7.17 and above. Your agent browses normally.
            Earning starts immediately.
          </p>
        </section>

        {/* Earnings at a glance */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            What passive earning looks like
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {earnings.map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-border p-4 sm:p-5"
              >
                <div className="text-2xl sm:text-3xl font-bold text-orange-600">
                  {item.value}
                </div>
                <div className="mt-1 text-sm font-medium text-text-primary">
                  {item.label}
                </div>
                <div className="mt-0.5 text-xs text-text-secondary">
                  {item.note}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-text-secondary">
            Based on a typical user browsing 15-20 sites per day with the plugin
            active. Earnings grow as more agents join the network and use your
            routes.
          </p>
        </section>

        {/* Day in the life */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            A day in the life: your agent earns while you work
          </h2>
          <div className="space-y-4">
            {dayTimeline.map((item, idx) => (
              <div
                key={item.time}
                className="rounded-xl border border-border overflow-hidden"
              >
                <div className="flex items-start">
                  <div className="flex-shrink-0 w-20 sm:w-24 bg-surface-sunken border-r border-border p-4 sm:p-5 text-center">
                    <div className="text-xs font-mono uppercase tracking-widest text-text-secondary">
                      {item.time}
                    </div>
                  </div>
                  <div className="flex-1 p-4 sm:p-5">
                    <h3 className="font-semibold text-base sm:text-lg">
                      {item.task}
                    </h3>
                    <p className="mt-2 text-sm sm:text-base text-text-secondary leading-relaxed">
                      {item.detail}
                    </p>
                    <div className="mt-3 inline-block rounded-full bg-orange-50/50 dark:bg-orange-950/20 border border-orange-500/20 px-3 py-1 text-xs font-medium text-orange-600">
                      {item.routes}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Key numbers */}
        <section className="mb-12 rounded-2xl border border-border p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The numbers behind it
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-base sm:text-lg">
            <div>
              <div className="text-3xl font-bold text-orange-600">$0.005</div>
              <div className="text-text-secondary mt-1">
                Per route use (what agents pay)
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">70%</div>
              <div className="text-text-secondary mt-1">
                Goes to the contributor who indexed the route
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">2x</div>
              <div className="text-text-secondary mt-1">
                First-mover bonus for 30 days on new domains
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">106x</div>
              <div className="text-text-secondary mt-1">
                Cheaper than browser automation — why agents always pick routes
              </div>
            </div>
          </div>
        </section>

        {/* Main content sections */}
        <section className="space-y-10 mb-12">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="text-2xl font-semibold tracking-tight mb-3">
                {section.title}
              </h2>
              {section.body.map((paragraph, i) => (
                <p
                  key={i}
                  className="text-base sm:text-lg leading-8 text-text-secondary mb-4 last:mb-0"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
        </section>

        {/* How earnings grow */}
        <section className="mb-12 overflow-x-auto">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How earnings grow over time
          </h2>
          <table className="w-full text-sm sm:text-base border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Time on network
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Routes indexed
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Daily uses by others
                </th>
                <th className="py-3 font-semibold text-text-primary">
                  Monthly earnings
                </th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Week 1</td>
                <td className="py-3 pr-4">~30</td>
                <td className="py-3 pr-4">50-80</td>
                <td className="py-3 text-orange-600 font-medium">$5-8</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Month 1</td>
                <td className="py-3 pr-4">~120</td>
                <td className="py-3 pr-4">200-400</td>
                <td className="py-3 text-orange-600 font-medium">$21-42</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-3 pr-4">Month 3</td>
                <td className="py-3 pr-4">~300</td>
                <td className="py-3 pr-4">600-1,200</td>
                <td className="py-3 text-orange-600 font-medium">$63-126</td>
              </tr>
              <tr>
                <td className="py-3 pr-4">Month 6</td>
                <td className="py-3 pr-4">~500+</td>
                <td className="py-3 pr-4">1,500-3,000</td>
                <td className="py-3 text-orange-600 font-medium">$157-315</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-sm text-text-secondary/60">
            Estimates based on typical browsing patterns of 15-20 sites per day.
            Earnings scale with network growth — more agents using the network
            means more route uses and higher earnings for contributors.
          </p>
        </section>

        {/* FAQ-style quick hits */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            Common questions
          </h2>
          <div className="space-y-4">
            {[
              {
                q: "Do I need to do anything differently?",
                a: "No. Install the plugin and use your agent exactly the way you already do. Route discovery and earning happen automatically in the background.",
              },
              {
                q: "Is this a token I have to sell on an exchange?",
                a: "No. You earn USDC, a stablecoin pegged to the US dollar. $1 of USDC is $1. You can withdraw to any wallet and off-ramp to your bank account through standard crypto exchanges.",
              },
              {
                q: "What if someone else already indexed the same site?",
                a: "The network keeps the highest-quality routes. If your agent discovers better, more reliable routes than the existing ones, yours will be preferred and earn more traffic. Multiple contributors can earn from the same domain.",
              },
              {
                q: "How do I get the first-mover bonus?",
                a: "Just be the first to browse a site with the plugin active. If no one has indexed that domain before, you automatically get a 2x earnings multiplier on all routes from that domain for 30 days.",
              },
              {
                q: "What happens if a website changes its APIs?",
                a: "Routes that stop working get automatically deprecated. If you browse the updated site, your agent re-discovers the new routes and your fresh version replaces the stale one. Keeping routes fresh earns you more traffic.",
              },
            ].map((faq) => (
              <div
                key={faq.q}
                className="rounded-xl border border-border p-4 sm:p-5"
              >
                <h3 className="font-semibold text-base">{faq.q}</h3>
                <p className="mt-2 text-sm sm:text-base text-text-secondary leading-relaxed">
                  {faq.a}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Give your agent a side hustle
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            One command. Your agent keeps doing what it does. You start earning
            from every website it touches. The earlier you start, the more
            first-mover bonuses you claim.
          </p>
          <div className="rounded-lg bg-surface-sunken border border-border p-4 font-mono text-sm sm:text-base mb-6">
            <span className="text-text-secondary/60 select-none">$ </span>
            <span className="text-orange-600">{INSTALL_CMD}</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              View on GitHub
            </a>
            <Link
              href="/proof-of-indexing"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              How proof of indexing works
            </Link>
            <Link
              href="/personal-agents"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Why your agent is 3.6x too slow
            </Link>
          </div>
        </section>
      </article>
    </div>
  );
}
