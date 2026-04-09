"use client";

import {
  IconCompass,
  IconTerminal,
  IconSeal,
  IconSignal,
  IconSigil,
} from "@/components/archival-icons";

export function WorksWith() {
  const tools = [
    { name: "Claude Code", Icon: IconCompass },
    { name: "Cursor", Icon: IconTerminal },
    { name: "OpenClaw", Icon: IconSeal },
    { name: "Windsurf", Icon: IconSignal },
    { name: "Any Skill Agent", Icon: IconSigil },
  ];

  return (
      <section className="py-16 sm:py-20 border-b border-border bg-surface-sunken">
       <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <p className="text-center text-xs font-mono text-text-muted uppercase tracking-widest mb-10 font-medium">
          Works with your stack
        </p>
        <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
          {tools.map(({ name, Icon }) => (
            <div
              key={name}
              className="group inline-flex items-center gap-3 px-6 py-3 rounded-sm border border-border bg-surface hover:border-orange-500/30 hover:bg-orange-50/50 transition-all cursor-default shadow-sm"
            >
              <Icon size={16} className="text-text-muted group-hover:text-orange-500 transition-colors" />
              <span className="text-sm font-medium text-text-secondary group-hover:text-orange-600 transition-colors">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
