'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

// Scanline tile: 100×3 SVG — rows 0-1 transparent, row 2 orange
// feTile will repeat this to fill the image, creating 3px-pitch horizontal lines
const TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="3"><rect y="2" width="100" height="1" fill="rgba(255,72,0,0.58)"/></svg>`;
const TILE_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(TILE_SVG)}`;

export function HeroHands() {
  const [tx, setTx] = useState(45);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
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

      {/* Human hand — left, reaching right */}
      <div
        className="absolute left-0 bottom-0 w-[50%] h-[58%] max-sm:w-[63%] max-sm:h-[55%] pointer-events-none select-none"
        style={{ transform: `translateX(-${tx}%) translateY(${isMobile ? '-2%' : '20%'})` }}
      >
        <Image
          src="/images/human-hand-nobg.png"
          alt=""
          fill
          className="object-cover object-right-center max-sm:object-contain max-sm:object-bottom"
          style={{ opacity: 0.85, filter: 'url(#crt-hand)' }}
        />
      </div>

      {/* Android hand — right, reaching left */}
      <div
        className="absolute right-0 bottom-0 w-[50%] h-[58%] max-sm:w-[55%] max-sm:h-[48%] pointer-events-none select-none"
        style={{ transform: `translateX(${tx}%) translateY(${isMobile ? '1%' : '20%'})` }}
      >
        <Image
          src="/images/android-hand-nobg.png"
          alt=""
          fill
          className="object-cover object-left-center max-sm:object-contain max-sm:object-bottom"
          style={{ opacity: 0.85, filter: 'url(#crt-hand)' }}
        />
      </div>
    </>
  );
}
