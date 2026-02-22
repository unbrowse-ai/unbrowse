"use client";

export function WorksWith() {
  const tools = [
    { name: "Claude Code", icon: "🤖" },
    { name: "Cursor", icon: "⌨️" },
    { name: "OpenClaw", icon: "🦞" },
    { name: "Windsurf", icon: "🏄" },
    { name: "Any MCP Agent", icon: "🔌" },
  ];

  return (
    <section className="py-16 border-b border-border">
      <div className="max-w-5xl mx-auto px-6">
        <p className="text-center text-xs font-mono text-text-muted uppercase tracking-widest mb-8">
          Works with your stack
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          {tools.map((t) => (
            <div
              key={t.name}
              className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-xl border border-border bg-surface hover:border-orange-500/30 transition-colors"
            >
              <span className="text-lg">{t.icon}</span>
              <span className="text-sm font-medium text-text-secondary">{t.name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
