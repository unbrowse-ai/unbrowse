"use client";

import { TerminalSquare, Bot, Code2, Waves, PlugZap } from "lucide-react";

export function WorksWith() {
  const tools = [
    { name: "Claude Code", icon: Bot },
    { name: "Cursor", icon: TerminalSquare },
    { name: "OpenClaw", icon: Code2 },
    { name: "Windsurf", icon: Waves },
    { name: "Claude Desktop", icon: Bot },
    { name: "ElizaOS", icon: PlugZap },
    { name: "Hermes", icon: PlugZap },
    { name: "LangChain", icon: PlugZap },
    { name: "Vercel AI SDK", icon: PlugZap },
  ];

  return (
      <section className="py-16 sm:py-20 border-b border-border bg-surface-sunken">
       <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <p className="text-center text-xs font-mono text-text-muted uppercase tracking-widest mb-10 font-medium">
          Works with your stack
        </p>
        <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
          {tools.map((t) => {
            const Icon = t.icon;
              return (
                <div
                  key={t.name}
                  className="group inline-flex items-center gap-3 px-6 py-3 rounded-xl border border-border bg-surface hover:border-orange-500/30 hover:bg-orange-50/50 transition-all cursor-default shadow-sm"
                >
                  <Icon className="w-4 h-4 text-text-muted group-hover:text-orange-500 transition-colors" />
                  <span className="text-sm font-medium text-text-secondary group-hover:text-orange-600 transition-colors">{t.name}</span>
                </div>
              );
          })}
        </div>
      </div>
    </section>
  );
}
