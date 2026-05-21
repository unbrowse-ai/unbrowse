import Link from "next/link";
import { type Competitor, comparisonRows, competitors } from "./compare-data";

const ARXIV_URL = "https://arxiv.org/abs/2604.00694";
const INSTALL_CMD = "curl -fsSL https://unbrowse.ai/install.sh | bash";

function ComparisonTable({ competitor }: { competitor: Competitor }) {
  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <table className="w-full text-sm sm:text-base border-collapse min-w-[640px]">
        <thead>
          <tr className="border-b border-border-strong">
            <th className="text-left py-3 px-4 font-semibold text-text-muted w-[160px]">
              Dimension
            </th>
            <th className="text-left py-3 px-4 font-semibold text-orange-500">
              Unbrowse
            </th>
            <th className="text-left py-3 px-4 font-semibold text-text-secondary">
              {competitor.name}
            </th>
          </tr>
        </thead>
        <tbody>
          {comparisonRows.map((row) => (
            <tr
              key={row.dimension}
              className="border-b border-border hover:bg-surface-raised/50 transition-colors"
            >
              <td className="py-3 px-4 font-medium text-text-primary whitespace-nowrap">
                {row.dimension}
              </td>
              <td className="py-3 px-4 text-text-primary">
                {row.unbrowse}
                {row.note && (
                  <span className="block text-xs text-text-muted mt-0.5">
                    {row.note}
                  </span>
                )}
              </td>
              <td className="py-3 px-4 text-text-secondary">
                {row.competitor(competitor.name)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OtherComparisons({ currentSlug }: { currentSlug: string }) {
  const others = Object.values(competitors).filter(
    (c) => c.slug !== currentSlug
  );
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {others.map((c) => (
        <Link
          key={c.slug}
          href={`/compare/${c.slug}`}
          className="block rounded-xl border border-border bg-surface-raised p-5 hover:border-orange-500/40 hover:bg-orange-50/30 transition-colors"
        >
          <p className="font-semibold text-text-primary mb-1">
            vs {c.name}
          </p>
          <p className="text-sm text-text-secondary line-clamp-2">
            {c.description}
          </p>
        </Link>
      ))}
    </div>
  );
}

export function ComparisonPage({ slug }: { slug: string }) {
  const competitor = competitors[slug];
  if (!competitor) return null;

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What is the difference between Unbrowse and ${competitor.name}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${competitor.what} Unbrowse takes a fundamentally different approach: it reverse-engineers the internal APIs websites already use and lets AI agents call them directly. In benchmarks across 94 domains, Unbrowse is 3.6x faster (mean) and uses 40x fewer tokens than browser automation.`,
        },
      },
      {
        "@type": "Question",
        name: `Is Unbrowse faster than ${competitor.name}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Unbrowse averages 950 ms per task with warmed cache versus 3,404 ms for Playwright-based browser automation — a 3.6x mean speedup and 5.4x median speedup. These results are from a peer-reviewed benchmark across 94 live domains (arXiv:2604.00694).",
        },
      },
      {
        "@type": "Question",
        name: `Is Unbrowse cheaper than ${competitor.name}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Cached API calls cost approximately $0.005 per task compared to $0.53 for browser automation — a 90-96% cost reduction. Token usage drops from ~8,000 per page to ~200, a 40x reduction.",
        },
      },
      {
        "@type": "Question",
        name: "How do I switch from browser automation to Unbrowse?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Install with 'curl -fsSL https://unbrowse.ai/install.sh | bash'. After install, hosts with skills support can also use 'npx skills add unbrowse-ai/unbrowse'. Unbrowse works as a drop-in tool for AI coding agents like Claude Code, Cursor, and Windsurf. It discovers APIs automatically from real browsing traffic — no manual endpoint mapping required.",
        },
      },
    ],
  };

  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <article className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        {/* Breadcrumb */}
        <div className="mb-6 flex items-center gap-2 text-sm text-text-muted">
          <Link
            href="/"
            className="text-orange-600 hover:text-orange-500 transition-colors"
          >
            Unbrowse
          </Link>
          <span>/</span>
          <span>Compare</span>
          <span>/</span>
          <span className="text-text-primary">{competitor.name}</span>
        </div>

        {/* Header */}
        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Comparison
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight">
            {competitor.tagline}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl text-text-secondary font-medium text-balance max-w-3xl">
            {competitor.description}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              Try Unbrowse
            </a>
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              Read the paper (arXiv)
            </a>
          </div>
        </header>

        {/* What is the competitor */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            What is {competitor.name}?
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary">
            {competitor.what}
          </p>
        </section>

        {/* Limitations */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            Where {competitor.name} falls short for AI agents
          </h2>
          <ul className="space-y-3 text-base sm:text-lg leading-8 text-text-secondary list-disc pl-5">
            {competitor.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        {/* Comparison table */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            Head-to-head comparison
          </h2>
          <div className="rounded-xl border border-border bg-surface-raised overflow-hidden">
            <ComparisonTable competitor={competitor} />
          </div>
          <p className="mt-4 text-sm text-text-muted">
            Speed and cost data from{" "}
            <a
              href={ARXIV_URL}
              target="_blank"
              rel="noopener"
              className="text-orange-600 hover:text-orange-500"
            >
              &quot;Internal APIs Are All You Need&quot;
            </a>{" "}
            (arXiv:2604.00694) — benchmark across 94 live domains.
          </p>
        </section>

        {/* How Unbrowse works differently */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-4">
            How Unbrowse works differently
          </h2>
          <div className="space-y-4 text-base sm:text-lg leading-8 text-text-secondary">
            <p>
              {competitor.name} works one layer too high for AI agents. It
              automates the rendered HTML: parsing DOMs, clicking buttons, and
              reading text that exists for human eyes, which costs roughly
              8,000 tokens and several seconds on every page. The data your
              agent actually needs was already structured as JSON one layer
              below, returned by the internal APIs the site uses to render
              itself. Skipping the DOM and calling those APIs directly cuts
              out the translation entirely.
            </p>
            <p>
              Unbrowse captures those internal endpoints from one real browsing
              session, reverse-engineers their schemas and auth, and stores them
              as reusable skills in a shared marketplace of 600+ domains and
              18,000+ endpoints. The next call from any agent skips discovery
              and runs as a direct HTTP request, returning JSON in roughly 200
              tokens instead of 8,000. The shared registry is the difference
              between every team paying the rendering tax and every team
              paying it once.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="mb-12 rounded-2xl border border-orange-500/20 bg-orange-50/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Try Unbrowse now
          </h2>
          <p className="text-base sm:text-lg leading-8 text-text-secondary mb-6">
            One command to install. Works with Claude Code, Cursor, Windsurf,
            and any agent that can call a CLI.
          </p>
          <div className="rounded-lg bg-code-bg border border-border p-4 font-mono text-sm sm:text-base">
            <span className="text-text-muted select-none">$ </span>
            <span className="text-orange-500">{INSTALL_CMD}</span>
          </div>
          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600 transition-colors"
            >
              View on GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface-sunken px-5 py-3 font-medium text-text-primary hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              View on npm
            </a>
          </div>
        </section>

        {/* Other comparisons */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold tracking-tight mb-6">
            Other comparisons
          </h2>
          <OtherComparisons currentSlug={slug} />
        </section>
      </article>
    </div>
  );
}
