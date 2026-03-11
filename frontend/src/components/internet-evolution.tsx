"use client";

import { History, BookOpen, PenTool, KeyRound, Workflow } from "lucide-react";

export function InternetEvolution() {
  const eras = [
    { 
      era: "1.0", 
      verb: "READ", 
      examples: "Google → Chrome", 
      color: "text-text-primary", 
      border: "border-border", 
      bg: "bg-surface-sunken",
      icon: BookOpen,
      iconColor: "text-text-muted"
    },
    { 
      era: "2.0", 
      verb: "WRITE", 
      examples: "Blogger → YouTube", 
      color: "text-text-primary", 
      border: "border-border", 
      bg: "bg-surface-sunken",
      icon: PenTool,
      iconColor: "text-text-muted"
    },
    { 
      era: "3.0", 
      verb: "OWN", 
      examples: "MetaMask → OpenSea", 
      color: "text-text-primary", 
      border: "border-border", 
      bg: "bg-surface-sunken",
      icon: KeyRound,
      iconColor: "text-text-muted"
    },
    { 
      era: "4.0", 
      verb: "ACT", 
      examples: "Unbrowse", 
      color: "text-white", 
      border: "border-orange-600", 
      bg: "bg-orange-500",
      icon: Workflow,
      iconColor: "text-white",
      glow: "shadow-[0_0_40px_-10px_rgba(255,109,0,0.5)] scale-105 z-10"
    },
  ];

  return (
    <section className="relative py-32 border-b border-border bg-surface">
      <div className="relative max-w-6xl mx-auto px-6">
        
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-raised border border-border text-text-secondary text-xs font-mono font-medium uppercase tracking-widest mb-6">
            <History className="w-3.5 h-3.5" />
            Internet Evolution
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-2 text-balance text-text-primary">
            The transition to agentic actions
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {eras.map((e, idx) => {
            const Icon = e.icon;
            return (
              <div key={e.era} className={`group relative p-8 rounded-2xl border ${e.border} ${e.bg} ${e.glow || ''} text-center overflow-hidden transition-all duration-300`}>
                <div className="absolute top-0 right-0 p-4 opacity-10">
                  <Icon className={`w-16 h-16 ${e.iconColor}`} />
                </div>
                <div className="relative z-10 flex flex-col items-center h-full">
                  <span className={`px-3 py-1 rounded border text-xs font-mono font-medium mb-6 ${e.era === "4.0" ? "bg-surface/20 border-surface/20 text-surface" : "bg-surface border-border text-text-muted"}`}>Web {e.era}</span>
                  <div className={`text-4xl font-bold font-mono tracking-tight mb-4 ${e.color}`}>{e.verb}</div>
                  <div className={`mt-auto pt-6 border-t w-full ${e.era === "4.0" ? "border-surface/20" : "border-border"}`}>
                    <p className={`text-sm font-medium ${e.era === "4.0" ? "text-surface/90" : "text-text-secondary"}`}>{e.examples}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        <div className="text-center mt-16">
          <p className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-surface-sunken border border-border text-text-secondary text-base font-medium shadow-sm">
            Building <strong className="text-text-primary">Chrome + Google</strong> for the agentic internet.
          </p>
        </div>
      </div>
    </section>
  );
}
