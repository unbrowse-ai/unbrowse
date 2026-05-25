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
    subtitle: "Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures",
    href: "/internal-apis-are-all-you-need",
    description:
      "The Unbrowse paper (Tham, Mac Gregor Garcia, Hahn — arXiv:2604.00694) arguing that the internal APIs already powering modern websites are the machine-native substrate for autonomous agents, and that a shared route graph turns repeated browser rediscovery into collective memory.",
  },
];

export default function PapersIndexPage() {
  return (
    <div className="bg-[#070503] min-h-screen text-[rgba(255,255,255,0.9)]">
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24">
        <div className="mb-10">
          <Link
            href="/"
            className="text-sm font-mono text-[rgba(255,176,96,0.9)] hover:text-[rgba(255,176,96,1)] transition-colors"
          >
            [← back to unbrowse]
          </Link>
        </div>

        <header className="mb-12 border-b border-[rgba(255,122,32,0.18)] pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-[rgba(255,176,96,0.9)] mb-4">
            ## RESEARCH
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight">Papers</h1>
          <p className="mt-4 text-lg sm:text-xl font-mono text-[rgba(255,255,255,0.7)] max-w-3xl">
            Canonical index for Unbrowse whitepapers, systems writing, and research artifacts.
          </p>
        </header>

        <div className="space-y-6">
          {papers.map((paper) => (
            <Link
              key={paper.href}
              href={paper.href}
              className="block group rounded-sm border border-[rgba(255,122,32,0.18)] bg-[#080604] p-6 sm:p-8 hover:border-[rgba(255,122,32,0.35)] hover:bg-[#0a0705] transition-colors"
            >
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[rgba(255,255,255,0.95)] group-hover:text-[rgba(255,176,96,0.95)] transition-colors">
                {paper.title}
              </h2>
              <p className="mt-2 text-base font-mono font-medium text-[rgba(255,176,96,0.85)]">
                {paper.subtitle}
              </p>
              <p className="mt-4 text-base leading-7 font-mono text-[rgba(255,255,255,0.7)]">
                {paper.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
