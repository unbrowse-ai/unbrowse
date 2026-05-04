'use client';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#090806' }}>
          <div className="max-w-md w-full border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 p-8 rounded-sm">
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
              ##  Error
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-balance text-[rgba(255,176,96,0.9)]">
              Something went wrong
            </h1>
            <p className="mt-3 text-sm text-text-secondary leading-relaxed">
              {error.message || 'An unexpected error occurred'}
            </p>
            <p className="mt-6 text-sm font-mono text-[rgba(255,122,32,0.5)]">
              [ Please refresh the page ]
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
