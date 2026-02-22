import Link from "next/link";
import Image from "next/image";
import { Constellation } from "@/components/constellation";
import { ChatDemo } from "@/components/chat-demo";
import { StatsStrip } from "@/components/stats-strip";
import { ApiKeyGenerator } from "@/components/api-key-generator";
import { InstallInstructions } from "@/components/install-instructions";

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

            <div className="animate-fade-up stagger-3 flex flex-wrap gap-4 mt-8">
              <Link
                href="#get-started"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-orange-500
                           text-white font-semibold rounded-2xl
                           hover:bg-orange-600 active:scale-[0.98]
                           transition-all orange-glow cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
                Get Your API Key
              </Link>
              <Link
                href="/search"
                className="inline-flex items-center gap-2 px-7 py-3.5
                           border border-border-strong text-text-primary font-semibold rounded-2xl
                           hover:border-orange-400 hover:bg-orange-500/5
                           active:scale-[0.98] transition-all cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Search the Registry
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ Get Started: Agent Onboarding ═══ */}
      <section id="get-started" className="relative py-24 border-y border-border">
        <div className="absolute inset-0 bg-gradient-radial from-orange-500/3 via-transparent to-transparent opacity-50" />
        <div className="relative max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <span className="text-xs font-mono text-orange-500 uppercase tracking-widest">For Agents</span>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-4">
              Register your agent. <span className="gradient-text">Start discovering.</span>
            </h2>
            <p className="text-text-secondary text-lg max-w-lg mx-auto leading-relaxed">
              Call the registration endpoint to get an API key. Every skill your agent discovers
              gets credited to your account.
            </p>
          </div>

          <div className="space-y-6">
            {/* API registration docs */}
            <div className="p-5 rounded-2xl border border-border bg-surface">
              <div className="flex items-center gap-2 mb-4">
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-500 text-xs font-mono font-bold">POST</span>
                <code className="text-sm font-mono text-text-primary">/v1/agents/register</code>
                <span className="text-xs text-text-muted ml-auto">No auth required</span>
              </div>
              <pre className="text-sm font-mono text-text-secondary bg-surface-raised rounded-xl p-4 overflow-x-auto">{`curl -X POST https://beta-api.unbrowse.ai/v1/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent"}'

# Response:
# { "agent_id": "abc123", "api_key": "ubr_..." }`}</pre>
            </div>

            {/* Interactive key generator */}
            <ApiKeyGenerator />

            {/* Install instructions */}
            <InstallInstructions />

            <p className="text-center text-text-muted text-sm font-mono">
              Agents earn credit for every new skill they discover. View contributions at /dashboard.
            </p>
          </div>
        </div>
      </section>

      {/* ═══ Chat Demo: airbnb.com ═══ */}
      <section id="demo" className="relative py-24 border-b border-border">
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

      {/* ═══ Live Stats ═══ */}
      <section className="py-14 border-b border-border">
        <div className="max-w-5xl mx-auto px-6">
          <StatsStrip />
        </div>
      </section>

      {/* ═══ Save Money, Save Time, Make More Money ═══ */}
      <section id="how-it-works" className="relative py-28">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid lg:grid-cols-3 gap-5">

            {/* Save Money */}
            <div className="group relative p-7 rounded-2xl border border-border bg-surface hover:border-orange-300 transition-all">
              <div className="font-mono text-xs text-orange-500/70 font-bold mb-5">01</div>
              <h3 className="text-xl font-bold mb-3">Slash your AI costs</h3>
              <p className="text-text-secondary text-sm leading-relaxed mb-6">
                Browser automation feeds entire pages of HTML to your LLM. Unbrowse
                feeds it a clean JSON response. Same data, fraction of the tokens.
              </p>
              <div className="flex items-baseline gap-3 pt-5 border-t border-border">
                <span className="text-3xl font-bold font-mono gradient-text">40x</span>
                <span className="text-sm text-text-muted">fewer tokens per action</span>
              </div>
              <div className="mt-3 text-xs text-text-muted leading-relaxed">
                <span className="text-red-400/80 line-through">~8,000 tokens</span> parsing DOM
                <span className="mx-1.5 text-text-muted">&rarr;</span>
                <span className="text-emerald-400">~200 tokens</span> structured JSON
              </div>
            </div>

            {/* Save Time */}
            <div className="group relative p-7 rounded-2xl border border-orange-500/25 bg-gradient-to-br from-orange-500/5 to-surface shadow-lg shadow-glow">
              <div className="font-mono text-xs text-orange-500/70 font-bold mb-5">02</div>
              <h3 className="text-xl font-bold text-orange-500 mb-3">Ship agents 100x faster</h3>
              <p className="text-text-secondary text-sm leading-relaxed mb-6">
                A headless browser takes 5-30 seconds per page. A direct API call takes
                50-200ms. Your agents stop waiting and start doing.
              </p>
              <div className="flex items-baseline gap-3 pt-5 border-t border-orange-500/15">
                <span className="text-3xl font-bold font-mono gradient-text">100x</span>
                <span className="text-sm text-text-muted">faster execution</span>
              </div>
              <div className="mt-3 text-xs text-text-muted leading-relaxed">
                <span className="text-red-400/80 line-through">5-30s</span> browser render
                <span className="mx-1.5 text-text-muted">&rarr;</span>
                <span className="text-emerald-400">50-200ms</span> API call
              </div>
            </div>

            {/* Make More Money */}
            <div className="group relative p-7 rounded-2xl border border-border bg-surface hover:border-orange-300 transition-all">
              <div className="font-mono text-xs text-orange-500/70 font-bold mb-5">03</div>
              <h3 className="text-xl font-bold mb-3">Build what wasn&apos;t possible</h3>
              <p className="text-text-secondary text-sm leading-relaxed mb-6">
                When your agent can call any website&apos;s API in milliseconds, you can build
                products that orchestrate dozens of services in a single workflow.
              </p>
              <div className="flex items-baseline gap-3 pt-5 border-t border-border">
                <span className="text-3xl font-bold font-mono gradient-text">Any</span>
                <span className="text-sm text-text-muted">website becomes an API</span>
              </div>
              <div className="mt-3 text-xs text-text-muted leading-relaxed">
                No API docs needed. No partnerships.
                <br />
                If a site has a frontend, you have its API.
              </div>
            </div>

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
              href="#get-started"
              className="inline-flex items-center gap-2 px-8 py-4 bg-orange-500
                         text-white font-bold rounded-2xl text-lg
                         hover:bg-orange-600 active:scale-[0.98]
                         transition-all orange-glow cursor-pointer"
            >
              Get Your API Key
            </Link>
            <a
              href="https://github.com/getfoundry/unbrowse"
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
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5 text-text-muted text-sm">
              <Image src="/logo.png" alt="unbrowse" width={20} height={20} />
              <span className="font-semibold text-text-secondary">unbrowse</span>
            </div>
            <div className="w-px h-5 bg-border" />
            <a href="https://www.nvidia.com/en-us/startups/" target="_blank" rel="noopener"
               className="inline-block rounded-md bg-white px-2 py-1 hover:opacity-80 transition-opacity">
              <Image
                src="/nvidia-inception.png"
                alt="NVIDIA Inception Program"
                width={88}
                height={34}
                className="block"
              />
            </a>
          </div>
          <div className="flex items-center gap-6 text-sm text-text-muted">
            <a href="https://github.com/getfoundry/unbrowse" target="_blank" rel="noopener" className="hover:text-orange-500 transition-colors">GitHub</a>
            <Link href="/search" className="hover:text-orange-500 transition-colors">Registry</Link>
            <Link href="/dashboard" className="hover:text-orange-500 transition-colors">Dashboard</Link>
            <Link href="/privacy" className="hover:text-orange-500 transition-colors">Privacy</Link>
            <a href="https://x.com/getFoundry" target="_blank" rel="noopener" className="hover:text-orange-500 transition-colors">@getFoundry</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
