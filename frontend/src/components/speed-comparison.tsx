"use client";

import { Timer, Zap, BoxSelect, CheckCircle2 } from "lucide-react";

export function SpeedComparison() {
  return (
    <section className="relative py-32 border-b border-border bg-surface-sunken">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-raised border border-border text-text-secondary text-xs font-mono font-medium uppercase tracking-widest mb-6">
            <Timer className="w-3.5 h-3.5" />
            Why It Matters
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-4 text-balance text-text-primary">
            Computer Use vs Unbrowse
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Computer Use — slow */}
          <div className="p-8 rounded-2xl border border-border bg-surface transition-all shadow-sm">
            <div className="flex items-center gap-4 mb-8">
              <div className="w-12 h-12 rounded-xl bg-surface-raised flex items-center justify-center border border-border">
                <BoxSelect className="w-6 h-6 text-text-muted" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-text-primary flex items-center gap-2">
                  Computer Use
                </h3>
                <p className="text-sm text-text-secondary mt-1">Screenshot-based UI agents</p>
              </div>
            </div>

            <div className="space-y-3 font-mono text-sm relative before:absolute before:inset-y-0 before:left-[11px] before:w-px before:bg-border">
              {["Take screenshot", "Upload to LLM Vision", "Wait for processing", "Predict coordinates", "Move mouse & click", "Wait for DOM load", "Take another screenshot", "Extract parsed text"].map((step, i) => (
                <div key={i} className="flex items-center gap-4 relative z-10">
                  <div className="w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center text-[10px] text-text-muted font-medium shrink-0">
                    {i + 1}
                  </div>
                  <span className="text-text-secondary">{step}</span>
                  {i < 7 && <span className="text-border-strong ml-auto hidden sm:block">→</span>}
                </div>
              ))}
            </div>

            <div className="mt-8 pt-6 border-t border-border flex items-center justify-between bg-surface-raised -mx-8 -mb-8 p-8 rounded-b-2xl">
              <div>
                <span className="text-2xl font-bold font-mono text-text-primary">43.0s</span>
                <span className="text-sm text-text-muted ml-2 font-medium uppercase tracking-wider">time</span>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold font-mono text-text-primary">~12,000</span>
                <span className="text-sm text-text-muted ml-2 font-medium uppercase tracking-wider">tokens</span>
              </div>
            </div>
          </div>

          {/* Unbrowse — fast */}
          <div className="p-8 rounded-2xl border-2 border-orange-500/30 bg-surface transition-all shadow-[0_0_40px_-10px_rgba(255,109,0,0.2)] hover:shadow-[0_0_60px_-15px_rgba(255,109,0,0.3)] hover:border-orange-500/50 z-10">
            <div className="flex items-center gap-4 mb-8">
              <div className="w-12 h-12 rounded-xl bg-orange-500 flex items-center justify-center border border-orange-600 shadow-[0_0_16px_rgba(255,109,0,0.4)]">
                <Zap className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-text-primary flex items-center gap-2">
                  Unbrowse
                </h3>
                <p className="text-sm text-text-secondary mt-1">Direct API execution</p>
              </div>
            </div>

            <div className="space-y-4 font-mono text-sm h-auto min-h-[328px] flex flex-col justify-center">
              <div className="p-4 rounded-xl bg-orange-50/50 border border-orange-500/20">
                <div className="flex items-center gap-3">
                  <span className="px-2 py-1 rounded bg-orange-100 border border-orange-500/20 text-orange-700 text-xs font-medium tracking-wider">GET</span>
                  <span className="text-orange-600 font-medium">/api/search?q=tokyo&guests=2</span>
                </div>
              </div>
              
              <div className="flex justify-center py-2">
                <div className="w-px h-8 bg-orange-500/30 relative">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface p-1">
                    <Zap className="w-3 h-3 text-orange-500" />
                  </div>
                </div>
              </div>
              
              <div className="p-4 rounded-xl bg-orange-50/50 border border-orange-500/20 space-y-2.5">
                <div className="flex items-center justify-between border-b border-orange-500/20 pb-2 mb-1">
                  <span className="text-orange-600 text-xs font-medium uppercase tracking-widest">Executed</span>
                  <span className="text-orange-500/60 font-medium text-[10px]">200 OK · 0.8s</span>
                </div>
                {[
                  { label: "listings retrieved", value: "182 results" },
                  { label: "top result", value: "Shibuya Loft — $89/night" },
                  { label: "availability", value: "Mar 15–22 open" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex flex-wrap sm:flex-nowrap items-center gap-1 sm:gap-2 text-xs">
                      <div className="flex items-center gap-1 sm:gap-2 w-full sm:w-auto">
                        <CheckCircle2 className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                        <span className="text-text-secondary">{label}:</span>
                      </div>
                      <span className="text-text-primary font-medium pl-5 sm:pl-0">{value}</span>
                    </div>
                  ))}
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-orange-500/20 flex items-center justify-between bg-orange-50/50 -mx-8 -mb-8 p-8 rounded-b-2xl">
              <div>
                <span className="text-2xl font-bold font-mono text-orange-500">0.8s</span>
                <span className="text-sm text-text-muted ml-2 font-medium uppercase tracking-wider">time</span>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold font-mono text-orange-500">200</span>
                <span className="text-sm text-text-muted ml-2 font-medium uppercase tracking-wider">tokens</span>
              </div>
            </div>
          </div>
        </div>

        <p className="text-center mt-16 text-xl text-text-secondary font-medium tracking-tight">
          &ldquo;Stop teaching fish to walk. <span className="text-text-primary font-bold">Let them swim.</span>&rdquo;
        </p>
      </div>
    </section>
  );
}
