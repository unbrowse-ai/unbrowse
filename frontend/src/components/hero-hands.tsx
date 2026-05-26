'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

// Scanline tile: 100×3 SVG — rows 0-1 transparent, row 2 orange
// feTile will repeat this to fill the image, creating 3px-pitch horizontal lines
const TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="3"><rect y="2" width="100" height="1" fill="rgba(255,72,0,0.58)"/></svg>`;
const TILE_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(TILE_SVG)}`;

// Sistine fingertip-to-fingertip line — the Michelangelo allusion made literal.
// Coordinates are in % of the parent <section> (hero masthead). The two hands
// are positioned via bottom/left/right + translateX/Y in viewport units, so
// the fingertips converge ~horizontally just above the bottom edge. These
// values were picked by visual inspection at 1440x900; if hand positioning
// changes, the endpoints below need to move too.
const LINE_FROM = { x: 47, y: 76 }; // tip of human hand (left side, reaching right)
const LINE_TO   = { x: 53, y: 76 }; // tip of android hand (right side, reaching left)

export function HeroHands() {
  const [tx, setTx] = useState(45);
  const [isMobile, setIsMobile] = useState(false);
  const [lineVisible, setLineVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const lineRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const update = () => {
      const raw = window.scrollY / (window.innerHeight * 0.7);
      setTx(Math.max(-20, 45 - raw * 65));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Draw-on the line when it enters the viewport. Single-shot; once visible,
  // stays visible (no toggle on scroll out). IntersectionObserver target is
  // the SVG itself, which lives inside the same hero section as the hands.
  useEffect(() => {
    if (!lineRef.current) return;
    if (reduceMotion) {
      setLineVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setLineVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(lineRef.current);
    return () => io.disconnect();
  }, [reduceMotion]);

  return (
    <>
      {/*
        SVG filter applied directly to the img elements.
        feComposite operator="in" at the end clips the result to SourceAlpha,
        so effects are 100% constrained to the original image's opaque pixels — zero bleed.
      */}
      <svg
        width="0" height="0"
        style={{ position: 'absolute', pointerEvents: 'none', overflow: 'hidden' }}
        aria-hidden="true"
      >
        <defs>
          <filter
            id="crt-hand"
            filterUnits="objectBoundingBox"
            primitiveUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            {/* 1. Desaturate */}
            <feColorMatrix in="SourceGraphic" type="saturate" values="0.28" result="desat" />

            {/* 2. Contrast + brightness */}
            <feComponentTransfer in="desat" result="graded">
              <feFuncR type="linear" slope="1.24" intercept="-0.24" />
              <feFuncG type="linear" slope="1.24" intercept="-0.24" />
              <feFuncB type="linear" slope="1.24" intercept="-0.24" />
              <feFuncA type="identity" />
            </feComponentTransfer>

            {/* 3. Warm orange-sepia tint */}
            <feColorMatrix
              in="graded"
              type="matrix"
              values="0.84 0.14 0.02 0  0.02
                      0.10 0.82 0.04 0  0
                      0    0.03 0.66 0  0
                      0    0    0    1  0"
              result="tinted"
            />

            {/* 4. Create orange scanline tile and tile across filter region */}
            <feImage href={TILE_URI} x="0" y="0" width="100" height="3" result="stripe" preserveAspectRatio="none" />
            <feTile in="stripe" result="scanlines" />

            {/* 5. Multiply scanlines onto tinted image */}
            <feBlend in="tinted" in2="scanlines" mode="multiply" result="blended" />

            {/* 6. Clip everything to the original image alpha — prevents ANY bleed */}
            <feComposite in="blended" in2="SourceAlpha" operator="in" />
          </filter>
        </defs>
      </svg>

      {/* Human hand — left, reaching right.
          PERF: priority + sizes so the optimizer picks the right
          breakpoint and the LCP candidate (hero text behind) doesn't
          wait on a default-sized request. `contain: layout` keeps the
          internal absolute fill from leaking reflow into the hero
          section.

          CLS lock: heights/widths are viewport-relative (vh/vw), NOT
          parent-relative (%). Parent-relative sizes shifted when the
          hero section's height stabilized post-font-load (CLS 0.30 at
          823ms). Viewport-relative pin removes the dependency.
          */}
      <div
        className="absolute left-0 bottom-0 w-[50vw] h-[52vh] max-sm:w-[63vw] max-sm:h-[46vh] pointer-events-none select-none"
        style={{
          transform: `translateX(-${tx}%) translateY(${isMobile ? '-2%' : '20%'})`,
          contain: 'layout paint',
        }}
      >
        <Image
          src="/images/human-hand-nobg.png"
          alt=""
          fill
          sizes="(max-width: 640px) 63vw, 50vw"
          className="object-cover object-right-center max-sm:object-contain max-sm:object-bottom"
          style={{ opacity: 0.85, filter: 'url(#crt-hand)' }}
        />
      </div>

      {/* Android hand — right, reaching left */}
      <div
        className="absolute right-0 bottom-0 w-[50vw] h-[52vh] max-sm:w-[55vw] max-sm:h-[40vh] pointer-events-none select-none"
        style={{
          transform: `translateX(${tx}%) translateY(${isMobile ? '1%' : '20%'})`,
          contain: 'layout paint',
        }}
      >
        <Image
          src="/images/android-hand-nobg.png"
          alt=""
          fill
          sizes="(max-width: 640px) 55vw, 50vw"
          className="object-cover object-left-center max-sm:object-contain max-sm:object-bottom"
          style={{ opacity: 0.85, filter: 'url(#crt-hand)' }}
        />
      </div>

      {/* Sistine fingertip-to-fingertip line. Drawn AFTER hands so it sits on
          top. Lives in the same absolute layer as the hands — the parent
          masthead is position:relative. SVG viewBox is 100x100, so x/y
          values are %. Stroke is dashed (1.5 2.5) archival-orange,
          rgba(255,82,0,0.45). Draw-on animation uses stroke-dashoffset
          driven by IntersectionObserver. Reduced-motion: rendered static. */}
      <svg
        ref={lineRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ overflow: 'visible' }}
      >
        <line
          x1={LINE_FROM.x}
          y1={LINE_FROM.y}
          x2={LINE_TO.x}
          y2={LINE_TO.y}
          stroke="rgba(255,82,0,0.45)"
          strokeWidth="0.18"
          strokeDasharray="1.5 2.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            // Dash drawing: pathLength normalized so dashoffset 1 = hidden,
            // 0 = fully drawn. Animation only triggered when lineVisible.
            // strokeDasharray pattern stays the dotted look; the
            // stroke-dashoffset transition draws it in.
            opacity: lineVisible ? 1 : 0,
            transition: reduceMotion
              ? 'none'
              : 'opacity 600ms ease-out 200ms',
          }}
        />
        {/* Soft glow underline — separate stroke at slightly larger width,
            very low opacity, no dash, so the dotted line reads as orange-glow. */}
        <line
          x1={LINE_FROM.x}
          y1={LINE_FROM.y}
          x2={LINE_TO.x}
          y2={LINE_TO.y}
          stroke="rgba(255,82,0,0.12)"
          strokeWidth="0.6"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: lineVisible ? 1 : 0,
            transition: reduceMotion
              ? 'none'
              : 'opacity 900ms ease-out 250ms',
          }}
        />
      </svg>
    </>
  );
}
