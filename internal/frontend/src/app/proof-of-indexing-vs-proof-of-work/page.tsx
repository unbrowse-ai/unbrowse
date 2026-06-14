import type { Metadata } from "next";
import Link from "next/link";

const TITLE = "Proof of Indexing: The Consensus Mechanism for the Agentic Web";
const SUBTITLE = "Bitcoin burns electricity to secure transactions. Unbrowse burns browsing effort to secure routes. One built a ledger. The other is building the index.";
const CANONICAL_PATH = "/proof-of-indexing-vs-proof-of-work";
const PUBLISHED_AT = "2026-04-02";
const AUTHOR = {
  name: "Lewis Tham",
  affiliation: "Unbrowse AI",
  url: "https://x.com/lewistham",
};

const description = `Bitcoin used proof of work to align individual incentives with collective infrastructure — burn electricity, validate transactions, earn BTC. Unbrowse uses proof of indexing to do the same for the agentic web — browse sites, discover API routes, earn USDC. Both are consensus mechanisms. One built the financial web's shared ledger. The other is building the agentic web's shared route graph.`;

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse Blog`,
  description,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: AUTHOR.name, url: AUTHOR.url }],
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
        alt: "Unbrowse — Proof of Indexing vs Proof of Work",
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
    "proof of indexing",
    "proof of work",
    "web mining crypto",
    "agentic web consensus",
    "consensus mechanism",
    "web mining",
    "agentic web",
    "agent micropayments",
    "HTTP micropayments",
    "agent economy",
    "Unbrowse",
    "USDC",
    "Solana",
    "Base",
    "route graph",
    "API discovery",
    "earn crypto browsing",
    "agent infrastructure",
    "bitcoin mining analogy",
    "DePIN",
  ],
};

/* ------------------------------------------------------------------ */
/*  Prose sections                                                     */
/* ------------------------------------------------------------------ */

const sections: { title: string; body: string[] }[] = [
  {
    title: "Two infrastructure problems, one design pattern",
    body: [
      "In 2008, the financial web had a coordination problem. Banks maintained separate ledgers. Transferring value between them required intermediaries, reconciliation, and trust. There was no shared source of truth. Satoshi Nakamoto solved this with a mechanism: proof of work. Miners burn electricity to validate blocks of transactions, earning BTC in return. The individual incentive — profit from mining — produces the collective good — a secure, shared transaction ledger. Nobody mines for altruism. Everyone benefits from the result.",
      "In 2026, the agentic web has the same coordination problem. AI agents need structured access to web data — API routes, authentication patterns, endpoint schemas. Every agent framework solves this independently: launching headless browsers, rendering pages, parsing HTML, scraping data. There is no shared source of truth. Every agent reinvents the wheel for every site, every time.",
      "Proof of indexing solves this the same way proof of work solved financial coordination. Contributors browse the web, Unbrowse discovers the API routes behind every site they visit, and those routes are published to a shared graph. When agents use a route, the contributor earns a micropayment. The individual incentive — earn USDC from browsing — produces the collective good — a complete, machine-readable index of the web's internal APIs.",
    ],
  },
  {
    title: "The parallel: mechanism by mechanism",
    body: [
      "The structural parallel between proof of work and proof of indexing is not a metaphor. It is a direct mapping at the mechanism level.",
      "In proof of work, miners validate transactions and earn BTC. In proof of indexing, contributors discover routes and earn USDC. Both convert work into a shared resource. Bitcoin miners do not build the ledger out of conviction — they do it because mining is profitable. Unbrowse contributors do not build the route graph out of altruism — they do it because indexing pays.",
      "In proof of work, hashrate secures the network — the more computational power pointed at Bitcoin, the harder it is to attack. In proof of indexing, route coverage determines the hit rate — the more domains indexed, the higher the probability that an agent's query resolves from cache instead of falling back to an expensive browser session. Both metrics measure the health of the network by the aggregate contribution of participants.",
      "In proof of work, early miners earned disproportionately. When Bitcoin was $1, a CPU could mine blocks. By the time it hit $60,000, you needed warehouses of ASICs. In proof of indexing, the first contributor to index a domain earns a 2x reward multiplier. Once a domain is thoroughly indexed, the marginal return for re-indexing it drops. Early contributors capture outsized value — not from speculation, but from being first to do useful work.",
      "In proof of work, difficulty adjusts upward as more miners join. In proof of indexing, returns diminish naturally as domains get fully indexed. Both mechanisms prevent infinite extraction from a finite resource. Bitcoin's difficulty adjustment ensures blocks arrive every 10 minutes regardless of hashrate. Proof of indexing's diminishing returns ensure contributors fan out to unindexed domains rather than redundantly indexing the same ones.",
    ],
  },
  {
    title: "Where the analogy breaks — and why that matters",
    body: [
      "The parallel is real, but the differences are where proof of indexing gets interesting. Every difference is an advantage.",
      "Proof of work wastes energy by design. The computational work that miners perform — hashing trillions of nonces — produces nothing except the proof itself. The security model depends on this waste: the cost of attacking the network must exceed the cost of mining honestly. Proof of indexing produces no waste. Every unit of work generates a real, reusable API route. A contributor who spends an hour browsing e-commerce sites does not burn that hour — they produce a durable asset that serves agents for months or years.",
      "Proof of work created an arms race. CPUs gave way to GPUs, GPUs to FPGAs, FPGAs to ASICs. Today, Bitcoin mining is dominated by industrial operations with access to cheap electricity and specialized hardware. Proof of indexing requires a laptop and npm install. There is no specialized hardware that makes you index faster. A contributor in Lagos discovers routes at the same speed as one in San Francisco. The playing field stays level because the bottleneck is browsing, not computation.",
      "Proof of work tends toward centralization. Mining pools control most of Bitcoin's hashrate. Three pools regularly control over 50%. Proof of indexing has no pooling advantage. Routes are discovered by individual browsing sessions. You cannot pool ten browsers into one faster browser. The architecture resists the centralization dynamics that plague proof of work.",
      "Proof of work settles in a volatile asset. A miner who earns 1 BTC today might hold an asset worth $100,000 or $40,000 next quarter. Proof of indexing settles in USDC. Contributors know exactly what they earned. There is no Unbrowse token, no governance token, no speculative asset. The payment rail uses crypto because stablecoins on Solana and Base are the only technology that settles micropayments under $0.01 economically. The chain is plumbing, not the product.",
    ],
  },
  {
    title: "The deeper thesis: shared infrastructure needs a mechanism",
    body: [
      "Bitcoin's core insight was not blockchain or decentralization. It was that shared infrastructure can be built by self-interested participants if the mechanism design is right. Before Bitcoin, the idea of strangers voluntarily running servers to maintain a global financial ledger was absurd. The mechanism — proof of work — made it rational.",
      "The agentic web needs the same kind of insight. Agents need a shared route index the same way financial applications need a shared transaction ledger. Without it, every agent session starts from zero: launch browser, render page, extract data, throw away the work. The cost is $0.53 per session. The latency is 5-30 seconds. The token overhead is 8,000+ per page. None of this is necessary once the route exists.",
      "But who builds the index? Google built the human web index with a centralized crawler and $200 billion in annual revenue. That model does not transfer to the agentic web. The routes that agents need are not in public HTML — they are internal APIs behind authentication, dynamic frontends, and JavaScript rendering. They can only be discovered by browsing the site as a real user. No centralized crawler can do this at scale for every site, every auth flow, every edge case.",
      "Proof of indexing distributes the work. Anyone who browses the web contributes. The mechanism — earn USDC per route resolve — makes contribution rational. The result is a shared index built by thousands of independent contributors, each motivated by their own earnings, collectively producing infrastructure that no single entity could build alone.",
      "This is the same pattern as Bitcoin, applied to a different problem. Bitcoin: strangers maintain a shared ledger because mining is profitable. Unbrowse: strangers maintain a shared index because indexing is profitable. The mechanism is the message.",
    ],
  },
  {
    title: "The economics side by side",
    body: [
      "Bitcoin mining economics are well-understood. A miner invests in hardware and electricity, earns block rewards and transaction fees, and profits when revenue exceeds cost. The break-even calculation depends on BTC price, network difficulty, energy costs, and hardware efficiency.",
      "Proof of indexing economics follow the same structure but with radically different inputs. The investment is zero marginal cost — you browse the web anyway. There is no hardware to buy, no electricity to pay beyond your existing laptop, no hosting to maintain. The revenue is $0.0035 per route resolve (70% of the $0.005 fee). The earning scales with two variables: how many routes you have indexed, and how much agent traffic those routes attract.",
      "A contributor who indexes 20 endpoints on 10 popular domains has 200 active routes. At 100 agent resolves per route per day, that is 20,000 resolves daily, generating $70 per day, $2,100 per month. With the first-mover 2x bonus on all 10 domains, those numbers double: $140 per day, $4,200 per month. From browsing.",
      "Compare this to Bitcoin mining. A modern ASIC (Antminer S21, ~$5,000) mines roughly $10-15 per day at current difficulty and BTC price, consuming ~3,500W of electricity. The break-even point takes months. Proof of indexing has no capital expenditure, no operating expenditure beyond existing internet access, and reaches profitability on the first resolve.",
    ],
  },
  {
    title: "What contributors should understand about route mining",
    body: [
      "If you understand mining economics, you already understand proof of indexing. The mental model transfers directly.",
      "Domain selection is the new pool selection. Just as Bitcoin miners choose pools based on size, fees, and payout frequency, contributors should choose domains based on agent demand. High-traffic sites — e-commerce, travel, financial data, social platforms — generate more agent resolves than niche blogs. The marketplace leaderboard shows which domains are earning the most, the same way mining pool dashboards show hashrate and block frequency.",
      "Route quality is the new hashrate. In Bitcoin, hashrate determines your probability of finding a block. In proof of indexing, route quality determines your share of agent traffic. A complete, well-authenticated set of endpoints with accurate schemas will earn more than a partial, broken index of the same domain. Quality beats quantity, just as raw hashrate beats number of machines.",
      "Maintenance is the new difficulty adjustment. Websites change their APIs. Endpoints break. Authentication flows evolve. The contributor who keeps their routes current earns more than the one who indexes once and walks away. This is analogous to miners upgrading hardware as difficulty increases — you have to keep up with the environment to maintain earnings.",
      "The key difference: there is no race. In Bitcoin, only one miner wins each block. Mining is a zero-sum competition for each 10-minute interval. In proof of indexing, every useful route earns independently. Two contributors can both profit from the same domain if they index different endpoints or maintain better coverage for different use cases. The game is positive-sum.",
    ],
  },
  {
    title: "From ledger to index: the infrastructure progression",
    body: [
      "The internet's infrastructure has been built in layers, each with its own coordination mechanism. TCP/IP was built by government-funded researchers. HTTP was built by an academic at CERN. The web's link graph was indexed by Google's centralized crawler. The financial ledger was built by Bitcoin's proof of work. Each layer solved a coordination problem that the previous layer left open.",
      "The agentic web is the next layer. Agents do not need HTML pages — they need API routes. They do not need search rankings — they need reliability scores. They do not need ad-supported free access — they need micropayment-settled programmatic access. The infrastructure requirements are categorically different from the human web.",
      "Proof of indexing is the coordination mechanism for this layer. It is to the route graph what proof of work is to the blockchain: the engine that converts individual incentives into collective infrastructure. The arXiv paper (arxiv.org/abs/2604.00694) formalizes the technical architecture. HTTP-native micropayments handle the payment rail. USDC on Solana and Base provides the settlement layer. The 70/30 contributor split provides the incentive alignment.",
      "The question is not whether the agentic web needs a shared route index. The cost differential ($0.005 vs $0.53, documented across 50+ domains) makes the answer obvious. The question is who builds it and how. Proof of indexing is the answer: the same way proof of work built Bitcoin's ledger, by making it profitable for anyone to contribute.",
    ],
  },
  {
    title: "No token. No governance. No speculation.",
    body: [
      "Most crypto projects launch with a token, a governance structure, and a speculative thesis. Proof of indexing launches with none of these. There is no Unbrowse token. There is no DAO. There is no governance vote on protocol parameters. There is no speculative asset that appreciates independent of usage.",
      "This is deliberate. The lesson from a decade of crypto is that tokens decouple value from utility. A token can pump while the product is unused. A token can crash while the product is thriving. The noise of speculation drowns the signal of real usage.",
      "Proof of indexing uses USDC because the goal is to pay people for useful work, not to create a new financial instrument. Contributors earn stable dollars. Agents pay stable dollars. The marketplace clears on utility, not speculation. If no agents use the network, no one earns anything. If a million agents use it, contributors earn proportionally. The economics are boring by crypto standards, and that is the point.",
      "For DeFi builders accustomed to token models, this might seem like a limitation. It is actually the feature. A network where earnings are a direct function of usage — no token multiplier, no staking yield, no liquidity mining distortion — is a network where the only way to earn more is to index better routes on more popular domains. The incentive points directly at the work that matters.",
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Comparison table data                                              */
/* ------------------------------------------------------------------ */

const comparisonRows: { dimension: string; pow: string; poi: string }[] = [
  {
    dimension: "Work performed",
    pow: "Hash nonces to find valid blocks",
    poi: "Browse sites to discover API routes",
  },
  {
    dimension: "Shared resource produced",
    pow: "Transaction ledger (blockchain)",
    poi: "Route graph (API index)",
  },
  {
    dimension: "Reward",
    pow: "BTC (block reward + fees)",
    poi: "USDC (70% of resolve fee)",
  },
  {
    dimension: "Network health metric",
    pow: "Hashrate",
    poi: "Route coverage / hit rate",
  },
  {
    dimension: "Early mover advantage",
    pow: "Low difficulty, high BTC/block",
    poi: "2x first-contributor bonus",
  },
  {
    dimension: "Diminishing returns",
    pow: "Difficulty adjusts upward",
    poi: "Domains get fully indexed",
  },
  {
    dimension: "Hardware required",
    pow: "ASICs ($5,000+)",
    poi: "Any laptop (npm install)",
  },
  {
    dimension: "Energy waste",
    pow: "By design (security model)",
    poi: "None (every unit produces a route)",
  },
  {
    dimension: "Centralization risk",
    pow: "Mining pools (3 pools > 50%)",
    poi: "No pooling advantage",
  },
  {
    dimension: "Settlement asset",
    pow: "BTC (volatile)",
    poi: "USDC (stable)",
  },
  {
    dimension: "Time to first revenue",
    pow: "Months (hardware ROI)",
    poi: "First resolve after indexing",
  },
  {
    dimension: "Utility of work product",
    pow: "None beyond security proof",
    poi: "Reusable API routes for agents",
  },
];

const faqItems: { question: string; answer: string }[] = [
  {
    question: "What is proof of indexing?",
    answer:
      "Proof of indexing is Unbrowse's incentive mechanism for building a shared route graph for AI agents. Contributors browse real websites, Unbrowse discovers the callable API routes behind those sessions, and contributors earn USDC when agents resolve those routes from the shared index.",
  },
  {
    question: "Why not just use browser automation or scraping?",
    answer:
      "Because browser automation repeats the same discovery work every time. It launches a browser, renders pixels, parses DOM, and reconstructs structure on every session. Proof of indexing turns that repeated cost into a reusable asset: once a route is discovered, future agents can call it directly.",
  },
  {
    question: "Why pay contributors in USDC instead of a token?",
    answer:
      "USDC keeps the mechanism tied to usage instead of speculation. Contributors earn stable dollars, agents pay stable dollars, and the network only grows when routes are useful enough to get real traffic. No governance token, no liquidity mining, no fake yield.",
  },
  {
    question: "How do contributors earn more?",
    answer:
      "By indexing valuable domains early, keeping routes current, and maintaining high-quality coverage on workflows agents actually query. The upside comes from useful route volume, not from hoarding a token or spinning up more hardware.",
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ProofOfIndexingVsProofOfWorkPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: TITLE,
    alternativeHeadline: SUBTITLE,
    description,
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
      affiliation: {
        "@type": "Organization",
        name: AUTHOR.affiliation,
      },
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    keywords: metadata.keywords,
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
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
          <div className="mt-8 text-sm sm:text-base text-text-secondary">
            <div className="font-semibold text-text-primary">{AUTHOR.name}</div>
            <div>{AUTHOR.affiliation}</div>
            <div className="mt-2 text-text-secondary/60">{PUBLISHED_AT}</div>
          </div>
        </header>

        {/* Lede */}
        <section className="mb-12">
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            {description}
          </p>
        </section>

        {/* Core parallel highlight box */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            The core parallel
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-base sm:text-lg">
            <div>
              <div className="text-sm font-mono font-medium uppercase tracking-wider text-text-secondary/60 mb-2">
                Proof of Work
              </div>
              <div className="text-text-primary font-medium">
                Burn electricity to validate transactions
              </div>
              <div className="text-text-secondary mt-1">
                Build a shared ledger. Earn BTC.
              </div>
            </div>
            <div>
              <div className="text-sm font-mono font-medium uppercase tracking-wider text-orange-600 mb-2">
                Proof of Indexing
              </div>
              <div className="text-text-primary font-medium">
                Browse the web to discover API routes
              </div>
              <div className="text-text-secondary mt-1">
                Build a shared index. Earn USDC.
              </div>
            </div>
          </div>
        </section>

        {/* Body sections */}
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

        {/* Comparison table */}
        <section className="mb-12 overflow-x-auto">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Proof of Work vs Proof of Indexing
          </h2>
          <table className="w-full text-sm sm:text-base border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Dimension
                </th>
                <th className="py-3 pr-4 font-semibold text-text-primary">
                  Proof of Work (Bitcoin)
                </th>
                <th className="py-3 font-semibold text-orange-600">
                  Proof of Indexing (Unbrowse)
                </th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              {comparisonRows.map((row, i) => (
                <tr
                  key={row.dimension}
                  className={
                    i < comparisonRows.length - 1
                      ? "border-b border-border/50"
                      : ""
                  }
                >
                  <td className="py-3 pr-4 font-medium text-text-primary">
                    {row.dimension}
                  </td>
                  <td className="py-3 pr-4">{row.pow}</td>
                  <td className="py-3">{row.poi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Key numbers box */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Key numbers
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-base sm:text-lg">
            <div>
              <div className="text-3xl font-bold text-orange-600">106x</div>
              <div className="text-text-secondary mt-1">
                Cost reduction: $0.005 cached route vs $0.53 browser session
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">70%</div>
              <div className="text-text-secondary mt-1">
                Revenue share to contributors per resolve
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-orange-600">2x</div>
              <div className="text-text-secondary mt-1">
                First-contributor bonus on new domains
              </div>
            </div>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            FAQ
          </h2>
          <div className="space-y-6">
            {faqItems.map((item) => (
              <div
                key={item.question}
                className="rounded-2xl border border-border bg-surface-raised p-6"
              >
                <h3 className="text-lg font-semibold tracking-tight mb-2">
                  {item.question}
                </h3>
                <p className="text-base sm:text-lg leading-8 text-text-secondary">
                  {item.answer}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl border border-orange-500/20 bg-orange-50/50 dark:bg-orange-950/20 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Start mining the agentic web
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            Bitcoin miners needed warehouses of ASICs. Contributors need one
            command: install Unbrowse, browse the web, and earn when agents use
            the routes you discover.
          </p>
          <div className="rounded-lg bg-surface-sunken border border-border p-4 font-mono text-sm sm:text-base mb-6">
            <span className="text-text-secondary/60 select-none">$ </span>
            <span className="text-orange-600">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
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
            <a
              href="https://arxiv.org/abs/2604.00694"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Read the arXiv paper
            </a>
            <Link
              href="/proof-of-indexing"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Proof of Indexing economics
            </Link>
          </div>
        </section>
      </article>
    </div>
  );
}
