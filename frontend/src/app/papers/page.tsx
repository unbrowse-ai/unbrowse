import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Papers | Unbrowse",
  description:
    "Canonical paper index for Unbrowse research, whitepapers, and systems writing.",
  alternates: {
    canonical: "https://www.unbrowse.ai/papers",
  },
};

const papers = [
  {
    title: "Internal APIs Are All You Need",
    subtitle: "Shadow APIs, Shared Discovery, and Why Browser-First Agents Are Over",
    href: "/internal-apis-are-all-you-need",
    description:
      "The Unbrowse whitepaper arguing that a site's own internal APIs (shadow APIs) are the machine-native substrate for autonomous agents, and that shared route graphs convert repeated browser rediscovery into collective memory.",
  },
];

export default function PapersIndexPage() {
  return (
    <div className="bg-surface min-h-screen text-text-primary">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="mb-10">
          <Link href="/" className="text-sm text-orange-600 hover:text-orange-500 transition-colors">
            ← Back to Unbrowse
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-8">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.25em] text-orange-600 mb-4">
            Research
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Unbrowse Papers</h1>
          <p className="mt-4 text-lg leading-8 text-text-secondary max-w-3xl">
            Canonical index for Unbrowse whitepapers, systems writing, and research artifacts.
          </p>
        </header>

        <div className="space-y-6">
          {papers.map((paper) => (
            <Link
              key={paper.href}
              href={paper.href}
              className="block rounded-2xl border border-border bg-surface-sunken p-6 hover:border-orange-500/30 hover:bg-orange-50/40 transition-colors"
            >
              <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
                {paper.title}
              </h2>
              <p className="mt-2 text-base font-medium text-orange-600">{paper.subtitle}</p>
              <p className="mt-3 text-base leading-7 text-text-secondary">{paper.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
