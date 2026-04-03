import Link from "next/link";
import Image from "next/image";
import { Constellation } from "@/components/constellation";
import { ChatDemo } from "@/components/chat-demo";
import { AcquisitionTracker } from "@/components/acquisition-tracker";
import { InstallInstructions } from "@/components/install-instructions";
import { ThreePanelVisual } from "@/components/three-panel-visual";
import { WorksWith } from "@/components/works-with";
import { RegistryShowcase } from "@/components/registry-showcase";
import { HeroCTA } from "@/components/hero-cta";
import {
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_MCP,
  INSTALL_CMD_SKILL,
  MCP_CONFIG_PATH,
  UPGRADE_CMD_GENERIC,
  UPGRADE_CMD_MCP,
} from "@/lib/install-command";
import { Github, Zap, Coins, Globe, Shield, Activity, ChevronRight, CheckCircle2 } from "lucide-react";

const WHITEPAPER_URL = "https://arxiv.org/abs/2604.00694";
const SHOW_ALL_INSTALL_OPTIONS = true;
const INSTALL_ANSWER = SHOW_ALL_INSTALL_OPTIONS
  ? `Start with ${INSTALL_CMD_GENERIC}. That script installs the CLI, runs setup, and finishes the real first-run flow: ToS acceptance, agent registration plus API-key caching, and wallet detection when present. Set up Crossmint lobster.cash during bootstrap if you want to earn from mined routes: that wallet is synced onto your profile, used for contributor payouts when your routes earn, and used for paid-route spending. After install, hosts with skills support can also use ${INSTALL_CMD_SKILL} for slash-command or host discovery. For generic MCP hosts, run ${INSTALL_CMD_MCP}; that writes a ready-to-import config to ${MCP_CONFIG_PATH}, and the generic template lives at https://www.unbrowse.ai/mcp.json. Upgrade CLI installs with ${UPGRADE_CMD_GENERIC} and MCP installs with ${UPGRADE_CMD_MCP}. For OpenClaw, install the published browser-replacement plugin with npx unbrowse-openclaw install --restart. Older OpenClaw builds may ask once to trust the plugin.`
  : `Start with ${INSTALL_CMD_GENERIC}. Set up Crossmint lobster.cash during install if you want contributor payouts to land in your wallet. After install, hosts with skills support can also use ${INSTALL_CMD_SKILL}. Generic MCP hosts can use ${INSTALL_CMD_MCP}. Upgrade with ${UPGRADE_CMD_GENERIC} or ${UPGRADE_CMD_MCP}. OpenClaw uses the separate unbrowse-openclaw package for strict browser replacement.`;
const DOCS_URL = "https://docs.unbrowse.ai";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How does Unbrowse work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse is a drop-in replacement for browser automation in agent stacks. It can use a real browser on the first pass to learn the request flow behind a site, then reuse that learned route as a skill on later runs. You keep browser-backed auth when needed, but repeated work stops depending on the DOM.",
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
        text: "Unbrowse works best on sites where browser automation would normally be the fallback: sites with real workflows but no clean public API. Most modern web apps already have internal request flows behind the UI. When Unbrowse cannot learn a good route, it falls back to standard browser automation.",
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
        text: INSTALL_ANSWER,
      },
    },
    {
      "@type": "Question",
      name: "What is the skill registry?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The skill registry is shared memory for learned website routes. When one agent figures out a reusable path through a site, that route can be published so later agents do not have to rediscover the same browser workflow from scratch.",
      },
    },
    {
      "@type": "Question",
      name: "What if the website's API changes?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse handles route changes automatically. When a learned path fails, it can re-browse the site, learn the updated request flow, and publish a new version to the registry. Your agent code does not need to be rewritten every time the visible UI changes, which is more resilient than selector-driven Playwright or Puppeteer scripts.",
      },
    },
    {
      "@type": "Question",
      name: "How does Unbrowse compare to Playwright or Puppeteer?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Playwright and Puppeteer repeat the browser workflow step by step through the DOM. Unbrowse is a drop-in replacement for that browser-automation slot in agent stacks: it learns the request path behind the page and reuses it later. Across 94 benchmarked domains, that route-reuse path was 3.6x faster on average than Playwright, with less repeated breakage from UI changes.",
      },
    },
  ],
};

