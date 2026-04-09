import Link from "next/link";
import Image from "next/image";
import { ChatDemo } from "@/components/chat-demo";
import { InstallInstructions } from "@/components/install-instructions";
import { ThreePanelVisual } from "@/components/three-panel-visual";
import { RegistryShowcase } from "@/components/registry-showcase";
import { ScrollToButton } from "@/components/full-page-scroll";
import { FlowingDotField } from "@/components/flowing-dot-field";
import { HeroHands } from "@/components/hero-hands";
import { InstallFigure } from "@/components/install-figure";
import { DemoParallax } from "@/components/demo-parallax";
import { MobileNav } from "@/components/mobile-nav";
import { Github } from "lucide-react";
import {
  IconHourglass,
  IconCompass,
  IconSeal,
  IconScript,
  IconDiamondCheck,
  IconArrow,
  IconChevron,
} from "@/components/archival-icons";

const WHITEPAPER_URL = "/shadow-apis-are-all-you-need";
const SHOW_ALL_INSTALL_OPTIONS = true;
const INSTALL_ANSWER = SHOW_ALL_INSTALL_OPTIONS
  ? "For skill-compatible hosts, start with npx skills add unbrowse-ai/unbrowse. If you want the local runtime wired automatically, use the one-shot installer script. If you do not want auto-detect, the manual fallback is npm install -g unbrowse. Cursor, Windsurf, Claude Code, Claude Desktop, Codex, and OpenClaw all have direct wiring paths. OpenClaw, Hermes, and ElizaOS use native browser-replacement integrations rather than simple package installs, so their full setup lives in the docs."
  : "Start with the shared skill: npx skills add unbrowse-ai/unbrowse. The landing page is intentionally pinned to that path for now. Full host-specific wiring and runtime setup still live in skill.md when you need them.";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How does Unbrowse work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse is a drop-in replacement for browser automation when you want API-native access to the web. It opens a local browser, captures network traffic as you interact with a site, and reverse-engineers the shadow API endpoints that power the frontend. Once discovered, these endpoints are stored as reusable skills so your agent can call them directly — no browser required.",
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
        text: "Unbrowse works with any website that uses shadow APIs to power its frontend — which includes most modern web applications. Sites like Airbnb, LinkedIn, and hundreds of others have been successfully mapped. When a site cannot be reverse-engineered, Unbrowse falls back to standard browser automation.",
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
        text: "Run npx unbrowse setup for a one-command installation that sets up browser assets and configures your agent host. If Unbrowse is already installed, upgrade to the latest version with npm install -g unbrowse@latest and rerun unbrowse setup. For skill-based agent platforms like OpenClaw, use npx skills add unbrowse-ai/unbrowse.",
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
    <>
    <FlowingDotField />
    <MobileNav />
    <div className="relative selection:bg-orange-500/30" style={{ zIndex: 2 }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* ═══ Agent-Readable Instructions ═══ */}
      <section id="agent-instructions" aria-label="Instructions for AI agents" className="sr-only" data-agent="true">
          <h2>Unbrowse — The API layer for AI agents</h2>
          <p>
            Unbrowse is an open-source CLI tool that reverse-engineers the shadow APIs behind any website, allowing AI agents to make direct API calls instead of automating headless browsers. It reduces page interaction time from 5-30 seconds to 50-200 milliseconds and cuts token usage from ~8,000 to ~200 tokens per action. Skills discovered by one agent are shared in a public registry for all agents to reuse.
          </p>
          <p>Setup: npx unbrowse setup</p>
          <p>Upgrade existing installs: npm install -g unbrowse@latest && unbrowse setup</p>
          <p>For skill hosts: npx skills add unbrowse-ai/unbrowse</p>
          <p>Community: https://discord.gg/VWugEeFNsG</p>
          <p>Usage: unbrowse resolve --intent &quot;...&quot; --url &quot;...&quot;</p>
          <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
      </section>

      {/* ═══ Hero ═══ */}
      <section className="relative flex flex-col justify-start overflow-hidden" style={{ minHeight: '90vh' }}>

        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-[13vh] pb-8 text-center flex flex-col items-center">

          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="group animate-fade-up mb-10 inline-flex items-center gap-2.5
                       text-[rgba(255,156,64,0.8)] text-xs font-mono uppercase tracking-[0.25em]
                       border-b border-[rgba(255,122,32,0.3)] pb-1.5
                       hover:text-[rgba(255,176,96,1)] hover:border-[rgba(255,122,32,0.6)] transition-all cursor-pointer"
          >
            <Github className="w-3.5 h-3.5" />
            <span>Free &amp; Open Source</span>
            <span className="text-[rgba(255,122,32,0.4)]">—</span>
            <span className="flex items-center gap-1">Star on GitHub <IconChevron size={11} className="group-hover:translate-x-0.5 transition-transform" /></span>
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

          <div className="animate-fade-up stagger-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-10">
            <ScrollToButton
              sectionId="install"
              className="group flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500
                         text-white font-mono font-medium text-sm w-full sm:w-auto
                         hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
            >
              [ Get Started <IconArrow size={14} className="group-hover:translate-x-1 transition-transform" /> ]
            </ScrollToButton>
            <ScrollToButton
              sectionId="demo"
              className="flex items-center justify-center gap-2 px-7 py-2.5
                         bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto
                         hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
            >
              [ See Demo ]
            </ScrollToButton>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              className="flex items-center justify-center gap-2 px-7 py-2.5
                         bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto
                         hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
            >
              [ Discord ]
            </a>
            <a
              href={WHITEPAPER_URL}
              target="_blank"
              rel="noopener"
              className="flex items-center justify-center gap-2 px-7 py-2.5
                         bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto
                         hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
            >
              [ Read Paper ]
            </a>
          </div>

        </div>

        <HeroHands />
      </section>

      {/* ═══ Install ═══ */}
      <section
        id="install"
        className="relative py-20 sm:py-28 flex flex-col items-center px-4 sm:px-6"
      >
        {/* Card + figure — wrapper is relative so figure can bleed out */}
        <div className="relative w-full max-w-4xl">

          {/* Terminal card */}
          <div className="relative w-full border border-[rgba(255,122,32,0.45)] bg-[#060402] overflow-hidden rounded-sm shadow-2xl shadow-black/40">
              <div className="border-b border-[rgba(255,122,32,0.2)] bg-[rgba(0,0,0,0.35)] px-5 py-4 sm:px-6 sm:py-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-[rgba(255,122,32,0.5)]">##  Install First</p>
                    <h2 className="mt-1 text-xl sm:text-2xl font-mono tracking-tight text-[#FFB060]" style={{ textShadow: '0 0 20px rgba(255,176,96,0.4)' }}>
                      $ unbrowse setup
                    </h2>
                  </div>
                  <p className="max-w-sm text-sm leading-relaxed text-[rgba(255,122,32,0.55)] font-mono">
                    Fresh install or quick upgrade. Same setup flow either way.
                  </p>
                </div>
              </div>
              <div className="p-4 sm:p-6">
                <InstallInstructions />
              </div>
          </div>

          <InstallFigure />
        </div>

        {/* Works seamlessly — normal flow below the card */}
        <div className="w-full max-w-4xl mt-6 max-sm:flex max-sm:justify-center sm:flex">
          <div
            className="inline-flex flex-col gap-3 px-6 py-4 rounded-sm max-sm:items-center"
            style={{ background: 'rgba(6,4,2,0.82)', border: '1px solid rgba(255,122,32,0.18)' }}
          >
            <p className="text-xs font-mono font-medium text-[rgba(255,122,32,0.45)] uppercase tracking-[0.2em] max-sm:text-center">Works seamlessly with</p>
            <div className="flex flex-wrap max-sm:justify-center items-center gap-5 text-[rgba(255,176,96,0.7)] sm:whitespace-nowrap">
              <span className="text-sm font-mono tracking-tight">Claude Code</span>
              <span className="text-sm font-mono tracking-tight">Cursor</span>
              <span className="text-sm font-mono tracking-tight">Windsurf</span>
              <span className="text-sm font-mono tracking-tight">OpenClaw</span>
              <span className="text-sm font-mono tracking-tight">Any Skill Agent</span>
            </div>
          </div>
        </div>
      </section>

       {/* ═══ Value Props — Bento Grid ═══ */}
       <section id="how-it-works" className="relative py-16 sm:py-24 flex flex-col justify-center">
         <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="relative text-center mb-6 flex flex-col items-center">
              <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
                ##  After You Install
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
                Bypass the DOM completely.
              </h2>
            </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">

              {/* Speed - Spans 2 cols */}
              <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 overflow-hidden md:col-span-2 transition-colors hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col md:flex-row gap-6 items-start md:items-center">
                <div className="relative z-10 flex-1">
                  <div className="mb-3 flex items-center gap-2 text-orange-500">
                    <IconHourglass size={16} />
                    <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Speed</span>
                  </div>
                  <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">Skip the rendering engine</h3>
                  <p className="text-text-secondary text-sm leading-relaxed max-w-md">
                    Headless browsers are slow and flaky. Unbrowse taps directly into the hidden shadow APIs that power the frontend, returning data instantly.
                  </p>
                </div>
                <div className="relative z-10 w-full md:w-auto md:flex-1 bg-[#060402] border border-[rgba(255,122,32,0.18)] p-5 rounded-sm flex flex-col items-center justify-center">
                  <span className="text-5xl font-bold font-display text-orange-500 tracking-tighter mb-1">100x</span>
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-[0.2em] mb-4">faster per page</span>
                  <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-mono bg-black/20 border border-[rgba(255,122,32,0.1)] px-4 py-2 w-full rounded-sm">
                    <span className="text-text-muted line-through">5-30s headless</span>
                    <span className="text-text-muted opacity-50">→</span>
                    <span className="text-orange-500 font-medium">50-200ms API</span>
                  </div>
                </div>
              </div>

              {/* Cost - Spans 1 col */}
              <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
                <div className="mb-3 flex items-center gap-2 text-orange-500">
                  <IconScript size={16} />
                  <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Tokens</span>
                </div>
                <h3 className="text-lg font-semibold mb-2 tracking-tight">40x fewer tokens</h3>
                <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
                  Why burn context on 8,000 tokens of HTML? Your agent gets the exact JSON data it needs — nothing else.
                </p>
                <div className="bg-[#060402] border border-[rgba(255,122,32,0.12)] p-3 mt-auto rounded-sm">
                  <div className="flex justify-between items-center text-xs font-mono mb-2">
                    <span className="text-text-muted">Scraping HTML</span>
                    <span className="text-text-muted">~8,000t</span>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-text-primary font-medium">Direct API</span>
                    <span className="text-orange-500 font-medium">~200t</span>
                  </div>
                </div>
              </div>

            {/* Reverse Engineer - Spans 1 col */}
            <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
              <div className="mb-3 flex items-center gap-2 text-orange-500">
                <IconCompass size={16} />
                <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Discovery</span>
              </div>
              <h3 className="text-lg font-semibold mb-2 tracking-tight">Auto-discovers APIs</h3>
              <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
                Your agent runs <code className="text-orange-500 font-medium font-mono text-xs">unbrowse resolve</code> and we instantly map the site's undocumented endpoints for immediate use.
              </p>
              <div className="pt-4 border-t border-[rgba(255,122,32,0.12)] space-y-2">
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> Zero config needed
                </div>
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> Shared skill registry
                </div>
              </div>
            </div>

            {/* Security - Spans 2 cols */}
            <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden md:col-span-2 hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col md:flex-row gap-6 items-start md:items-center">
              <div className="relative z-10 flex-1">
                <div className="mb-3 flex items-center gap-2 text-orange-500">
                  <IconSeal size={16} />
                  <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Security</span>
                </div>
                <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">Integrate with anything. Behind auth.</h3>
                <p className="text-text-secondary text-sm leading-relaxed max-w-md">
                  No cloud proxies, no expensive credits. Unbrowse runs locally, leveraging your actual browser sessions to securely access <strong className="text-orange-500 font-medium">auth-protected content</strong>.
                </p>
              </div>
              <div className="relative z-10 w-full md:w-auto md:flex-1 bg-[#060402] border border-[rgba(255,122,32,0.18)] p-4 font-mono text-xs rounded-sm">
                <div className="flex items-center justify-between mb-3 text-text-muted text-[10px] uppercase tracking-[0.2em] border-b border-[rgba(255,122,32,0.12)] pb-2">
                  <span>Security Check</span>
                  <span className="text-orange-500 font-medium flex items-center gap-1"><IconSeal size={10} /> Passed</span>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between gap-4"><span className="text-text-muted">Proxy Server</span><span className="text-text-secondary">None</span></div>
                  <div className="flex justify-between gap-4"><span className="text-text-muted">MITM</span><span className="text-text-secondary">Disabled</span></div>
                  <div className="flex justify-between gap-4"><span className="text-text-muted">Cookies leave device</span><span className="text-text-secondary">False</span></div>
                  <div className="flex justify-between gap-4"><span className="text-text-muted">Execution</span><span className="text-orange-500 font-medium">Local Only</span></div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

       {/* ═══ Chat Demo ═══ */}
       <section id="demo" className="relative py-16 sm:py-24 flex flex-col justify-center">
         <DemoParallax />
         <div className="relative max-w-5xl mx-auto px-4 sm:px-6 w-full">
           <div className="text-center mb-5">
             <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
               ##  See It In Action
             </p>
             <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2 text-balance text-text-primary">
               Example: <span className="text-orange-500">airbnb.com</span>
             </h2>
             <p className="text-text-secondary text-sm max-w-xl mx-auto leading-relaxed">
               One agent browses Airbnb. Every agent on the network
               can now search listings, check availability, and book — instantly, no browser.
             </p>
           </div>
           <ChatDemo />
         </div>
       </section>

       {/* ═══ 3-Panel Visual ═══ */}
       <ThreePanelVisual />

       {/* ═══ Registry Showcase ═══ */}
       <RegistryShowcase />

      {/* ═══ Fixed Footer Bar ═══ */}
      <footer className="fixed bottom-0 inset-x-0 z-40 bg-[#060402]/90 backdrop-blur-sm" style={{ borderTop: '1px solid rgba(255,122,32,0.2)' }}>
        <div className="max-w-7xl mx-auto px-6 h-10 flex items-center justify-between gap-4">
          <span className="text-xs text-[rgba(255,122,32,0.4)] font-mono">$ &copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
          <div className="hidden sm:flex items-center gap-5 text-xs text-[rgba(255,122,32,0.55)] font-mono">
            <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener" className="hover:text-[rgba(255,176,96,0.9)] transition-colors">GitHub</a>
            <a href="https://discord.gg/VWugEeFNsG" target="_blank" rel="noopener" className="hover:text-[rgba(255,176,96,0.9)] transition-colors">Discord</a>
            <Link href="/faq" className="hover:text-[rgba(255,176,96,0.9)] transition-colors">FAQ</Link>
            <Link href="/terms" className="hover:text-[rgba(255,176,96,0.9)] transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-[rgba(255,176,96,0.9)] transition-colors">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
    </>
  );
}
