'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

export function AthensParallax() {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // progress: 0 when section top enters viewport, 1 when bottom exits
      const p = Math.max(0, Math.min(1, (vh - rect.top) / (vh + rect.height)));
      setOffset(p * 200); // moves an extra 200px down as user scrolls through
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      ref={ref}
      className="max-sm:relative sm:absolute left-0 right-0 pointer-events-none select-none sm:bottom-[-280px]"
      style={{
        filter: 'url(#crt-hand)',
        transform: `translateY(${offset}px)`,
        willChange: 'transform',
      }}
    >
      <Image
        src="/images/school-of-athens.png"
        alt=""
        width={1200}
        height={480}
        className="w-full h-auto object-contain object-bottom"
        style={{ opacity: 0.7 }}
      />
    </div>
  );
}
