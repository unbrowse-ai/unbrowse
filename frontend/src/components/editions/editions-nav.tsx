"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type EditionsChapter = {
  id: string;
  label: string;
};

/**
 * EditionsNav — sticky top chapter nav for the cream editions surface.
 *
 * SPEC §4 invariants:
 *   - position: sticky, top: 0, 56px tall, full-width hairline border-bottom
 *   - backdrop-blur on cream (rgba(220,220,208,0.85))
 *   - IntersectionObserver with rootMargin: "5%" drives active pill
 *   - active pill: color #292919; inactive: #5c5c4e; transition 0.18s
 *   - on mobile (<768px) hide pill row entirely, show only logo + GitHub
 */
export function EditionsNav({
  chapters,
}: {
  chapters: EditionsChapter[];
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
        // SPEC §4: rootMargin "5%" — active flips as chapter enters near the
        // top of the viewport. We track topmost-visible chapter.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .map((e) => ({ id: e.target.id, top: e.boundingClientRect.top }))
          .sort((a, b) => a.top - b.top);
        if (visible[0]) setActiveId(visible[0].id);
      },
      { rootMargin: "5%", threshold: [0, 0.1, 0.5] },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [chapters]);

  return (
    <nav className="editions-nav" aria-label="Editions chapter navigation">
      <div className="editions-nav-inner">
        <Link href="/" className="editions-nav-logo">
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
        <Link
          href="https://github.com/unbrowse-ai/unbrowse"
          target="_blank"
          rel="noopener noreferrer"
          className="editions-nav-link ml-auto"
        >
          GitHub
        </Link>
      </div>
    </nav>
  );
}
