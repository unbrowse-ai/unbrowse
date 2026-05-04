import type { Metadata } from "next";
import Link from "next/link";

const PAPER_TITLE = "Internal APIs Are All You Need";
const PAPER_SUBTITLE =
  "Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures";
const CANONICAL_PATH = "/internal-apis-are-all-you-need";
const PAPER_PDF_URL = "/papers/shadow-apis-are-all-you-need.pdf";
const ARXIV_ID = "2604.00694";
const ARXIV_URL = `https://arxiv.org/abs/${ARXIV_ID}`;
const PUBLISHED_AT = "2026-04-01";
const MODIFIED_AT = "2026-05-04";
const PAPER_AUTHORS = [
  {
    name: "Lewis Tham",
    affiliation: "Unbrowse AI",
    email: "lewis@unbrowse.ai",
  },
  {
    name: "Nicholas Mac Gregor Garcia",
    affiliation: "School of Computing, National University of Singapore",
    email: "ngarcia@nus.edu.sg",
  },
  {
    name: "Jungpil Hahn",
    affiliation: "School of Computing, National University of Singapore",
    email: "jungpil@nus.edu.sg",
  },
];

const abstract = `Autonomous web agents repeatedly pay a discovery tax: opening sites, inspecting DOMs, and reverse-engineering callable routes. We argue that the internal APIs already powering those websites are the machine-native substrate agents should target, and that browser-first architectures are the wrong default. We introduce Unbrowse, a shared route graph that converts browser-based route discovery into a collectively maintained, usage-priced index of callable web interfaces. Routes are learned passively from real browsing traffic and reused as cached API calls. Across 94 live domains, warmed-cache execution averaged 950 ms versus 3,404 ms for Playwright browser automation (3.6x mean, 5.4x median speedup) with 90 to 96 percent per-task cost reduction.`;

const highlights = [
  "Names the discovery tax as the core inefficiency in autonomous web agents",
  "Argues internal APIs (shadow APIs) are the machine-native interface beneath every modern site",
  "Presents a shared route graph learned passively from real browsing traffic",
  "Benchmarks 94 live domains with a 3.6x mean and 5.4x median speedup over Playwright",
  "Reports 90 to 96 percent per-task cost reduction for warmed-cache execution",
  "Defines a voluntary three-tier execution model: local cache, shared graph, browser fallback",
];

const sections = [
  {
    title: "Why this paper matters",
    body: "Most agent stacks waste compute reopening the same websites and re-parsing the same pages, instead of calling the routes those pages already use. Every login, scroll, and click in a modern app fires JSON requests against internal endpoints; an agent that drives a browser pays for that work twice while ignoring the API underneath. Treating those internal endpoints as the real interface lets one agent's discovery become another agent's cached call, so the expensive reverse engineering happens once per route rather than once per task. The paper reframes agent web access around that shared substrate rather than around the browser session.",
  },
  {
    title: "Core claim",
    body: "Internal APIs are sufficient for autonomous agents because the callable surface already exists; only the routing and the shared memory are missing. Across the 94 production sites the authors index, every observed task sat on top of a JSON or GraphQL endpoint that the front-end was already calling. That means the bottleneck is not \"agents need browsers,\" it is \"agents lack a shared index of routes and a way to keep it fresh.\" Build the index, and the browser becomes a fallback rather than a default.",
  },
  {
    title: "What Unbrowse adds",
    body: "Unbrowse turns one-off route reverse engineering into a usage-priced public good with a voluntary opt-in. Routes captured during real browsing are normalised into a shared graph; agents query it, pay a small per-call fee, and keep execution local inside their own process. Because the fee is set against the expected cost of rediscovery, agents only adopt the graph when it is cheaper than reopening the site themselves, which keeps prices honest and supply self-correcting. Adoption is driven by economics, not by mandate.",
  },
  {
    title: "Main empirical result",
    body: "Calling cached routes is several times faster and an order of magnitude cheaper than driving a browser to the same task. Across 94 live domains, warmed-cache execution averaged 950 ms versus 3,404 ms for Playwright (3.6x mean, 5.4x median) with 90 to 96 percent per-task cost reduction. Cold-start discovery costs 12.4 seconds on average but typically pays back within three to five reuses, so the up-front tax disappears as soon as a route is shared. The numbers hold the line that the browser is the slow path, not the safe path.",
  },
];

