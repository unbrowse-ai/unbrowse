"use client";

export function InternetEvolution() {
  const eras = [
    { era: "1.0", verb: "READ", examples: "Netscape → Google", color: "text-blue-400", border: "border-blue-500/15", bg: "bg-blue-500/5" },
    { era: "2.0", verb: "WRITE", examples: "Blogger → YouTube", color: "text-purple-400", border: "border-purple-500/15", bg: "bg-purple-500/5" },
    { era: "3.0", verb: "OWN", examples: "MetaMask → OpenSea", color: "text-cyan-400", border: "border-cyan-500/15", bg: "bg-cyan-500/5" },
    { era: "4.0", verb: "ACT", examples: "Unbrowse", color: "text-orange-400", border: "border-orange-500/25", bg: "bg-orange-500/5" },
  ];

  return (
    <section className="relative py-20 border-b border-border">
      <div className="max-w-5xl mx-auto px-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {eras.map((e) => (
            <div key={e.era} className={`p-5 rounded-2xl border ${e.border} ${e.bg} text-center`}>
              <span className="text-xs font-mono text-text-muted">Internet {e.era}</span>
              <div className={`text-2xl font-bold font-mono mt-2 ${e.color}`}>{e.verb}</div>
              <p className="text-xs text-text-muted mt-2">{e.examples}</p>
            </div>
          ))}
        </div>
        <p className="text-center mt-8 text-text-secondary text-sm">
          Building <strong className="text-text-primary">Netscape + Google</strong> for the agentic internet.
        </p>
      </div>
    </section>
  );
}
