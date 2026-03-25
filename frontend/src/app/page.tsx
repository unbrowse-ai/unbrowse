import Link from "next/link";
import Image from "next/image";
import { Constellation } from "@/components/constellation";
import { ChatDemo } from "@/components/chat-demo";
import { InstallInstructions } from "@/components/install-instructions";
import { ThreePanelVisual } from "@/components/three-panel-visual";
import { WorksWith } from "@/components/works-with";
import { RegistryShowcase } from "@/components/registry-showcase";
import { ArrowRight, Github, Zap, Coins, Globe, Shield, Activity, ChevronRight, CheckCircle2 } from "lucide-react";

const WHITEPAPER_URL = "/internal-apis-are-all-you-need";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How does Unbrowse work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse is a drop-in replacement for browser automation when you want API-native access to the web. It opens a local browser, captures network traffic as you interact with a site, and reverse-engineers the internal API endpoints that power the frontend. Once discovered, these endpoints are stored as reusable skills so your agent can call them directly — no browser required.",
      },
    },
    {
      "@type": "Question",
      name: "How much faster is Unbrowse than headless browser automation?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse is approximately 100x faster per page. Headless browsers typically take 5-30 seconds per page interaction. Unbrowse makes direct API calls in 50-200 milliseconds. It also uses ~200 tokens per action compared to ~8,000 tokens for scraped HTML, a 40x reduction.",
      },
    },
    {
      "@type": "Question",
      name: "Is Unbrowse free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Unbrowse is 100% free and open source under the AGPL-3.0 license. There are no paid tiers, cloud proxies, or usage credits. Everything runs locally on your machine.",
      },
    },
    {
      "@type": "Question",
      name: "What websites does Unbrowse support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse works with any website that uses internal APIs to power its frontend — which includes most modern web applications. Sites like Airbnb, LinkedIn, and hundreds of others have been successfully mapped. When a site cannot be reverse-engineered, Unbrowse falls back to standard browser automation.",
      },
    },
    {
      "@type": "Question",
      name: "Is Unbrowse secure? Do my credentials leave my machine?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse runs entirely locally. There are no cloud proxies, no man-in-the-middle interception, and your browser cookies never leave your device. Authentication credentials are encrypted with AES-256-CBC in a local vault. Only discovered API endpoint patterns (not data or credentials) are shared with the registry.",
      },
    },
    {
      "@type": "Question",
      name: "How do I install Unbrowse?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "For skill-compatible hosts, start with npx skills add unbrowse-ai/unbrowse. If you want the local runtime wired automatically, use the one-shot installer script. If you do not want auto-detect, the manual fallback is npm install -g unbrowse. Cursor, Windsurf, Claude Code, Claude Desktop, Codex, and OpenClaw all have direct wiring paths. OpenClaw, Hermes, and ElizaOS use native browser-replacement integrations rather than simple package installs, so their full setup lives in the docs.",
      },
    },
    {
      "@type": "Question",
      name: "What is the skill registry?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The skill registry is a shared marketplace of reverse-engineered API skills. When one agent discovers how to interact with a website's API, that knowledge is published to the registry so every other agent can use it instantly — no need to re-discover the same endpoints.",
      },
    },
  ],
};

