"use client";

export function SpeedComparison() {
  return (
    <section className="relative py-24 border-b border-border">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-14">
          <span className="text-xs font-mono text-orange-500 uppercase tracking-widest">Why It Matters</span>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-4">
            Computer Use vs <span className="gradient-text">Unbrowse</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Computer Use — slow */}
          <div className="p-6 rounded-2xl border border-red-500/20 bg-red-500/[0.02]">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-red-400">Computer Use</h3>
                <p className="text-xs text-text-muted">Screenshot-based agents</p>
              </div>
            </div>

            <div className="space-y-2 font-mono text-sm">
              {["Screenshot page", "Send to LLM", "Click element", "Wait for load", "Screenshot again", "Send to LLM", "Extract text", "Parse response"].map((step, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-red-400/40 text-xs">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-text-muted">{step}</span>
                  {i < 7 && <span className="text-red-400/30 ml-auto">→</span>}
                </div>
              ))}
            </div>

            <div className="mt-6 pt-5 border-t border-red-500/15 flex items-center justify-between">
              <div>
                <span className="text-2xl font-bold font-mono text-red-400">43s</span>
                <span className="text-xs text-text-muted ml-2">total time</span>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold font-mono text-red-400/70">12,000</span>
                <span className="text-xs text-text-muted ml-1">tokens</span>
              </div>
            </div>
          </div>

          {/* Unbrowse — fast */}
          <div className="p-6 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.02]">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-emerald-400">Unbrowse</h3>
                <p className="text-xs text-text-muted">Direct API calls</p>
              </div>
            </div>

            <div className="space-y-3 font-mono text-sm">
              <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-bold">GET</span>
                  <span className="text-text-primary">/api/search?q=tokyo</span>
                </div>
              </div>
              <div className="text-center text-emerald-400/40">↓</div>
              <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                <span className="text-emerald-400/60 text-xs">Response:</span>
                <pre className="text-xs text-text-muted mt-1">{`{ "results": [...], "count": 24 }`}</pre>
              </div>
            </div>

            <div className="mt-6 pt-5 border-t border-emerald-500/15 flex items-center justify-between">
              <div>
                <span className="text-2xl font-bold font-mono text-emerald-400">0.8s</span>
                <span className="text-xs text-text-muted ml-2">total time</span>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold font-mono text-emerald-400/70">200</span>
                <span className="text-xs text-text-muted ml-1">tokens</span>
              </div>
            </div>
          </div>
        </div>

        <p className="text-center mt-10 text-lg sm:text-xl text-text-secondary italic">
          &ldquo;Stop teaching fish to walk. <span className="text-orange-500 font-semibold not-italic">Let them swim.</span>&rdquo;
        </p>
      </div>
    </section>
  );
}