export const metadata: Metadata = {
  title: `${PAPER_TITLE} | Unbrowse Whitepaper`,
  description: abstract,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: PAPER_AUTHORS.map((author) => ({ name: author.name, url: `mailto:${author.email}` })),
  openGraph: {
    title: `${PAPER_TITLE} - ${PAPER_SUBTITLE}`,
    description: abstract,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    images: [
      {
        url: "https://www.unbrowse.ai/logo.png",
        alt: "Unbrowse logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: `${PAPER_TITLE} - ${PAPER_SUBTITLE}`,
    description: abstract,
    images: ["https://www.unbrowse.ai/logo.png"],
  },
  keywords: [
    "Internal APIs Are All You Need",
    "Shadow APIs Are All You Need",
    "shadow APIs",
    "internal APIs",
    "web agents",
    "autonomous web agents",
    "shared route graph",
    "browser automation",
    "API discovery",
    "Unbrowse",
    "agentic web",
    "x402",
    "arXiv:2604.00694",
  ],
};

export default function InternalApisPaperPage() {
  const scholarlyArticle = {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    headline: PAPER_TITLE,
    alternativeHeadline: PAPER_SUBTITLE,
    description: abstract,
    author: PAPER_AUTHORS.map((author) => ({
      "@type": "Person",
      name: author.name,
      email: author.email,
      affiliation: {
        "@type": "Organization",
        name: author.affiliation,
      },
    })),
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: "https://www.unbrowse.ai/logo.png",
    },
    datePublished: PUBLISHED_AT,
    dateModified: MODIFIED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    identifier: [
      {
        "@type": "PropertyValue",
        propertyID: "arXiv",
        value: ARXIV_ID,
        url: ARXIV_URL,
      },
    ],
    sameAs: [
      ARXIV_URL,
      `https://www.unbrowse.ai${PAPER_PDF_URL}`,
      "https://github.com/unbrowse-ai/unbrowse",
      "https://github.com/unbrowse-ai/unbrowse-bench",
    ],
    about: [
      "Internal APIs",
      "Shadow APIs",
      "Autonomous web agents",
      "Shared route graphs",
      "Browser automation",
      "Agentic web infrastructure",
    ],
    keywords: metadata.keywords,
    isAccessibleForFree: true,
    inLanguage: "en-US",
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(scholarlyArticle) }}
      />

      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm text-orange-600 hover:text-orange-500 transition-colors"
          >
            ← Back to Unbrowse
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Whitepaper · arXiv:{ARXIV_ID}
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {PAPER_TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance">
            {PAPER_SUBTITLE}
          </p>
          <div className="mt-8 space-y-3 text-sm sm:text-base text-text-secondary">
            {PAPER_AUTHORS.map((author) => (
              <div key={author.email}>
                <div className="font-semibold text-text-primary">{author.name}</div>
                <div>{author.affiliation}</div>
                <div>
                  <a className="text-orange-600 hover:text-orange-500" href={`mailto:${author.email}`}>
                    {author.email}
                  </a>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-text-secondary">
            Published {PUBLISHED_AT} on arXiv (cs.ET) ·{" "}
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500"
            >
              arxiv.org/abs/{ARXIV_ID}
            </a>
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Read on arXiv
            </a>
            <a
              href={PAPER_PDF_URL}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Download PDF
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              View repository
            </a>
          </div>
        </header>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Abstract</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">{abstract}</p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Key highlights</h2>
          <ul className="space-y-3 text-base sm:text-lg leading-8 text-text-secondary list-disc pl-5">
            {highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="space-y-10 mb-12">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="text-2xl font-semibold tracking-tight mb-3">{section.title}</h2>
              <p className="text-base sm:text-lg leading-8 text-text-secondary">{section.body}</p>
            </div>
          ))}
        </section>

        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">How to cite</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            Tham, L., Mac Gregor Garcia, N., &amp; Hahn, J. (2026).{" "}
            <em>{PAPER_TITLE}: {PAPER_SUBTITLE}</em>. arXiv:{ARXIV_ID}.{" "}
            <a href={ARXIV_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-500">
              {ARXIV_URL}
            </a>
          </p>
          <p className="text-sm leading-7 text-text-secondary">
            Use the exact title{" "}
            <strong className="text-text-primary">Internal APIs Are All You Need</strong>{" "}
            and link to the arXiv record so search engines, researchers, and agents associate the phrase with the Unbrowse paper.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Read the full paper</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            The full paper covers the shared route graph architecture, the discovery tax, the three-tier execution model, route-level economics, quality proofing, benchmark methodology, and architectural implications for the agentic web.
          </p>
          <a
            href={ARXIV_URL}
            target="_blank"
            rel="noopener"
            className="text-orange-600 hover:text-orange-500 font-medium"
          >
            Read on arXiv →
          </a>
        </section>
      </article>
    </div>
  );
}
