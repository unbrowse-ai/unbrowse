import type { Metadata } from "next";
import Link from "next/link";

const CANONICAL = "https://www.unbrowse.ai/about";
const TITLE = "About Unbrowse — the team building the agentic web route graph";
const DESCRIPTION =
  "Unbrowse AI Pte. Ltd. is a Singapore company building an open-source protocol that lets AI agents call any website's internal APIs directly. Co-authored research with the NUS School of Computing. NVIDIA Inception member.";

export const metadata: Metadata = {
  title: `${TITLE} | Unbrowse`,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    siteName: "Unbrowse",
    type: "website",
    images: [{ url: "https://www.unbrowse.ai/og-image.png", alt: "Unbrowse — about the team" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["https://www.unbrowse.ai/og-image.png"],
  },
};

const AUTHORS = [
  {
    name: "Lewis Tham",
    role: "Founder · Unbrowse AI",
    bio: "Building the route graph that lets agents call internal APIs directly. Co-author of \"Internal APIs Are All You Need\" (arXiv:2604.00694). Singapore-based.",
    sameAs: ["https://x.com/lekt8_", "https://github.com/lekt9"],
    image: "https://www.unbrowse.ai/lewis.png",
  },
  {
    name: "Nicholas Mac Gregor Garcia",
    role: "Co-author · NUS School of Computing",
    bio: "Research collaborator on the shadow-API benchmark. School of Computing, National University of Singapore.",
    sameAs: ["https://arxiv.org/a/garcia_n_1"],
    image: undefined,
  },
  {
    name: "Jungpil Hahn",
    role: "Co-author · NUS School of Computing",
    bio: "Faculty advisor on the academic side of the shadow-API research. School of Computing, NUS.",
    sameAs: ["https://arxiv.org/a/hahn_j_1"],
    image: undefined,
  },
];

export default function AboutPage() {
  const personLd = AUTHORS.map((a) => ({
    "@context": "https://schema.org",
    "@type": "Person",
    name: a.name,
    jobTitle: a.role,
    description: a.bio,
    affiliation: {
      "@type": "Organization",
      name: a.role.includes("NUS") ? "National University of Singapore" : "Unbrowse AI Pte. Ltd.",
    },
    sameAs: a.sameAs,
    ...(a.image ? { image: a.image } : {}),
  }));

  const aboutPageLd = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    url: CANONICAL,
    name: TITLE,
    description: DESCRIPTION,
    mainEntity: {
      "@type": "Organization",
      name: "Unbrowse",
      legalName: "Unbrowse AI Pte. Ltd.",
      url: "https://www.unbrowse.ai",
      foundingDate: "2025",
      foundingLocation: { "@type": "Place", name: "Singapore" },
      member: AUTHORS.map((a) => ({ "@type": "Person", name: a.name })),
      memberOf: { "@type": "Organization", name: "NVIDIA Inception Program" },
      award: ["NVIDIA Inception Program member"],
    },
  };

  return (
    <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutPageLd) }} />
      {personLd.map((p, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(p) }} />
      ))}

      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-orange-500 transition-colors mb-8"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </Link>

      <span className="eyebrow" style={{ display: "block" }}>About</span>
      <h1 className="text-4xl font-bold tracking-tight mt-3 mb-3 animate-fade-up">About Unbrowse</h1>
      <p className="text-text-secondary text-lg mb-10 leading-relaxed animate-fade-up stagger-1">
        Unbrowse is the route layer AI agents use to call internal APIs directly — replacing brittle headless
        browsers with shared, reusable skills. Built by{" "}
        <strong className="text-text-primary">Unbrowse AI Pte. Ltd.</strong> in Singapore, with research
        co-authored at the National University of Singapore School of Computing.
      </p>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Why we exist
        </h2>
        <p className="text-text-secondary leading-relaxed mb-3">
          Agents are spending billions of tokens automating headless Chromium to do what a 200-token API call
          could do in 100ms. The bottleneck isn&apos;t intelligence — it&apos;s infrastructure. Every site has
          an internal API. We capture it once. Every agent on the network uses it forever.
        </p>
        <p className="text-text-secondary leading-relaxed">
          The economic insight: route discovery is collective work. The first agent that browses
          airbnb.com captures the route. The next ten thousand agents replay it for free. Miners earn
          revenue share on every replay. The network gets faster with every interaction.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## The team
        </h2>
        <div className="grid gap-6">
          {AUTHORS.map((a) => (
            <article key={a.name} className="border border-border rounded-md p-5 bg-orange-50">
              <header className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
                <h3 className="text-lg font-medium text-text-primary">{a.name}</h3>
                <p className="text-xs font-mono text-text-secondary">{a.role}</p>
              </header>
              <p className="text-sm text-text-secondary leading-relaxed mb-3">{a.bio}</p>
              {a.sameAs.length > 0 && (
                <div className="flex gap-3 text-xs font-mono">
                  {a.sameAs.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noopener" className="text-orange-500 hover:underline">
                      {new URL(url).hostname.replace(/^www\./, "")}
                    </a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Recognition &amp; research
        </h2>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li>
            <strong className="text-text-primary">arXiv:2604.00694</strong> — &quot;Internal APIs Are All You Need:
            Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures.&quot;{" "}
            <Link href="/internal-apis-are-all-you-need" className="text-orange-500 hover:underline">
              Read the paper →
            </Link>
          </li>
          <li>
            <strong className="text-text-primary">NVIDIA Inception</strong> — Member of NVIDIA&apos;s program
            for AI-native startups.
          </li>
          <li>
            <strong className="text-text-primary">94-domain benchmark</strong> — 3.6× mean (5.4× median)
            speedup vs Playwright across live production sites.{" "}
            <Link href="/benchmark-deep-dive" className="text-orange-500 hover:underline">
              Methodology →
            </Link>
          </li>
        </ul>
      </section>

      <section className="border-t border-border pt-8">
        <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-orange-500 mb-4">
          ## Get in touch
        </h2>
        <ul className="text-sm text-text-secondary space-y-1.5">
          <li>
            General:{" "}
            <a href="mailto:support@unbrowse.ai" className="text-orange-500 hover:underline">
              support@unbrowse.ai
            </a>{" "}
            ·{" "}
            <Link href="/contact" className="text-orange-500 hover:underline">
              contact page
            </Link>
          </li>
          <li>
            Security:{" "}
            <a href="mailto:security@unbrowse.ai" className="text-orange-500 hover:underline">
              security@unbrowse.ai
            </a>{" "}
            ·{" "}
            <Link href="/security" className="text-orange-500 hover:underline">
              responsible disclosure
            </Link>
          </li>
          <li>
            Real-time:{" "}
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              className="text-orange-500 hover:underline"
            >
              Discord
            </a>
          </li>
          <li className="pt-3 text-xs text-text-muted">
            Unbrowse AI Pte. Ltd. · Singapore · MIT (open-source SDKs)
          </li>
        </ul>
      </section>
    </div>
  );
}
