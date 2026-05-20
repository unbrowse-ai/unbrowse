'use client';

import { track } from '@/lib/umami';

export function ScrollToButton({
  sectionId, className, children, umamiEvent,
}: { sectionId: string; className?: string; children: React.ReactNode; umamiEvent?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (umamiEvent) track(umamiEvent, { target_section: sectionId });
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
      }}
      className={className}
    >
      {children}
    </button>
  );
}
