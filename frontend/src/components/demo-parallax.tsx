'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

export function DemoParallax() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // progress: 0 when section top hits viewport bottom, 1 when section bottom hits viewport top
      const p = Math.max(0, Math.min(1, (vh - rect.top) / (vh + rect.height)));
      setProgress(p);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const angelY  = -100 + progress * 220;  // starts 100px above, ends 120px below
  const matthewY =  100 - progress * 220; // starts 100px below, ends 120px above

  return (
    <div ref={sectionRef} className="absolute inset-0 pointer-events-none">
      {/* Angel — top right, drifts down */}
      <div
        className="absolute top-0 right-0 w-[307px] sm:w-96 select-none"
        style={{ filter: 'url(#crt-hand)', transform: `translateY(${angelY}px)`, willChange: 'transform' }}
      >
        <Image src="/images/angel.webp" alt="" width={320} height={240} className="w-full h-auto object-contain" style={{ opacity: 0.85 }} />
      </div>

      {/* Saint Matthew — bottom left, rises up */}
      <div
        className="absolute bottom-0 left-0 w-[269px] sm:w-[346px] select-none"
        style={{ filter: 'url(#crt-hand)', transform: `translateY(${matthewY}px)`, willChange: 'transform' }}
      >
        <Image src="/images/saint-matthew.png" alt="" width={288} height={360} className="w-full h-auto object-contain" style={{ opacity: 0.85 }} />
      </div>
    </div>
  );
}
