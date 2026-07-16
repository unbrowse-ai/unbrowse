import type { Metadata } from "next";
import Link from "next/link";
import { PAPERS as papers } from "@/lib/papers";

export const metadata: Metadata = {
  title: "Papers | Unbrowse",
  description:
    "Canonical paper index for Unbrowse research, whitepapers, and systems writing.",
  alternates: {
    canonical: "https://www.unbrowse.ai/papers",
  },
};

export default function PapersIndexPage() {
  return (
    <div className="bg-background min-h-screen text-text-primary">
      <div className="max-w-4xl mx-auto px-6 py-16 sm:py-24">
        <div className="mb-10">
          <Link
            href="/"
            className="text-sm font-mono text-[rgba(255,176,96,0.9)] hover:text-[rgba(255,176,96,1)] transition-colors"
          >
            [← back to unbrowse]
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-10">
          <span className="eyebrow mb-4" style={{ display: "block" }}>Research</span>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight">Papers</h1>
          <p className="mt-4 text-lg sm:text-xl font-mono text-text-secondary max-w-3xl">
            Canonical index for Unbrowse whitepapers, systems writing, and research artifacts.
          </p>
        </header>

        <div className="space-y-6">
          {papers.map((paper) => {
            const cardClass =
              "block group rounded-sm border border-border bg-surface-raised p-6 sm:p-8 hover:border-border-strong hover:bg-surface transition-colors";
            const body = (
              <>
                <h2 className="flex items-baseline gap-3 text-2xl sm:text-3xl font-semibold tracking-tight text-text-primary group-hover:text-[rgba(255,176,96,0.95)] transition-colors">
                  <span>{paper.title}</span>
                  {paper.pdf && (
                    <span className="eyebrow shrink-0" style={{ fontSize: "0.625rem" }}>PDF ↗</span>
                  )}
                </h2>
                <p className="mt-2 text-base font-mono font-medium text-[rgba(255,176,96,0.85)]">
                  {paper.subtitle}
                </p>
                <p className="mt-4 text-base leading-7 font-mono text-text-secondary">
                  {paper.description}
                </p>
              </>
            );
            return paper.pdf ? (
              <a key={paper.href} href={paper.href} target="_blank" rel="noopener" className={cardClass}>
                {body}
              </a>
            ) : (
              <Link key={paper.href} href={paper.href} className={cardClass}>
                {body}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
