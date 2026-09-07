"use client";

import { useEffect, useState } from "react";

export type RailChapter = { id: string; label: string };

/**
 * ChapterRail — Hallmark N5 (Floating pill) variant, chapter-pill rail.
 *
 * Sticky at top of viewport. IntersectionObserver with rootMargin "5%"
 * flips the active class on the matching pill as the chapter enters
 * the viewport (per SPEC §4).
 *
 * All colors via --hl-* tokens (gate 58). No inline hex.
 */
export function ChapterRail({ chapters }: { chapters: RailChapter[] }) {
  const [activeId, setActiveId] = useState<string>(chapters[0]?.id ?? "");

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
    const targets = chapters
      .map((c) => document.getElementById(c.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
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
    <nav className="hl-rail" aria-label="Chapter navigation">
      <div className="hl-rail__inner" role="list">
        {chapters.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            role="listitem"
            className={`hl-rail__link ${activeId === c.id ? "is-active" : ""}`}
          >
            {c.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
