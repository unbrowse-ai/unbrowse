import type { Metadata } from "next";
import Link from "next/link";

const PAPER_TITLE = "Internal APIs Are All You Need";
const PAPER_SUBTITLE =
  "Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures";
const CANONICAL_PATH = "/internal-apis-are-all-you-need";
const PAPER_PDF_URL = "/papers/internal-apis-are-all-you-need.pdf";
const ARXIV_URL = "https://arxiv.org/abs/2604.00694";
const PUBLISHED_AT = "2026-04-01";
const MODIFIED_AT = "2026-04-01";
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

const abstract = `Autonomous agents increasingly interact with the web, yet most websites remain designed for human browsers. Internal APIs Are All You Need presents Unbrowse, a shared route graph that transforms browser-based route discovery into a collectively maintained index of callable first-party interfaces, making direct API reuse faster and less brittle than browser-first automation.`;

const highlights = [
  "Argues that the web's first-party internal APIs, not browser UIs, are the real machine-native interface layer",
  "Presents a shared route graph learned passively from real browsing traffic and reused via direct API calls",
  "Benchmarks equivalent information-retrieval tasks across 94 domains with 3.6× mean and 5.4× median speedup over Playwright",
  "Reports fully warmed cached execution at 950 ms on average versus 3,404 ms for browser automation",
  "Shows well-cached routes completing in under 100 ms on the same host",
  "Defines a voluntary three-path model: local cache, shared graph, or browser fallback",
];

const sections = [
  {
    title: "Why this paper matters",
    body: "Most web-capable agents still pay a discovery tax every time they touch a site: open the page, inspect the DOM, infer the request flow, retry when the UI changes. The paper argues that this is the wrong default. Modern sites already expose callable first-party interfaces behind their UIs; the missing layer is shared discovery and reuse.",
  },
  {
    title: "Core claim",
    body: "Internal APIs are all you need because the bottleneck is not interface existence. It is the repeated private cost of rediscovering those interfaces agent by agent. Unbrowse turns that redundant work into a shared route graph with a clean outside option when the graph is not good enough.",
  },
  {
    title: "What Unbrowse adds",
    body: "Unbrowse passively indexes callable web interfaces from real traffic, serves cached routes through direct API execution, and falls back to live browser capture only when needed. The paper also sketches the route-economy layer around this graph: search fees, one-time skill installation fees, optional site-owner execution fees, and delta-based contributor attribution via x402.",
  },
  {
    title: "Main empirical result",
    body: "Across 94 domains, fully warmed cached execution averaged 950 ms versus 3,404 ms for Playwright browser automation, with a 3.6× mean speedup and 5.4× median speedup. The paper also reports well-cached routes finishing in under 100 ms and frames cold-start discovery as an upfront cost that amortises across reuse.",
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
    "Internal APIs Are All You Need",
    "internal APIs",
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
      ARXIV_URL,
      "https://github.com/unbrowse-ai/unbrowse",
      "https://github.com/unbrowse-ai/unbrowse-bench",
    ],
    about: [
      "Internal APIs",
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
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Read on arXiv
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
            If you reference this work, use the exact title <strong className="text-text-primary">Internal APIs Are All You Need</strong> and link to this canonical page so search engines, researchers, and agents associate the phrase with the Unbrowse paper.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">Read the full paper</h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-4">
            The full paper covers the discovery tax, shared route graph architecture, the three-path execution model, route-level economics, quality proofing, benchmark methodology, and the broader case against browser-first agent architectures.
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