export default function Home() {
  return (
    <div className="relative selection:bg-orange-500/30 overflow-x-hidden">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* ═══ Agent-Readable Instructions ═══ */}
      <section id="agent-instructions" aria-label="Instructions for AI agents" className="sr-only" data-agent="true">
          <h2>Unbrowse — The API layer for AI agents</h2>
          <p>
            Unbrowse is an open-source CLI tool that reverse-engineers the internal APIs behind any website, allowing AI agents to make direct API calls instead of automating headless browsers. It reduces page interaction time from 5-30 seconds to 50-200 milliseconds and cuts token usage from ~8,000 to ~200 tokens per action. Skills discovered by one agent are shared in a public registry for all agents to reuse.
          </p>
          <p>Skill: npx skills add unbrowse-ai/unbrowse</p>
          <p>One-shot: curl -fsSL https://www.unbrowse.ai/install.sh | bash</p>
          <p>Manual fallback: npm install -g unbrowse</p>
          <p>Advanced setup docs: https://www.unbrowse.ai/skill.md</p>
          <p>Supported: Cursor, Windsurf, Claude Code, Claude Desktop, Codex, OpenClaw, MCP, Hermes, ElizaOS, LangChain</p>
          <p>Native browser replacement integrations: OpenClaw, Hermes, ElizaOS</p>
          <p>Community: https://discord.gg/VWugEeFNsG</p>
          <p>Usage: unbrowse resolve --intent &quot;...&quot; --url &quot;...&quot;</p>
          <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
          <p>Whitepaper: {WHITEPAPER_URL}</p>
      </section>

      {/* ═══ Hero ═══ */}
      <section className="relative min-h-[100vh] flex flex-col justify-center overflow-hidden">
          {/* Abstract Background Elements */}
          <div className="absolute inset-0 z-0 bg-[url('/noise.png')] opacity-[0.02] mix-blend-overlay pointer-events-none" />
          
            <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-32 pb-16 sm:pb-20 text-center flex flex-col items-center">
            
            <a 
              href="https://github.com/unbrowse-ai/unbrowse" 
              target="_blank" 
              rel="noopener" 
              className="group animate-fade-up mb-8 inline-flex items-center gap-2 px-3 py-1.5 rounded-full 
                         bg-orange-50 border border-orange-500/20
                         text-orange-600 text-sm font-medium tracking-tight 
                         hover:bg-orange-100 hover:border-orange-500/40 transition-colors cursor-pointer"
            >
              <Github className="w-4 h-4" />
              <span>100% Free & Open Source</span>
              <span className="h-3 w-px bg-orange-500/20 mx-1" />
              <span className="flex items-center gap-1">Star on GitHub <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" /></span>
            </a>
            
                           <h1 className="animate-fade-up stagger-1 text-[2.6rem] sm:text-6xl lg:text-[5.5rem] leading-[1.05] tracking-tight text-balance text-text-primary font-display">
                           100x faster. 95% cheaper.{" "}
                           <br className="hidden sm:block" />
                           <span className="text-orange-500">The API-native browser.</span>
                         </h1>

                          <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
                           A drop-in replacement for browser automation for AI agents.
                           Log in, search, book, and submit through direct API calls instead of driving a flaky browser.
                         </p>

            <div id="install" className="animate-fade-up stagger-3 mt-10 sm:mt-12 w-full max-w-6xl text-left">
              <div className="max-w-3xl">
                <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-orange-600">
                  Install First
                </p>
                <h2 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-text-primary">
                  Install Unbrowse once. Pick the path that matches your host.
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
                  Main paths first. Other integrations behind one disclosure. No stacked install navigation.
                </p>
              </div>

              <div className="mt-6">
                <InstallInstructions />
              </div>
            </div>

            {/* CTA Buttons */}
            <div className="animate-fade-up stagger-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mt-10">
              <Link
                href="#install"
                className="group flex items-center justify-center gap-2 px-6 py-3 bg-orange-500
                           text-white font-medium rounded-lg text-base w-full sm:w-auto
                           hover:bg-orange-600 shadow-[0_0_24px_rgba(255,109,0,0.3)] hover:shadow-[0_0_32px_rgba(255,109,0,0.5)] active:scale-[0.98]
                           transition-all cursor-pointer"
              >
                Get Started <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link
                href="#demo"
                className="flex items-center justify-center gap-2 px-6 py-3
                           bg-surface border-2 border-orange-500/20 text-text-primary font-medium rounded-lg text-base w-full sm:w-auto
                           hover:border-orange-500/40 hover:bg-orange-50/50
                           active:scale-[0.98] transition-all cursor-pointer"
              >
                See Demo
              </Link>
              <a
                href="https://discord.gg/VWugEeFNsG"
                target="_blank"
                rel="noopener"
                className="flex items-center justify-center gap-2 px-6 py-3
                           bg-surface border-2 border-orange-500/20 text-text-primary font-medium rounded-lg text-base w-full sm:w-auto
                           hover:border-orange-500/40 hover:bg-orange-50/50
                           active:scale-[0.98] transition-all cursor-pointer"
              >
                Join Discord
              </a>
              <a
                href={WHITEPAPER_URL}
                target="_blank"
                rel="noopener"
                className="flex items-center justify-center gap-2 px-6 py-3
                           bg-surface border-2 border-orange-500/20 text-text-primary font-medium rounded-lg text-base w-full sm:w-auto
                           hover:border-orange-500/40 hover:bg-orange-50/50
                           active:scale-[0.98] transition-all cursor-pointer"
              >
                Read Whitepaper
              </a>
            </div>

              {/* Supported Agents */}
              <div className="animate-fade-up stagger-5 mt-14 sm:mt-20 pt-8 w-full flex flex-col items-center">
                <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-5">Works seamlessly with</p>
                <div className="flex flex-wrap justify-center items-center gap-5 sm:gap-12 opacity-80 transition-opacity hover:opacity-100">
                  <span className="text-base sm:text-lg font-medium tracking-tight">Claude Code</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">Cursor</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">OpenClaw</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">Hermes</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">ElizaOS</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">MCP</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight flex items-center gap-1.5">Any Skill <Zap className="w-4 h-4" /></span>
                </div>
              </div>

          </div>
      </section>

       {/* ═══ What is Unbrowse — Definition Block ═══ */}
       <section className="relative py-12 sm:py-16 bg-surface-sunken border-t border-border">
         <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
           <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-6 text-text-primary">What is Unbrowse?</h2>
           <p className="text-text-secondary text-base sm:text-lg leading-relaxed">
             Unbrowse is an open-source drop-in replacement for browser automation when you want API-native access to the web. It reverse-engineers the internal APIs behind any website so AI agents can make direct API calls instead of driving headless browsers. It reduces page interaction time from 5–30 seconds to 50–200 milliseconds and cuts token usage from ~8,000 to ~200 tokens per action. Skills discovered by one agent are shared in a public registry for all agents to reuse.
           </p>
         </div>
       </section>

       {/* ═══ 3-Panel Visual — THE showstopper ═══ */}
       <ThreePanelVisual />

       {/* ═══ Value Props — Bento Grid ═══ */}
       <section id="how-it-works" className="relative py-16 sm:py-24 bg-surface">
         <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-10 sm:mb-16">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-xs font-mono font-medium uppercase tracking-widest mb-6">
                <Zap className="w-3.5 h-3.5" />
                After You Install
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 text-balance text-text-primary">
                Bypass the DOM completely.
              </h2>
            </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            
              {/* Speed - Spans 2 cols on lg & md */}
              <div className="group relative p-6 sm:p-8 rounded-2xl border border-border bg-surface-sunken overflow-hidden md:col-span-2 transition-colors hover:border-orange-500/30 flex flex-col md:flex-row gap-8 items-start md:items-center">
                <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.08] group-hover:text-orange-500 transition-all duration-500 pointer-events-none">
                  <Zap className="w-40 h-40" />
                </div>
                <div className="relative z-10 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-500/20 flex items-center justify-center mb-6">
                    <Zap className="w-5 h-5 text-orange-500" />
                  </div>
                  <h3 className="text-xl sm:text-2xl font-semibold mb-3 tracking-tight">Skip the rendering engine</h3>
                  <p className="text-text-secondary text-base leading-relaxed max-w-md">
                    Headless browsers are slow and flaky. Unbrowse taps directly into the hidden internal APIs that power the frontend, returning data instantly.
                  </p>
                </div>
                <div className="relative z-10 w-full md:w-auto md:flex-1 bg-surface border border-border rounded-xl p-6 sm:p-8 flex flex-col items-center justify-center shadow-sm">
                  <div className="flex items-end gap-2 mb-1">
                    <span className="text-5xl sm:text-6xl font-bold font-mono text-orange-500 tracking-tighter">100x</span>
                  </div>
                  <span className="text-xs sm:text-sm font-medium text-text-muted uppercase tracking-wider mb-6">faster per page</span>
                  <div className="flex flex-wrap items-center justify-center gap-3 text-xs sm:text-sm font-mono bg-surface-sunken border border-border px-4 py-2 rounded-md w-full">
                    <span className="text-text-muted line-through">5-30s headless</span>
                    <span className="text-border-strong">→</span>
                    <span className="text-orange-500 font-medium">50-200ms API</span>
                  </div>
                </div>
              </div>

              {/* Cost - Spans 1 col */}
              <div className="group relative p-6 sm:p-8 rounded-2xl border border-border bg-surface-sunken transition-all overflow-hidden hover:border-orange-500/30 flex flex-col h-full">
                <div className="absolute -right-4 -bottom-4 opacity-[0.03] group-hover:opacity-[0.08] group-hover:text-orange-500 transition-all duration-500 pointer-events-none">
                  <Coins className="w-40 h-40" />
                </div>
                <div className="relative z-10 flex flex-col h-full">
                  <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-500/20 flex items-center justify-center mb-6">
                    <Coins className="w-5 h-5 text-orange-500" />
                  </div>
                  <h3 className="text-xl font-semibold mb-3 tracking-tight">40x fewer tokens</h3>
                  <p className="text-text-secondary text-base leading-relaxed mb-8 flex-1">
                    Why burn context on 8,000 tokens of HTML? Your agent gets the exact JSON data it needs to take the next action — nothing else.
                  </p>
                  <div className="bg-surface border border-border rounded-xl p-4 sm:p-5 shadow-sm mt-auto">
                    <div className="flex justify-between items-center text-xs sm:text-sm font-mono mb-3">
                      <span className="text-text-muted">Scraping HTML</span>
                      <span className="text-text-muted">~8,000t</span>
                    </div>
                    <div className="flex justify-between items-center text-xs sm:text-sm font-mono">
                      <span className="text-text-primary font-medium">Direct API</span>
                      <span className="text-orange-500 font-medium">~200t</span>
                    </div>
                  </div>
                </div>
              </div>

            {/* Reverse Engineer - Spans 1 col */}
            <div className="group relative p-6 sm:p-8 rounded-2xl border border-border bg-surface-sunken transition-all overflow-hidden hover:border-orange-500/30 flex flex-col h-full">
              <div className="absolute top-0 right-0 p-6 opacity-[0.03] group-hover:opacity-[0.08] group-hover:text-orange-500 transition-all duration-500 pointer-events-none">
                <Globe className="w-32 h-32" />
              </div>
              <div className="relative z-10 flex flex-col h-full">
                <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-500/20 flex items-center justify-center mb-6">
                  <Globe className="w-5 h-5 text-orange-500" />
                </div>
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Auto-discovers APIs</h3>
                <p className="text-text-secondary text-base leading-relaxed mb-8 flex-1">
                  Your agent types <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">unbrowse resolve --intent &quot;...&quot; --url &quot;...&quot;</code>. We instantly map the site's undocumented endpoints for immediate use.
                </p>
                <div className="mt-auto pt-5 border-t border-border space-y-3">
                  <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                    <CheckCircle2 className="w-4 h-4 text-orange-500 shrink-0" /> <span className="truncate">Zero config needed</span>
                  </div>
                  <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                    <CheckCircle2 className="w-4 h-4 text-orange-500 shrink-0" /> <span className="truncate">Shared skill registry</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Security - Spans 2 cols on lg & md */}
            <div className="group relative p-6 sm:p-8 rounded-2xl border border-border bg-surface-sunken transition-all overflow-hidden md:col-span-2 hover:border-orange-500/30 flex flex-col md:flex-row gap-8 items-start md:items-center">
              <div className="absolute right-0 bottom-0 p-8 opacity-[0.03] group-hover:opacity-[0.08] group-hover:text-orange-500 transition-all duration-500 pointer-events-none">
                <Shield className="w-48 h-48" />
              </div>
              <div className="relative z-10 flex-1">
                <div className="w-10 h-10 rounded-xl bg-orange-50 border border-orange-500/20 flex items-center justify-center mb-6">
                  <Shield className="w-5 h-5 text-orange-500" />
                </div>
                <h3 className="text-xl sm:text-2xl font-semibold mb-3 tracking-tight">Integrate with anything. Behind auth.</h3>
                <p className="text-text-secondary text-base leading-relaxed max-w-md">
                  No cloud proxies, no expensive credits. Unbrowse runs locally, leveraging your actual browser sessions to securely access <strong className="text-orange-600 font-medium">auth-protected content</strong>.
                </p>
              </div>
              <div className="relative z-10 w-full md:w-auto md:flex-1 bg-surface border border-border rounded-xl p-5 sm:p-6 font-mono text-xs sm:text-sm shadow-sm">
                <div className="flex items-center justify-between mb-4 text-text-muted text-[10px] sm:text-xs uppercase tracking-wider border-b border-border pb-3">
                  <span>Security Check</span>
                  <span className="text-orange-500 font-medium flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> Passed</span>
                </div>
                <div className="space-y-3.5">
                  <div className="flex justify-between items-center gap-4"><span className="text-text-secondary truncate">Proxy Server</span> <span className="text-text-primary px-2 py-0.5 bg-surface-sunken rounded border border-border shrink-0">None</span></div>
                  <div className="flex justify-between items-center gap-4"><span className="text-text-secondary truncate">MITM</span> <span className="text-text-primary px-2 py-0.5 bg-surface-sunken rounded border border-border shrink-0">Disabled</span></div>
                  <div className="flex justify-between items-center gap-4"><span className="text-text-secondary truncate">Cookies leave device</span> <span className="text-text-primary px-2 py-0.5 bg-surface-sunken rounded border border-border shrink-0">False</span></div>
                  <div className="flex justify-between items-center gap-4"><span className="text-text-secondary truncate">Execution</span> <span className="text-orange-600 font-medium px-2 py-0.5 bg-orange-50 border border-orange-500/20 rounded shrink-0">Local Only</span></div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

       {/* ═══ Registry Showcase ═══ */}
       <RegistryShowcase />

       {/* ═══ Works With ═══ */}
       <WorksWith />

       {/* ═══ Chat Demo ═══ */}
       <section id="demo" className="relative py-16 sm:py-24 border-t border-border overflow-hidden bg-surface">
           <div className="relative max-w-7xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-16">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-xs font-mono font-medium uppercase tracking-widest mb-6">
                <Activity className="w-3.5 h-3.5" />
                See It In Action
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-6 text-balance text-text-primary">
                Example: <span className="text-orange-500">airbnb.com</span>
              </h2>
                <p className="text-text-secondary text-lg max-w-2xl mx-auto leading-relaxed text-balance">
                  One agent browses Airbnb. Every agent on the network
                  can now search listings, check availability, and book — instantly, no browser.
                </p>
            </div>

          <ChatDemo />
        </div>
      </section>

       {/* ═══ Post-Install ═══ */}
       <section className="relative py-16 sm:py-24 border-t border-border bg-surface-sunken">
         <div className="relative max-w-4xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-16">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-xs font-mono font-medium uppercase tracking-widest mb-6">
                <Activity className="w-3.5 h-3.5" />
                After Install
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 mb-6 text-text-primary">
                Install once. <span className="text-orange-500">Then use the docs.</span>
              </h2>
                <p className="text-text-secondary text-lg max-w-xl mx-auto leading-relaxed">
                  Keep the finish clean: docs, registry, GitHub, community. No API-key box on the homepage.
                </p>
            </div>

          <div className="space-y-8">
            <div className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm leading-relaxed text-text-secondary">
              The packaged CLI checks npm before each command and rolls forward automatically when a newer release exists. Disable with
              <code className="mx-2 text-orange-700 font-medium">UNBROWSE_DISABLE_AUTO_UPDATE=1</code>.
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-text-secondary font-mono pt-8">
              <a href="/skill.md" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><ChevronRight className="w-4 h-4"/> skill.md</a>
              <span className="hidden sm:block text-border-strong">•</span>
              <a href="/llms.txt" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><ChevronRight className="w-4 h-4"/> llms.txt</a>
              <span className="hidden sm:block text-border-strong">•</span>
              <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><Github className="w-4 h-4"/> GitHub</a>
              <span className="hidden sm:block text-border-strong">•</span>
              <a href="https://discord.gg/VWugEeFNsG" target="_blank" rel="noopener" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><ChevronRight className="w-4 h-4"/> Discord</a>
            </div>
          </div>
        </div>
       </section>

       {/* ═══ FAQ ═══ */}
       <section id="faq" className="relative py-16 sm:py-24 border-t border-border bg-surface">
         <div className="max-w-3xl mx-auto px-4 sm:px-6">
           <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-12 text-center text-text-primary">Frequently Asked Questions</h2>
           <div className="space-y-8">
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">How does Unbrowse work?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse is a drop-in replacement for browser automation when you want API-native access to the web. It opens a local browser, captures network traffic as you interact with a site, and reverse-engineers the internal API endpoints that power the frontend. Once discovered, these endpoints are stored as reusable skills so your agent can call them directly — no browser required.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">How much faster is Unbrowse than headless browser automation?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse is approximately 100x faster per page. Headless browsers typically take 5–30 seconds per page interaction. Unbrowse makes direct API calls in 50–200 milliseconds. It also uses ~200 tokens per action compared to ~8,000 tokens for scraped HTML, a 40x reduction.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">Is Unbrowse free?</h3>
               <p className="text-text-secondary leading-relaxed">Yes. Unbrowse is 100% free and open source under the AGPL-3.0 license. There are no paid tiers, cloud proxies, or usage credits. Everything runs locally on your machine.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">What websites does Unbrowse support?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse works with any website that uses internal APIs to power its frontend — which includes most modern web applications. Sites like Airbnb, LinkedIn, and hundreds of others have been successfully mapped. When a site cannot be reverse-engineered, Unbrowse falls back to standard browser automation.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">Is Unbrowse secure? Do my credentials leave my machine?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse runs entirely locally. There are no cloud proxies, no man-in-the-middle interception, and your browser cookies never leave your device. Authentication credentials are encrypted with AES-256-CBC in a local vault. Only discovered API endpoint patterns (not data or credentials) are shared with the registry.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">How do I install Unbrowse?</h3>
               <p className="text-text-secondary leading-relaxed">Fastest path: run <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">curl -fsSL https://www.unbrowse.ai/install.sh | bash</code>. That installs Unbrowse and wires detected hosts automatically. If you do not want auto-detect, the fallback is just <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">npm install -g unbrowse</code>. Cursor, Windsurf, Claude Code, Claude Desktop, Codex, OpenClaw, MCP, Hermes, ElizaOS, and LangChain are supported. OpenClaw, Hermes, and ElizaOS use native browser-replacement integrations, so their full setup details live in <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">/skill.md</code> instead of cluttering the homepage.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">What is the skill registry?</h3>
               <p className="text-text-secondary leading-relaxed">The skill registry is a shared marketplace of reverse-engineered API skills. When one agent discovers how to interact with a website&apos;s API, that knowledge is published to the registry so every other agent can use it instantly — no need to re-discover the same endpoints.</p>
             </div>
           </div>
         </div>
       </section>

       {/* ═══ Footer ═══ */}
       <footer className="border-t border-border bg-surface py-10 text-text-secondary">
         <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-6">
           <div className="flex flex-col sm:flex-row items-center gap-4">
             <div className="flex items-center gap-3">
               <Image src="/logo.png" alt="unbrowse" width={24} height={24} unoptimized className="rounded-md" />
               <span className="font-semibold text-text-primary text-base tracking-tight">unbrowse</span>
             </div>
             <div className="hidden sm:block w-px h-6 bg-border" />
             <span className="text-sm">&copy; {new Date().getFullYear()} Unreel AI Pte Ltd</span>
             <div className="hidden sm:block w-px h-6 bg-border" />
             <a href="https://www.nvidia.com/en-us/startups/" target="_blank" rel="noopener"
                className="inline-block rounded-lg bg-surface border border-border p-1.5 hover:bg-surface-raised transition-colors">
               <Image src="/nvidia-inception.png" alt="NVIDIA Inception Program" width={80} height={30} className="block opacity-70 hover:opacity-100 transition-opacity" />
             </a>
           </div>
           <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm font-medium">
             <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">GitHub</a>
             <a href="https://discord.gg/VWugEeFNsG" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Discord</a>
             <Link href="/search" className="hover:text-text-primary transition-colors">Registry</Link>
             <Link href="/dashboard" className="hover:text-text-primary transition-colors">Dashboard</Link>
             <Link href="/terms" className="hover:text-text-primary transition-colors">Terms</Link>
             <Link href="/privacy" className="hover:text-text-primary transition-colors">Privacy</Link>
             <a href="https://x.com/getFoundry" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors flex items-center gap-1.5">
               <svg viewBox="0 0 24 24" className="w-4 h-4 fill-currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
               getFoundry
             </a>
           </div>
         </div>
       </footer>
    </div>
  );
}
