"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type EditionsChapter = {
  id: string;
  label: string;
};

/**
 * EditionsNav — sticky top nav with chapter index that highlights the
 * currently-visible chapter as the reader scrolls. Mirrors the
 * shopify.com/editions/winter2026 chapter-jump pattern.
 *
 * Use on pages that follow the chapter microsite format. Other pages
 * keep the regular site navbar.
 */
export function EditionsNav({
  chapters,
  primaryCta,
  primaryHref,
}: {
  chapters: EditionsChapter[];
  primaryCta?: string;
  primaryHref?: string;
}) {
  const [activeId, setActiveId] = useState<string>(chapters[0]?.id ?? "");

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return;
    }
    const targets = chapters
      .map((c) => document.getElementById(c.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-40% 0px -45% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [chapters]);

  return (
    <nav className="editions-nav" aria-label="Editions chapter navigation">
      <div className="editions-nav-inner">
        <Link
          href="/"
          className="font-display text-base font-medium text-text-primary"
          style={{ letterSpacing: "-0.012em" }}
        >
          Unbrowse
        </Link>
        <div className="editions-nav-chapters" role="list">
          {chapters.map((c, i) => (
            <a
              key={c.id}
              href={`#${c.id}`}
              className={activeId === c.id ? "is-active" : ""}
              role="listitem"
              style={{ ["--i" as string]: i } as React.CSSProperties}
            >
              {c.label}
            </a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Link
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline text-sm text-text-secondary hover:text-text-primary"
          >
            GitHub
          </Link>
          {primaryCta && primaryHref && (
            <Link href={primaryHref} className="cta-primary cta-accent text-sm">
              {primaryCta}
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
