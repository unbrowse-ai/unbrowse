'use client';

export function ScrollToButton({
  sectionId, className, children,
}: { sectionId: string; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' })}
      className={className}
    >
      {children}
    </button>
  );
}
