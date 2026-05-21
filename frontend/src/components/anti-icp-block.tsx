'use client';

/**
 * Anti-ICP block. Load-bearing per /positioning-messaging guardrail:
 * "differentiation requires sacrifice; say who it is not for." Each
 * line names a specific tool the reader should keep using if their
 * job is the one we are NOT optimizing for.
 */
export function AntiIcpBlock() {
  const rows: Array<{ scenario: string; instead: string }> = [
    {
      scenario: "UI regression CI suites with selectors and traces",
      instead: "Keep Playwright proper",
    },
    {
      scenario: "Canvas-heavy apps that need imperative JS in-page",
      instead: "Use Browser Use or Stagehand",
    },
    {
      scenario: "End-user chat interfaces",
      instead: "Use Claude / ChatGPT",
    },
  ];

  return (
    <section id="anti-icp" className="relative py-12 sm:py-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm p-6 sm:p-8">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
            ##  Who unbrowse is not for
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-text-primary mb-5">
            Three jobs we do not optimize for.
          </h2>

          <div className="space-y-2 font-mono text-sm">
            {rows.map((r) => (
              <div
                key={r.scenario}
                className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 border-b border-[rgba(255,122,32,0.1)] last:border-0 py-2.5"
              >
                <span className="text-text-secondary flex-1">→ {r.scenario}</span>
                <span className="text-[rgba(255,176,96,0.85)]">{r.instead}</span>
              </div>
            ))}
          </div>

          <p className="mt-5 text-sm text-text-secondary leading-relaxed">
            If you need any of those, unbrowse is the wrong tool. We optimize
            for one job: an agent calling an API behind a website, without the
            browser tax.
          </p>
        </div>
      </div>
    </section>
  );
}
