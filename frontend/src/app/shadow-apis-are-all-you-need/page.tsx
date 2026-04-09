import type { Metadata } from "next";
import Link from "next/link";

const PAPER_TITLE = "Shadow APIs Are All You Need";
const PAPER_SUBTITLE = "A Shared Route Graph for Autonomous Web Agents";
const CANONICAL_PATH = "/shadow-apis-are-all-you-need";
const PAPER_PDF_URL = "/papers/shadow-apis-are-all-you-need.pdf";
const PUBLISHED_AT = "2026-03-23";
const MODIFIED_AT = "2026-03-25";
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
];

const abstract = `Autonomous web agents repeatedly pay a discovery tax: opening sites, inspecting DOMs, and reverse-engineering callable routes. Shadow APIs Are All You Need introduces Unbrowse, a shared route graph that converts browser-based route discovery into a collectively maintained, usage-priced index of callable web interfaces. Routes are learned passively from real browsing traffic and reused as cached API calls, making agents faster, cheaper, and less brittle than browser automation.`;

const highlights = [
  "Introduces the discovery tax as the core bottleneck for autonomous web agents",
  "Frames shadow APIs as the machine-native substrate behind human web interfaces",
  "Presents a shared route graph learned passively from real browsing traffic",
  "Benchmarks 94 live domains with 3.6× mean and 5.4× median speedup over Playwright",
  "Shows 90–96% per-task cost reduction for warmed-cache execution",
  "Defines a voluntary three-path execution model: local cache, shared graph, or browser fallback",
];

const sections = [
  {
    title: "Why this paper matters",
    body: "Most web-capable agents still waste time rediscovering the same website workflows over and over. This paper argues that the web's shadow APIs already form the real machine-native interface layer. Unbrowse turns that repeated private reverse engineering into a shared route graph, so agents can call cached routes directly instead of browsing human interfaces by default.",
  },
  {
    title: "Core claim",
    body: "Shadow APIs are all you need because modern websites already expose callable backend interfaces behind their UIs. The bottleneck is not the absence of interfaces. It is the absence of shared memory, routing, and maintenance around them.",
  },
  {
    title: "What Unbrowse adds",
    body: "Unbrowse passively indexes callable web interfaces from real traffic, keeps execution local, and gives agents a voluntary outside option: use the shared graph only when its route fee is lower than the expected cost of rediscovery. That keeps adoption disciplined by real product economics rather than speculation.",
  },
  {
    title: "Main empirical result",
    body: "Across 94 domains, warmed-cache execution averaged 950 ms versus 3,404 ms for Playwright browser automation, with a 3.6× mean speedup, 5.4× median speedup, and 90–96% cost reduction per task. Cold-start discovery averaged 12.4 seconds and typically amortised within 3–5 reuses.",
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
    title: `${PAPER_TITLE} — ${PAPER_SUBTITLE}`,
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
    title: `${PAPER_TITLE} — ${PAPER_SUBTITLE}`,
    description: abstract,
    images: ["https://www.unbrowse.ai/logo.png"],
  },
  keywords: [
    "Shadow APIs Are All You Need",
    "shadow APIs",
    "web agents",
    "autonomous web agents",
    "shared route graph",
    "browser automation",
    "API discovery",
    "Unbrowse",
    "agentic web",
    "x402",
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
    sameAs: [
      `https://www.unbrowse.ai${PAPER_PDF_URL}`,
      "https://github.com/unbrowse-ai/unbrowse",
      "https://github.com/unbrowse-ai/unbrowse-bench",
    ],
    about: [
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
            Whitepaper
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
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <a
              href={PAPER_PDF_URL}
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
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
          <h2 className="text-2xl font-semibold tracking-tight mb-3">Canonical citation target</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            If you reference this work, use the exact title <strong className="text-text-primary">Shadow APIs Are All You Need</strong> and link to this canonical page so search engines, researchers, and agents associate the phrase with the Unbrowse paper.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Read the full paper</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            The full paper covers the shared route graph architecture, discovery tax, the three-path execution model, route-level economics, quality proofing, benchmark methodology, and architectural implications for the agentic web.
          </p>
          <a
            href={PAPER_PDF_URL}
            className="text-orange-600 hover:text-orange-500 font-medium"
          >
            Open the PDF →
          </a>
        </section>
      </article>
    </div>
  );
}
