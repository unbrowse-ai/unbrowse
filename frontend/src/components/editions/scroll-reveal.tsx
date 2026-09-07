"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode, type HTMLAttributes } from "react";

/**
 * ScrollReveal — progressively enhanced chapter reveal.
 *
 * SSR-safe: initial render carries NO `data-reveal` attribute so the
 * content is fully visible by default. If JS never hydrates, the page
 * reads fine. Only AFTER mount does the component flip itself into the
 * pending → in animation cycle, then the IntersectionObserver takes
 * over and flips to "in" when the section crosses the viewport.
 *
 * Honours prefers-reduced-motion: when reduce is set, the component
 * skips the pending state entirely and renders content immediately.
 */
export function ScrollReveal({
  as: Tag = "div",
  threshold = 0.18,
  rootMargin = "0px 0px -10% 0px",
  children,
  className,
  ...rest
}: {
  as?: ElementType;
  threshold?: number;
  rootMargin?: string;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  const ref = useRef<HTMLElement | null>(null);
  // Three states drive the data-reveal attribute:
  //   undefined → no attribute (SSR + pre-mount; content fully visible)
  //   "pending" → mounted, animation armed, opacity 0
  //   "in"      → observer fired, animation plays
  const [state, setState] = useState<undefined | "pending" | "in">(undefined);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Reduced motion: skip the animation entirely.
    if (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setState("in");
      return;
    }

    // Bail-out: no observer support → render visible immediately.
    if (typeof IntersectionObserver === "undefined") {
      setState("in");
      return;
    }

    // If the element is already in viewport at mount, keep state undefined
    // so the SSR-visible default (no data-reveal attribute) persists. The
    // earlier setState("in") here caused the H1 + word-split to flash
    // invisible while the entry animation re-ran client-side.
    const rect = node.getBoundingClientRect();
    const alreadyInView =
      rect.top < window.innerHeight * (1 - threshold * 0.5) && rect.bottom > 0;
    if (alreadyInView) {
      return;
    }

    setState("pending");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(node);

    // Failsafe: if for any reason the observer never fires (browser bug,
    // tab backgrounded during mount, etc.), reveal after 1.5s.
    const failsafe = window.setTimeout(() => setState("in"), 1500);
    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, [threshold, rootMargin]);

  const Element = Tag as ElementType;
  return (
    <Element
      ref={ref as React.MutableRefObject<HTMLElement | null>}
      data-reveal={state}
      className={className}
      {...rest}
    >
      {children}
    </Element>
  );
}

/**
 * WordSplit — splits a string into word-spans for the hero slide-in.
 */
export function WordSplit({
  text,
  className,
  startIndex = 0,
}: {
  text: string | string[];
  className?: string;
  startIndex?: number;
}) {
  const lines = Array.isArray(text) ? text : [text];
  let counter = startIndex;
  return (
    <span className={`word-split ${className ?? ""}`}>
      {lines.map((line, li) => {
        const tokens = line.split(/(\s+)/);
        return (
          <span key={li} className="word-split-line">
            {tokens.map((tok, ti) => {
              if (/^\s+$/.test(tok)) {
                return <span key={ti} className="word-space" aria-hidden> </span>;
              }
              const i = counter++;
              return (
                <span
                  key={ti}
                  className="word"
                  style={{ ["--i" as string]: i } as React.CSSProperties}
                >
                  {tok}
                </span>
              );
            })}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </span>
  );
}
