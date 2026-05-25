import type { Metadata } from "next";
import Link from "next/link";
import { Chapter, CtaLink } from "@/components/editions";

export const metadata: Metadata = {
  title: "Papers | Unbrowse",
  description:
    "Canonical paper index for Unbrowse research, whitepapers, and systems writing.",
  alternates: { canonical: "https://www.unbrowse.ai/papers" },
};

const papers = [
  {
    title: "Internal APIs Are All You Need",
    subtitle:
      "Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures",
    href: "/internal-apis-are-all-you-need",
    arxiv: "arXiv:2604.00694",
    authors: "Tham, Mac Gregor Garcia, Hahn",
    description:
      "The Unbrowse paper arguing that the internal APIs already powering modern websites are the machine-native interface for autonomous agents, and that a shared route graph turns repeated browser rediscovery into collective memory.",
  },
];

export default function PapersIndexPage() {
  return (
    <Chapter
      id="papers"
      name="Research"
      title={<>Papers.</>}
      lede="Canonical index for Unbrowse whitepapers, systems writing, and research artifacts."
    >
      <div className="space-y-6 max-w-3xl">
        {papers.map((paper) => (
          <Link
            key={paper.href}
            href={paper.href}
            className="block group border border-border bg-surface-raised hover:border-border-strong p-7 sm:p-9 rounded-sm transition-colors"
          >
            <p className="stamp-label">{paper.arxiv} · {paper.authors}</p>
            <h2
              className="mt-3 font-display text-text-primary group-hover:text-orange-600 transition-colors"
              style={{ fontSize: "clamp(1.75rem, 3vw, 2.5rem)", letterSpacing: "-0.024em", lineHeight: 1.1 }}
            >
              {paper.title}
            </h2>
            <p className="mt-2 text-base text-text-secondary">{paper.subtitle}</p>
            <p className="mt-4 text-base text-text-secondary leading-relaxed">
              {paper.description}
            </p>
            <div className="mt-5 cta-link">Read the paper</div>
          </Link>
        ))}
      </div>

      <div className="mt-12">
        <CtaLink href="https://arxiv.org/abs/2604.00694" external>
          Open on arXiv
        </CtaLink>
      </div>
    </Chapter>
  );
}
