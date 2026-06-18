"use client";

import Link from "next/link";
import { PAPERS, papersByTheme, type Paper, type PaperTheme } from "@/lib/papers";

// "The papers behind this" — a reusable block so any page can point back to the
// canonical papers, filtered by theme. Uses the same on-system Hallmark classes the
// how-unbrowse-pays page uses (token colors only, scoped transitions).

function PaperLink({ paper }: { paper: Paper }) {
  const className = "underline hover:text-text-secondary";
  return paper.pdf ? (
    <a href={paper.href} target="_blank" rel="noopener" className={className}>
      {paper.title}
    </a>
  ) : (
    <Link href={paper.href} className={className}>
      {paper.title}
    </Link>
  );
}

export function PapersBehind({ theme, intro }: { theme?: PaperTheme; intro?: string }) {
  const papers = theme ? papersByTheme(theme) : PAPERS;
  if (papers.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-medium text-text-primary">The papers behind this</h2>
      {intro && <p className="text-sm leading-relaxed text-text-muted">{intro}</p>}
      <ul className="space-y-2 text-sm leading-relaxed text-text-muted">
        {papers.map((paper) => (
          <li key={paper.id}>
            <PaperLink paper={paper} />
          </li>
        ))}
        <li>
          All of them:{" "}
          <Link href="/papers" className="underline hover:text-text-secondary">/papers</Link>.
        </li>
      </ul>
    </section>
  );
}
