import type { ReactNode } from "react";

/**
 * HallmarkChapter — vertical chapter primitive on the archival surface.
 *
 * Hallmark-token-bound (`--hl-*` only). No editions/* cream tokens leak.
 * Layout invariants:
 *   - border-top: 1px solid var(--hl-hairline)  (full-bleed, static)
 *   - first chapter has no top border
 *   - numeral is plain tabular-nums, never a circular badge
 *   - eyebrow + title stack vertical (gate 66 — never tag-beside-heading)
 *   - lede is italic body face (no separate serif loaded for this redesign;
 *     italic Google Sans plays the editions narrative-1 role)
 */
export function HallmarkChapter({
  id,
  numeral,
  name,
  title,
  lede,
  first,
  children,
}: {
  id: string;
  numeral?: string;
  name?: string;
  title?: ReactNode;
  lede?: ReactNode;
  first?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      data-chapter={id}
      className={`hl-chapter${first ? " hl-chapter--first" : ""}`}
    >
      <div className="hl-chapter__inner">
        {(numeral || name) && (
          <div className="hl-chapter__eyebrow">
            {numeral && <span className="hl-chapter__numeral">{numeral}</span>}
            {name && <span>{name}</span>}
          </div>
        )}
        {title && <h2 className="hl-chapter__title">{title}</h2>}
        {lede && <p className="hl-chapter__lede">{lede}</p>}
        {children !== undefined && (
          <div className="hl-chapter__figure">{children}</div>
        )}
      </div>
    </section>
  );
}

/**
 * Sub-row — hairline-separated horizontal row inside a chapter.
 * Two-column on ≥48rem, single column on mobile.
 */
export function HallmarkRow({
  label,
  body,
}: {
  label: ReactNode;
  body: ReactNode;
}) {
  return (
    <article className="hl-row">
      <h3 className="hl-row__title">{label}</h3>
      <p className="hl-row__body">{body}</p>
    </article>
  );
}

export function HallmarkRows({ children }: { children: ReactNode }) {
  return <div className="hl-chapter__rows">{children}</div>;
}

/**
 * HallmarkFigure — contained card; dark-figure surface (dark CAN appear
 * inside, NEVER at section bleed — per SPEC §9).
 */
export function HallmarkFigure({
  caption,
  children,
}: {
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="hl-figure">
      {caption && <figcaption className="hl-figure__head">{caption}</figcaption>}
      <div className="hl-figure__body">{children}</div>
    </figure>
  );
}