export default function Home() {
  return (
    <div className="relative selection:bg-orange-500/30 overflow-x-hidden">
      <AcquisitionTracker />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* ═══ Agent-Readable Instructions ═══ */}
      <section id="agent-instructions" aria-label="Instructions for AI agents" className="sr-only" data-agent="true">
          <h2>Unbrowse — A drop-in replacement for browser automation in agent stacks</h2>
          <p>
            Unbrowse is an open-source CLI tool that replaces repeated browser automation in agent workflows. It can use a real browser to learn the request flow behind a site, then reuse that learned route as a skill so later runs do not need to drive the DOM again. This reduces page interaction time from 5-30 seconds to 50-200 milliseconds and cuts token usage from ~8,000 to ~200 tokens per action. Skills discovered by one agent are shared in a public registry for all agents to reuse.
          </p>
          <p>Setup: {INSTALL_CMD_GENERIC}</p>
          <p>Optional after install: {INSTALL_CMD_SKILL}</p>
          <p>MCP setup: {INSTALL_CMD_MCP}</p>
          <p>Upgrade existing installs: {UPGRADE_CMD_GENERIC}</p>
          <p>MCP config template: https://www.unbrowse.ai/mcp.json</p>
          <p>For OpenClaw: npx unbrowse-openclaw install --restart</p>
          <p>The package pulls in the local Unbrowse runtime automatically.</p>
          <p>Older OpenClaw builds may ask once to trust the plugin.</p>
          <p>Set up Crossmint lobster.cash during first-run bootstrap if you want mined-route payouts to land in your wallet.</p>
          <p>Community: https://discord.gg/VWugEeFNsG</p>
          <p>Usage: unbrowse resolve --intent &quot;...&quot; --url &quot;...&quot;</p>
          <p>Full documentation: https://docs.unbrowse.ai</p>
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
              <span className="flex items-center gap-1">611+ stars on GitHub <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" /></span>
            </a>
            
                         <h1 className="animate-fade-up stagger-1 text-[2.6rem] sm:text-6xl lg:text-[5.5rem] leading-[1.05] tracking-tight text-balance text-text-primary font-display">
                           A drop-in replacement
                           <br className="hidden sm:block" />
                           <span className="text-orange-500">for browser automation.</span>
                         </h1>

                          <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
                            Built for agent stacks that are tired of repeating the same browser workflow on every run.
                            Unbrowse learns the request path behind the page, so repeat tasks run faster, cheaper, and with less breakage than driving the DOM every time.
                          </p>

            <p className="animate-fade-up stagger-2 mt-4 max-w-3xl text-sm sm:text-base text-text-muted leading-relaxed">
              Same websites. Same permissions. Same browser fallback when needed.
            </p>

            {/* ═══ Trust Bar ═══ */}
            <div className="animate-fade-up stagger-2 mt-6 sm:mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs sm:text-sm text-text-muted font-medium">
              <span>94 domains benchmarked</span>
              <span className="hidden sm:inline text-border-strong">|</span>
              <span>3.6x faster than Playwright on average</span>
              <span className="hidden sm:inline text-border-strong">|</span>
              <a href={WHITEPAPER_URL} target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Peer-reviewed on arXiv with NUS</a>
              <span className="hidden sm:inline text-border-strong">|</span>
              <span className="flex items-center gap-1.5"><Github className="w-3.5 h-3.5" /> 611+ GitHub stars</span>
              <span className="hidden sm:inline text-border-strong">|</span>
              <span>5.4K npm downloads</span>
            </div>

            {/* ═══ What is Unbrowse — Definition Block (moved above install) ═══ */}
            <div className="animate-fade-up stagger-3 mt-10 sm:mt-12 w-full max-w-3xl text-center">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4 text-text-primary">The browser slot stays. The execution path changes.</h2>
              <p className="text-text-secondary text-base sm:text-lg leading-relaxed">
                Unbrowse is a drop-in replacement for browser automation in agent stacks.
                On the first pass it can use a real browser to capture the site&apos;s request flow.
                On later runs it reuses that learned route as a skill.
                The browser stays available for auth and hard cases, but repeated browser work becomes reusable infrastructure instead of repeated cost.
              </p>
            </div>

            <div id="install" className="animate-fade-up stagger-3 mt-10 sm:mt-12 w-full max-w-4xl text-left">
              <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
                <div className="border-b border-border bg-surface-raised px-5 py-4 sm:px-6 sm:py-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-orange-600">Install First</p>
                      <h2 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-text-primary">
                        Install once. Use it on the next task.
                      </h2>
                    </div>
                    <p className="max-w-sm text-sm leading-relaxed text-text-secondary">
                      Local runtime first. Host shortcuts second. MCP and OpenClaw have dedicated tabs when you need them.
                    </p>
                  </div>
                </div>
                <div className="p-4 sm:p-6">
                  <InstallInstructions />
                </div>
                <div className="border-t border-border bg-orange-50 px-5 py-4 sm:px-6 text-sm leading-relaxed text-orange-900">
                  <span className="font-medium">Want payouts?</span>
                  <span className="ml-2">Finish Crossmint lobster.cash setup during bootstrap so mined-route earnings have a wallet destination.</span>
                </div>
                <div className="border-t border-border bg-surface-raised px-5 py-4 sm:px-6 text-sm leading-relaxed text-text-secondary">
                  <span className="font-medium text-text-primary">Already installed?</span>
                  <code className="ml-2 text-orange-700 font-medium">{UPGRADE_CMD_GENERIC}</code>
                </div>
              </div>
            </div>

            {/* CTA — install first, skill second */}
            <div className="animate-fade-up stagger-4 flex flex-col items-center gap-6 mt-10 w-full">
              <div className="text-center">
                <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-600">
                  Replace The Browser
                </p>
                <p className="mt-2 text-sm sm:text-base text-text-secondary">
                  Install the runtime, then replace repeated browser automation with learned routes your agent can reuse.
                </p>
              </div>
              <HeroCTA />
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                <Link
                  href="#demo"
                  className="flex items-center justify-center gap-2 px-6 py-3.5
                             bg-surface border-2 border-orange-500/20 text-text-primary font-medium rounded-lg text-base w-full sm:w-auto
                             hover:border-orange-500/40 hover:bg-orange-50/50
                             active:scale-[0.98] transition-all cursor-pointer"
                >
                  See Demo
                </Link>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-text-muted">
                                <a href={DOCS_URL} target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Docs</a>
                <span className="text-border-strong">·</span>
                <a href="/mcp.json" className="hover:text-text-primary transition-colors">MCP Config</a>
                <span className="text-border-strong">·</span>
                <a href={WHITEPAPER_URL} target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Read Paper</a>
                <span className="text-border-strong">·</span>
                <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">GitHub</a>
              </div>
            </div>

              {/* Supported Agents */}
              <div className="animate-fade-up stagger-5 mt-14 sm:mt-20 pt-8 w-full flex flex-col items-center">
                <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-5">Built for agent stacks</p>
                <div className="flex flex-wrap justify-center items-center gap-5 sm:gap-12 opacity-80 transition-opacity hover:opacity-100">
                  <span className="text-base sm:text-lg font-medium tracking-tight">Claude Code</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">Cursor</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight">OpenClaw</span>
                  <span className="text-base sm:text-lg font-medium tracking-tight flex items-center gap-1.5">Any MCP Host <Zap className="w-4 h-4" /></span>
                </div>
              </div>

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
                When no public API exists, use the one behind the UI.
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
                  <h3 className="text-xl sm:text-2xl font-semibold mb-3 tracking-tight">Stop driving the DOM</h3>
                  <p className="text-text-secondary text-base leading-relaxed max-w-md">
                    Browser automation is slow because it repeats the human path.
                    Unbrowse uses the internal request path the site already depends on.
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
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Return data, not markup</h3>
                <p className="text-text-secondary text-base leading-relaxed mb-8 flex-1">
                    Your agent gets the structured response it needs for the next step,
                    not a pile of rendered HTML that has to be parsed back into data.
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
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Capture once. Reuse later.</h3>
                <p className="text-text-secondary text-base leading-relaxed mb-8 flex-1">
                  Your agent runs <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">unbrowse resolve --intent &quot;...&quot; --url &quot;...&quot;</code>.
                  Unbrowse learns the useful endpoints, then packages them as a reusable skill.
                </p>
                <div className="mt-auto pt-5 border-t border-border space-y-3">
                  <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                    <CheckCircle2 className="w-4 h-4 text-orange-500 shrink-0" /> <span className="truncate">No endpoint mapping by hand</span>
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
                <h3 className="text-xl sm:text-2xl font-semibold mb-3 tracking-tight">Keep browser auth. Lose browser overhead.</h3>
                <p className="text-text-secondary text-base leading-relaxed max-w-md">
                  No cloud proxy in the middle. Unbrowse runs locally and reuses your real browser session,
                  so agents can reach <strong className="text-orange-600 font-medium">auth-protected workflows</strong> without shipping cookies off-box.
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
                  One agent learns Airbnb once. After that, other agents can search listings,
                  check availability, and act through the learned skill instead of replaying the browser flow.
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
                Verify, explore, and <span className="text-orange-500">view contributors.</span>
              </h2>
                <p className="text-text-secondary text-lg max-w-xl mx-auto leading-relaxed">
                  Once the CLI is installed, verify the local server, open the wallet dashboard, and jump into the docs and community.
                </p>
            </div>

          <div className="space-y-8">
            <div className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm leading-relaxed text-text-secondary">
              Verify the install with
              <code className="ml-2 text-orange-700 font-medium">unbrowse health</code>
              and upgrade in place with
              <code className="ml-2 text-orange-700 font-medium">{UPGRADE_CMD_GENERIC}</code>
              or
              <code className="ml-2 text-orange-700 font-medium">{UPGRADE_CMD_MCP}</code>
              after each release.
            </div>

            <div className="rounded-2xl border border-border bg-surface px-6 py-6 sm:px-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">Public contributor view</p>
                  <h3 className="mt-2 text-2xl font-semibold text-text-primary">Open any contributor by wallet.</h3>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
                    Paste a wallet to see earnings, spending, savings, time saved, and leaderboard rank. No login flow on the website.
                  </p>
                </div>
                <Link
                  href="/dashboard"
                  className="inline-flex items-center justify-center rounded-2xl bg-orange-500 px-5 py-3 font-semibold text-white transition-colors hover:bg-orange-600"
                >
                  View by wallet
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-text-secondary font-mono pt-8">
              <a href={DOCS_URL} target="_blank" rel="noopener" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><ChevronRight className="w-4 h-4"/> Docs</a>
              <span className="hidden sm:block text-border-strong">•</span>
              <a href="/skill.md" className="flex items-center gap-1.5 hover:text-text-primary transition-colors"><ChevronRight className="w-4 h-4"/> Agent contract</a>
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
               <p className="text-text-secondary leading-relaxed">Unbrowse is a drop-in replacement for the browser in AI agent workflows. Instead of making the agent drive the DOM step by step, it learns the site&apos;s internal request flow and reuses that path as a skill. You keep browser-backed auth when needed, but most repeat work stops depending on the visible UI.</p>
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
               <p className="text-text-secondary leading-relaxed">Unbrowse works on sites that already use internal APIs to power their UI, which covers most modern web apps. It is especially useful when there is no official API but the site clearly has structured requests behind the frontend. When a site cannot be learned cleanly, Unbrowse falls back to standard browser automation.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">Is Unbrowse secure? Do my credentials leave my machine?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse runs entirely locally. There are no cloud proxies, no man-in-the-middle interception, and your browser cookies never leave your device. Authentication credentials are encrypted with AES-256-CBC in a local vault. Only discovered API endpoint patterns (not data or credentials) are shared with the registry.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">How do I install Unbrowse?</h3>
               <p className="text-text-secondary leading-relaxed">Run <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{INSTALL_CMD_GENERIC}</code> to install the actual runtime and setup flow. After that, hosts with skills support can also use <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{INSTALL_CMD_SKILL}</code> for slash-command or host discovery. Generic MCP hosts can use <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{INSTALL_CMD_MCP}</code>; that path writes a ready config to <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{MCP_CONFIG_PATH}</code>, and a generic template is available at <a href="/mcp.json" className="underline hover:text-text-primary">/mcp.json</a>. Upgrade with <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{UPGRADE_CMD_GENERIC}</code> or <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">{UPGRADE_CMD_MCP}</code>. For OpenClaw, use <code className="text-orange-600 font-medium bg-orange-50 border border-orange-500/20 px-1.5 py-0.5 rounded text-sm">npx unbrowse-openclaw install --restart</code>.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">What is the skill registry?</h3>
               <p className="text-text-secondary leading-relaxed">The skill registry is a shared marketplace of reverse-engineered API skills. When one agent discovers how to interact with a website&apos;s API, that knowledge is published to the registry so every other agent can use it instantly — no need to re-discover the same endpoints.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">What if the website&apos;s API changes?</h3>
               <p className="text-text-secondary leading-relaxed">Unbrowse handles API changes automatically. When a cached skill fails, Unbrowse re-browses the site, re-discovers the updated endpoints, and publishes a new version to the registry. Your agent code doesn&apos;t need to change — the skill layer absorbs the breakage. This is fundamentally more resilient than Playwright or Puppeteer scripts, which break on any DOM change and require manual selector updates.</p>
             </div>
             <div>
               <h3 className="text-lg font-semibold mb-2 text-text-primary">How does Unbrowse compare to Playwright or Puppeteer?</h3>
               <p className="text-text-secondary leading-relaxed">Playwright and Puppeteer automate a browser by clicking through the DOM — they are slow (5-30s per page), fragile (break on any UI change), and expensive (8,000+ tokens per action). Unbrowse reverse-engineers the internal APIs behind the frontend, so your agent makes direct HTTP calls — 3.6x faster on average across 94 benchmarked domains (<a href={WHITEPAPER_URL} target="_blank" rel="noopener" className="text-orange-600 hover:text-orange-700 underline">peer-reviewed, arXiv 2604.00694</a>). When APIs change, Unbrowse re-discovers them automatically. Playwright scripts require manual selector fixes.</p>
             </div>
           </div>
         </div>
       </section>

       {/* ═══ Learn More — Blog & Comparison Links ═══ */}
       <section className="relative py-12 sm:py-16 border-t border-border bg-surface-sunken">
         <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
           <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-8 text-text-primary">Go Deeper</h2>
           <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
             <Link
               href="/blog"
               className="group flex flex-col items-center gap-3 p-6 rounded-2xl border border-border bg-surface hover:border-orange-500/30 transition-colors"
             >
               <span className="text-lg font-semibold text-text-primary group-hover:text-orange-600 transition-colors">Blog</span>
               <span className="text-sm text-text-secondary leading-relaxed">Technical deep-dives, launch notes, and the thinking behind Unbrowse.</span>
               <span className="text-sm font-medium text-orange-600 flex items-center gap-1">Read posts <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" /></span>
             </Link>
             <Link
               href="/compare/playwright"
               className="group flex flex-col items-center gap-3 p-6 rounded-2xl border border-border bg-surface hover:border-orange-500/30 transition-colors"
             >
               <span className="text-lg font-semibold text-text-primary group-hover:text-orange-600 transition-colors">Unbrowse vs Playwright</span>
               <span className="text-sm text-text-secondary leading-relaxed">Side-by-side benchmark: speed, cost, reliability across 94 domains.</span>
               <span className="text-sm font-medium text-orange-600 flex items-center gap-1">See comparison <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" /></span>
             </Link>
             <Link
               href="/mine-the-internet"
               className="group flex flex-col items-center gap-3 p-6 rounded-2xl border border-border bg-surface hover:border-orange-500/30 transition-colors"
             >
               <span className="text-lg font-semibold text-text-primary group-hover:text-orange-600 transition-colors">Mine the Internet</span>
               <span className="text-sm text-text-secondary leading-relaxed">How Unbrowse turns every website visit into a shared API skill.</span>
               <span className="text-sm font-medium text-orange-600 flex items-center gap-1">Learn more <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" /></span>
             </Link>
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
             <span className="text-sm">&copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
             <div className="hidden sm:block w-px h-6 bg-border" />
             <a href="https://www.nvidia.com/en-us/startups/" target="_blank" rel="noopener"
                className="inline-block rounded-lg bg-surface border border-border p-1.5 hover:bg-surface-raised transition-colors">
               <Image src="/nvidia-inception.png" alt="NVIDIA Inception Program" width={80} height={30} className="block opacity-70 hover:opacity-100 transition-opacity" />
             </a>
           </div>
           <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm font-medium">
             <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">GitHub</a>
             <a href="https://discord.gg/VWugEeFNsG" target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Discord</a>
             <a href={DOCS_URL} target="_blank" rel="noopener" className="hover:text-text-primary transition-colors">Docs</a>
             <Link href="/search" className="hover:text-text-primary transition-colors">Registry</Link>
             <Link href="/dashboard" className="hover:text-text-primary transition-colors">View by wallet</Link>
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
