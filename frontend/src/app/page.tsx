import Link from "next/link";

export default function Home() {
  return (
    <div className="relative">
      {/* Hero */}
      <section className="relative min-h-[92vh] flex items-center overflow-hidden">
        {/* Grid background */}
        <div className="absolute inset-0 grid-pattern opacity-40" />

        {/* Radial glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[600px]
                        bg-gradient-radial from-orange-500/10 via-transparent to-transparent
                        rounded-full blur-3xl" />

        {/* Geometric accents */}
        <div className="absolute top-32 right-[15%] w-64 h-64 border border-orange-200 rounded-3xl
                        rotate-12 opacity-30" />
        <div className="absolute bottom-32 left-[10%] w-48 h-48 border border-orange-300 rounded-2xl
                        -rotate-6 opacity-20" />

        <div className="relative max-w-7xl mx-auto px-6 pt-32 pb-20">
          <div className="max-w-3xl">
            {/* Badge */}
            <div className="animate-fade-up inline-flex items-center gap-2 px-4 py-1.5
                           bg-orange-50 border border-orange-200 rounded-full mb-8">
              <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
              <span className="text-xs font-mono font-medium text-orange-600 tracking-wide uppercase">
                Skill Registry v0.1
              </span>
            </div>

            {/* Headline */}
            <h1 className="animate-fade-up stagger-1 text-5xl sm:text-6xl lg:text-7xl
                          font-bold leading-[1.05] tracking-tight">
              Reverse-engineer
              <br />
              <span className="gradient-text">any website</span>
              <br />
              into API skills
            </h1>

            {/* Sub */}
            <p className="animate-fade-up stagger-2 mt-6 text-lg sm:text-xl text-text-secondary
                          max-w-xl leading-relaxed">
              Capture endpoints from live sites, learn their schemas, and replay them
              on demand. Your credentials never leave your machine.
            </p>

            {/* CTAs */}
            <div className="animate-fade-up stagger-3 flex flex-wrap gap-4 mt-10">
              <Link
                href="/search"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-orange-500
                           text-white font-semibold rounded-2xl
                           hover:bg-orange-600 active:scale-[0.98]
                           transition-all orange-glow"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Search Skills
              </Link>
              <Link
                href="/skills"
                className="inline-flex items-center gap-2 px-7 py-3.5
                           border border-border-strong text-text-primary font-semibold rounded-2xl
                           hover:border-orange-300 hover:bg-orange-50
                           active:scale-[0.98] transition-all"
              >
                Browse Registry
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>

          {/* Stats row */}
          <div className="animate-fade-up stagger-4 mt-24 grid grid-cols-3 gap-6 max-w-lg">
            <Stat label="Endpoints" value="API" />
            <Stat label="Auth" value="Local" />
            <Stat label="Search" value="Vector" />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative py-32 bg-surface-sunken border-y border-border">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            How it works
          </h2>
          <p className="text-text-secondary text-lg mb-16 max-w-xl">
            Three steps from URL to reusable API skill.
          </p>

          <div className="grid md:grid-cols-3 gap-8">
            <Step
              n="01"
              title="Capture"
              desc="Point unbrowse at any URL. A headless browser loads the page, records all network traffic, and extracts API endpoints."
            />
            <Step
              n="02"
              title="Learn"
              desc="Endpoints are reverse-engineered into typed skill manifests with schemas, auth profiles, and reliability scores."
            />
            <Step
              n="03"
              title="Execute"
              desc="Search by natural language intent. The best-matching skill is selected and executed with your local credentials."
            />
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section className="py-32">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Built for privacy
          </h2>
          <p className="text-text-secondary text-lg mb-16 max-w-xl">
            Your credentials never leave your machine. Skills are stored and searched in the cloud.
          </p>

          <div className="grid md:grid-cols-2 gap-6">
            <ArchCard
              title="unbrowse backend"
              subtitle="Cloud"
              items={["Skill storage & versioning", "Intent-based search", "Reliability scoring", "Manifest validation"]}
              accent
            />
            <ArchCard
              title="Local agent"
              subtitle="Your machine"
              items={["Browser capture", "Encrypted credential vault", "Cookie & header auth", "Endpoint execution"]}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <div className="w-5 h-5 bg-orange-500 rounded-md flex items-center justify-center">
              <span className="text-white text-[9px] font-mono font-bold">un</span>
            </div>
            unbrowse
          </div>
          <span className="text-text-muted text-sm font-mono">v0.1.0</span>
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-2xl font-bold font-mono gradient-text">{value}</div>
      <div className="text-xs text-text-muted font-mono uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="group relative p-8 bg-surface rounded-2xl border border-border
                    hover:border-orange-300 hover:shadow-lg hover:shadow-glow
                    transition-all duration-300">
      <span className="font-mono text-sm text-orange-400 font-bold">{n}</span>
      <h3 className="text-xl font-bold mt-3 mb-3 group-hover:text-orange-500 transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary text-sm leading-relaxed">{desc}</p>
      <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-orange-500/5 to-transparent
                      rounded-tr-2xl rounded-bl-3xl" />
    </div>
  );
}

function ArchCard({
  title, subtitle, items, accent,
}: { title: string; subtitle: string; items: string[]; accent?: boolean }) {
  return (
    <div className={`relative p-8 rounded-2xl border overflow-hidden
      ${accent
        ? "bg-gradient-to-br from-orange-50 to-surface border-orange-200"
        : "bg-surface border-border"}
    `}>
      {accent && (
        <div className="absolute -top-16 -right-16 w-48 h-48 bg-orange-500/8 rounded-full blur-2xl" />
      )}
      <div className="relative">
        <span className="font-mono text-xs text-text-muted uppercase tracking-wider">{subtitle}</span>
        <h3 className="text-xl font-bold mt-1 mb-6">{title}</h3>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-3 text-sm text-text-secondary">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                ${accent ? "bg-orange-500" : "bg-border-strong"}`} />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
