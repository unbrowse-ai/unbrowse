import { Chapter } from "../chapter";
import { ThreePanelVisual } from "@/components/three-panel-visual";

/**
 * Chapter [02] — The Problem.
 *
 * Source: MAY18-INVENTORY §13 ThreePanelVisual. The animated 3-panel
 * cost-delta is the chapter's load-bearing figure. We contain it inside
 * an `ed-dark-figure` host so cream is visible at the chapter edges and
 * the figure no longer bleeds full-width.
 *
 * The legacy ThreePanelVisual renders three dark panels; the host
 * constrains them to a rounded card and overrides any inherited width.
 */
export function Ch02Problem() {
  return (
    <Chapter
      id="problem"
      number="[02]"
      name="The problem"
      title="Three ways to see the same website."
      lede="Humans see UI. Agents see DOM. Unbrowse calls the API."
    >
      <div className="ed-three-panel-host">
        <ThreePanelVisual />
      </div>
      <p className="problem-delta">
        ~9s, 514K tokens, $1.54 (browser){" "}
        <span aria-hidden="true">·</span> ~0.8s, 1.0K tokens, $0.0030
        (unbrowse).
      </p>

      <style>{`
        .editions-surface .ed-three-panel-host {
          background-color: var(--ed-ink);
          color: var(--ed-cream-warm);
          border-radius: 0.75rem;
          padding: clamp(0.75rem, 2vw, 1.5rem);
          margin: clamp(1rem, 2vw, 1.5rem) 0;
          overflow: hidden;
          max-width: 100%;
        }
        /* Neutralize any full-bleed background the inner panel applies. */
        .editions-surface .ed-three-panel-host section {
          background-color: transparent !important;
          padding-block: 0 !important;
        }
        .editions-surface .ed-three-panel-host > * {
          max-width: 100%;
        }
        .problem-delta {
          margin-top: clamp(1.5rem, 3vw, 2.25rem);
          font-family: var(--font-mono);
          font-size: 1rem;
          line-height: 1.5;
          color: var(--ed-ink);
          letter-spacing: 0.01em;
        }
      `}</style>
    </Chapter>
  );
}
