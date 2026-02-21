import Link from "next/link";
import Image from "next/image";
import { Constellation } from "@/components/constellation";
import { ChatDemo } from "@/components/chat-demo";

export default function Home() {
  return (
    <div className="relative">
      {/* ═══ Hero ═══ */}
      <section className="relative min-h-[92vh] flex items-center overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Constellation />
        </div>
        <div className="absolute inset-0 grid-pattern opacity-20 z-[1]" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/4 w-[1000px] h-[800px]
                        bg-gradient-radial from-orange-500/10 via-orange-500/3 to-transparent
                        rounded-full blur-3xl z-[1]" />
        <div className="absolute top-28 right-[12%] w-72 h-72 border border-orange-500/10 rounded-3xl
                        rotate-12 z-[1] animate-[spin_120s_linear_infinite]" />
        <div className="absolute bottom-24 left-[8%] w-56 h-56 border border-orange-400/8 rounded-2xl
                        -rotate-6 z-[1] animate-[spin_90s_linear_infinite_reverse]" />

        <div className="relative z-10 max-w-7xl mx-auto px-6 pt-32 pb-20">
          <div className="max-w-3xl">
            <div className="animate-fade-up inline-flex items-center gap-2 px-4 py-1.5
                           bg-orange-500/10 border border-orange-500/20 rounded-full mb-8">
              <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
              <span className="text-xs font-mono font-medium text-orange-500 tracking-wide uppercase">
                Public Beta
              </span>
            </div>

            <h1 className="animate-fade-up stagger-1 text-5xl sm:text-6xl lg:text-7xl
                          font-bold leading-[1.05] tracking-tight">
              One agent browses.
              <br />
              <span className="gradient-text">Every agent</span> knows.
            </h1>

            <p className="animate-fade-up stagger-2 mt-6 text-lg sm:text-xl text-text-secondary
                          max-w-xl leading-relaxed">
              Every website runs on hidden APIs. When one agent discovers an endpoint,
              it becomes a skill every other agent can replay.{" "}
              <strong className="text-text-primary">No scrapers. No browser automation. Just the actual API calls.</strong>
            </p>

            <div className="animate-fade-up stagger-3 mt-8 inline-flex items-center gap-3
                           bg-surface-raised border border-border rounded-xl px-5 py-3
                           font-mono text-sm text-text-secondary">
              <span className="text-text-muted select-none">$</span>
              <code>npx skills add https://github.com/getfoundry/unbrowse --skill unbrowse</code>
            </div>

            <div className="animate-fade-up stagger-4 flex flex-wrap gap-4 mt-8">
              <Link
                href="/search"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-orange-500
                           text-white font-semibold rounded-2xl
                           hover:bg-orange-600 active:scale-[0.98]
                           transition-all orange-glow cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Search the Registry
              </Link>
              <Link
                href="#demo"
                className="inline-flex items-center gap-2 px-7 py-3.5
                           border border-border-strong text-text-primary font-semibold rounded-2xl
                           hover:border-orange-400 hover:bg-orange-500/5
                           active:scale-[0.98] transition-all cursor-pointer"
              >
                See It In Action
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ Chat Demo: jup.ag ═══ */}
      <section id="demo" className="relative py-24 border-y border-border">
        {/* Subtle constellation bleeds into this section */}
        <div className="absolute inset-0 bg-gradient-radial from-orange-500/3 via-transparent to-transparent opacity-50" />
        <div className="relative max-w-7xl mx-auto px-6">
          <div className="text-center mb-12">
            <span className="text-xs font-mono text-orange-500 uppercase tracking-widest">See It In Action</span>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-4">
              Example: <span className="gradient-text">airbnb.com</span>
            </h2>
            <p className="text-text-secondary text-lg max-w-lg mx-auto leading-relaxed">
              One agent browses Airbnb. Every agent on the network
              can now search listings, check availability, and fetch prices.
            </p>
          </div>

          <ChatDemo />

          <p className="text-center text-text-muted text-sm mt-8 font-mono">
            Works with Claude Code, Cursor, OpenClaw, or any skill-compatible agent
          </p>
        </div>
      </section>

      {/* ═══ How It Works ═══ */}
      <section id="how-it-works" className="relative py-28">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Browse. Learn. Replay.
          </h2>
          <p className="text-text-secondary text-lg mb-14 max-w-lg leading-relaxed">
            No scraper to write. No automation to maintain. No API docs to read.
          </p>

          <div className="grid md:grid-cols-3 gap-5">
            <Step
              n="01"
              title="Browse"
              desc="An agent opens any site in a headless browser. Unbrowse captures every API call — the same endpoints the site's own frontend uses."
              icon={<EyeIcon />}
            />
            <Step
              n="02"
              title="Learn"
              desc="Each endpoint automatically becomes a typed, versioned skill with request schemas and auth patterns. Instantly indexed for every agent."
              icon={<SparkleIcon />}
            />
            <Step
              n="03"
              title="Replay"
              desc="Any agent searches by intent. Found a match? Execute the API directly — no browser. No match? Browse to discover it, and now every agent has it."
              icon={<BoltIcon />}
              featured
            />
          </div>
        </div>
      </section>

      {/* ═══ Architecture ═══ */}
      <section className="py-24 border-y border-border">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Skills are collective. Credentials are not.
          </h2>
          <p className="text-text-secondary text-lg mb-12 max-w-lg leading-relaxed">
            The index is shared across every agent. Your auth never leaves your machine.
          </p>

          <div className="grid md:grid-cols-2 gap-5">
            <ArchCard
              title="Shared index"
              subtitle="Cloud"
              items={[
                "Collective skill library",
                "Semantic intent search",
                "Community reliability scores",
                "Typed schema validation",
              ]}
              accent
            />
            <ArchCard
              title="Your machine"
              subtitle="Local"
              items={[
                "Headless browser capture",
                "Encrypted credential vault",
                "Cookie, header & token auth",
                "Local-only execution",
              ]}
            />
          </div>
        </div>
      </section>

      {/* ═══ Final CTA ═══ */}
      <section className="relative py-28 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <Constellation />
        </div>
        <div className="absolute inset-0 bg-gradient-radial from-orange-500/6 via-transparent to-transparent z-[1]" />
        <div className="relative z-10 max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-tight mb-6">
            Every website already has an API.
            <br />
            <span className="gradient-text">Your agent just didn&apos;t know about it.</span>
          </h2>
          <div className="flex flex-wrap gap-4 justify-center mt-10">
            <Link
              href="/search"
              className="inline-flex items-center gap-2 px-8 py-4 bg-orange-500
                         text-white font-bold rounded-2xl text-lg
                         hover:bg-orange-600 active:scale-[0.98]
                         transition-all orange-glow cursor-pointer"
            >
              Search the Registry
            </Link>
            <a
              href="https://github.com/anthropics/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 px-8 py-4
                         border border-border-strong text-text-primary font-bold rounded-2xl text-lg
                         hover:border-orange-400 hover:bg-orange-500/5
                         active:scale-[0.98] transition-all cursor-pointer"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ═══ Footer ═══ */}
      <footer className="border-t border-border py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-text-muted text-sm">
            <Image src="/logo.png" alt="unbrowse" width={20} height={20} />
            <span className="font-semibold text-text-secondary">unbrowse</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-text-muted">
            <a href="https://github.com/anthropics/unbrowse" target="_blank" rel="noopener" className="hover:text-orange-500 transition-colors">GitHub</a>
            <Link href="/search" className="hover:text-orange-500 transition-colors">Registry</Link>
            <Link href="/privacy" className="hover:text-orange-500 transition-colors">Privacy</Link>
            <a href="https://x.com/getFoundry" target="_blank" rel="noopener" className="hover:text-orange-500 transition-colors">@getFoundry</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ═══ Components ═══ */

function Step({ n, title, desc, icon, featured }: {
  n: string; title: string; desc: string; icon: React.ReactNode; featured?: boolean;
}) {
  return (
    <div className={`group relative p-7 rounded-2xl border transition-all duration-300 cursor-pointer
      ${featured
        ? "bg-gradient-to-br from-orange-500/8 to-surface border-orange-500/25 shadow-lg shadow-glow"
        : "bg-surface border-border hover:border-orange-300 hover:shadow-lg hover:shadow-glow"
      }`}
    >
      <div className="flex items-center justify-between mb-5">
        <span className="font-mono text-xs text-orange-500/70 font-bold">{n}</span>
        <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-500">
          {icon}
        </div>
      </div>
      <h3 className={`text-lg font-bold mb-2 transition-colors
        ${featured ? "text-orange-500" : "group-hover:text-orange-500"}`}>
        {title}
      </h3>
      <p className="text-text-secondary text-sm leading-relaxed">{desc}</p>
    </div>
  );
}

function ArchCard({ title, subtitle, items, accent }: {
  title: string; subtitle: string; items: string[]; accent?: boolean;
}) {
  return (
    <div className={`relative p-7 rounded-2xl border overflow-hidden
      ${accent
        ? "bg-gradient-to-br from-orange-500/5 to-surface border-orange-500/20"
        : "bg-surface border-border"}
    `}>
      {accent && (
        <div className="absolute -top-16 -right-16 w-48 h-48 bg-orange-500/5 rounded-full blur-2xl" />
      )}
      <div className="relative">
        <span className="font-mono text-[11px] text-text-muted uppercase tracking-wider">{subtitle}</span>
        <h3 className="text-lg font-bold mt-1 mb-5">{title}</h3>
        <ul className="space-y-2.5">
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

/* ═══ Icons ═══ */

function EyeIcon() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}
