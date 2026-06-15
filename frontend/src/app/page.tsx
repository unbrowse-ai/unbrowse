import Link from "next/link";
import { InstallInstructions } from "@/components/install-instructions";
import { ThreePanelVisual } from "@/components/three-panel-visual";
import { ScrollToButton } from "@/components/full-page-scroll";
import { FlowingDotField } from "@/components/flowing-dot-field";
import { HeroHands } from "@/components/hero-hands";
import { HeroChat } from "@/components/hero-chat";
import { InstallFigure } from "@/components/install-figure";
import { MobileNav } from "@/components/mobile-nav";
import { Github } from "lucide-react";
import {
  IconHourglass,
  IconCompass,
  IconSeal,
  IconScript,
  IconDiamondCheck,
  IconChevron,
} from "@/components/archival-icons";

// Re-generate the homepage at most every 60s so Cloudflare can serve a static
// HTML response on warm cache. Removes the 6.8s TTFB observed on cold
// renders where the server was awaiting upstream fetches before streaming.
export const revalidate = 60;

const WHITEPAPER_URL = "/internal-apis-are-all-you-need";

// Homepage Research strip — kept in sync with /papers. paper #3 links to the
// real published PDF (`/unbrowse-maintenance-network.pdf`); the papers page
// previously pointed at a filename that 404s.
const PAPERS = [
  {
    title: "Internal APIs Are All You Need",
    blurb: "The wedge: first-party routes already sit beneath modern websites. Learn them once, reuse them when they are still fresh, and keep the browser as fallback.",
    href: "/internal-apis-are-all-you-need",
    pdf: false,
  },
  {
    title: "Crypto Was All You Needed",
    blurb: "The execution layer: one signing discipline follows an agent through screen, browser, CLI, OS, kernel, and packet, with credentials and results bound to that identity.",
    href: "/crypto-was-all-you-needed.pdf",
    pdf: true,
  },
  {
    title: "Unbrowse Maintenance Network",
    blurb: "The maintenance layer: route freshness has to be witnessed over time, challenged when wrong, and paid as real maintenance work.",
    href: "/unbrowse-maintenance-network.pdf",
    pdf: true,
  },
];
const SHOW_ALL_INSTALL_OPTIONS = true;
const INSTALL_ANSWER = SHOW_ALL_INSTALL_OPTIONS
  ? "Run npm install -g unbrowse, then unbrowse setup. Setup installs the Agent Skill and browser engine; it does not write MCP host configs. Legacy MCP users can run unbrowse mcp manually as a stdio server."
  : "Run npm install -g unbrowse, then unbrowse setup. The Agent Skill is the default surface.";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How does Unbrowse work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse is an open-source action layer for AI agents. It learns first-party routes behind websites from real browsing, keeps credentials local, and lets later calls use a direct route when one is available. When a site still needs a browser, the browser remains the fallback.",
      },
    },
    {
      "@type": "Question",
      name: "How much faster is Unbrowse than headless browser automation?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "In the Internal APIs Are All You Need benchmark, warmed cached routes averaged a 3.6x mean speedup and 5.4x median speedup over Playwright across 94 live domains. The practical benefit is not magic latency; it is avoiding repeated rendering, DOM parsing, and token-heavy page dumps when a structured route is already known.",
      },
    },
    {
      "@type": "Question",
      name: "Is Unbrowse free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The client, CLI, SDK, and local bridge are open and free to install. Shared marketplace usage can require x402 payment when a paid route or paid lookup is used; capture and local execution paths remain available without pretending every upstream cost is free.",
      },
    },
    {
      "@type": "Question",
      name: "What websites does Unbrowse support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse works best on sites whose frontends call structured first-party routes, which is common on modern web applications. Some routes are cached already; misses fall back to browser capture or ordinary browser automation. Blocked or hostile sites are recorded as misses rather than relabelled as successes.",
      },
    },
    {
      "@type": "Question",
      name: "Is Unbrowse secure? Do my credentials leave my machine?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unbrowse runs entirely locally and your credentials never leave your device. There are no cloud proxies, no man-in-the-middle interception, browser cookies stay on your machine, and authentication credentials are encrypted with AES-256-CBC in a local vault. Only discovered API endpoint patterns (URL templates and schemas, never your data or credentials) are shared with the registry, and only when you opt in via `unbrowse mode`. That makes Unbrowse safe to install on a work machine without changing your existing security posture.",
      },
    },
    {
      "@type": "Question",
      name: "How do I install Unbrowse?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Run npm install -g unbrowse, then unbrowse setup. Setup installs the Unbrowse Agent Skill and browser engine; it does not write MCP host configs. Legacy MCP users can run unbrowse mcp manually as a stdio server.",
      },
    },
    {
      "@type": "Question",
      name: "What is the skill registry?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The skill registry is a shared marketplace of reverse-engineered API skills. When one agent discovers how to interact with a website's API, the result is published so every other agent can call those endpoints without re-discovering them. Value compounds because every new capture lowers the cost for the next agent that needs the same data, the way Wikipedia gets more useful with every edit. That is what turns Unbrowse from a per-agent tool into shared infrastructure for the agent web.",
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
          <h2>Unbrowse — an action layer for web agents</h2>
          <p>
            Unbrowse learns first-party routes behind websites and lets agents act through them directly when they are available, instead of driving a headless browser by default. In the 94-domain paper benchmark, warmed cached routes averaged a 3.6x mean speedup and 5.4x median speedup over Playwright. Routes discovered by one agent can be reused by others, and the people who maintain those routes can be compensated when they run.
          </p>
          <p>Default setup: npm install -g unbrowse; unbrowse setup</p>
          <p>Setup installs the Agent Skill and browser engine. It does not write MCP host configs.</p>
          <p>Legacy MCP stdio server: unbrowse mcp</p>
          <p>Community: https://discord.gg/VWugEeFNsG</p>
          <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
      </section>

      {/* ═══ Hero ═══ */}
      <section className="relative flex flex-col justify-start overflow-hidden" style={{ minHeight: '90vh' }}>

        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-[13vh] pb-8 text-center flex flex-col items-center">

          <div className="animate-fade-up mb-6 flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="group inline-flex items-center gap-2.5
                         text-[rgba(255,156,64,0.8)] text-xs font-mono uppercase tracking-[0.25em]
                         border-b border-[rgba(255,122,32,0.3)] pb-1.5
                         hover:text-[rgba(255,176,96,1)] hover:border-[rgba(255,122,32,0.6)] transition-all cursor-pointer"
            >
              <Github className="w-3.5 h-3.5" />
              <span>Free, open source, runs locally</span>
              <span className="text-[rgba(255,122,32,0.4)]">·</span>
              <span className="flex items-center gap-1">Star on GitHub <IconChevron size={11} className="group-hover:translate-x-0.5 transition-transform" /></span>
            </a>
          </div>

          <h1 className="animate-fade-up stagger-1 text-[2.6rem] sm:text-6xl lg:text-[5rem] leading-[1.05] tracking-tight text-balance text-text-primary font-display">
            The <span className="text-orange-500">route layer for web agents.</span>
          </h1>

          <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
            Ask it anything below. It tries the site&apos;s real first-party routes
            first, and keeps the browser for the cases where a browser is still
            required.
          </p>

          <div className="animate-fade-up stagger-3 w-full mt-10">
            <HeroChat />
          </div>

          {/* Social proof through scale — the registry the live chat draws on. Real, conservative
              figures (mirrors the FAQ); the agent above resolves against exactly this graph. */}
          <p className="animate-fade-up stagger-3 mt-5 font-mono text-xs text-[rgba(255,156,64,0.7)]">
            <span className="text-[rgba(255,176,96,0.95)] font-medium">94-domain benchmark</span>
            <span className="text-[rgba(255,122,32,0.35)]"> · </span>
            <span className="text-[rgba(255,176,96,0.95)] font-medium">3.6x mean / 5.4x median speedup</span>
            <span className="text-[rgba(255,122,32,0.35)]"> · </span>
            direct routes when known; browser fallback when not.
          </p>

          <div className="animate-fade-up stagger-3 mt-6 flex flex-wrap items-center justify-center gap-4 text-xs font-mono text-[rgba(255,156,64,0.7)]">
            <ScrollToButton sectionId="install" className="hover:text-[rgba(255,176,96,1)] transition-colors cursor-pointer">
              [ npx unbrowse setup → ]
            </ScrollToButton>
            <span className="text-[rgba(255,122,32,0.3)]">·</span>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              className="hover:text-[rgba(255,176,96,1)] transition-colors"
            >
              join discord
            </a>
            <span className="text-[rgba(255,122,32,0.3)]">·</span>
            <a
              href={WHITEPAPER_URL}
              target="_blank"
              rel="noopener"
              className="hover:text-[rgba(255,176,96,1)] transition-colors"
            >
              read the paper
            </a>
          </div>

        </div>

        <HeroHands />
      </section>

      {/* ═══ Credibility strip — NVIDIA Inception membership + ecosystem ═══ */}
      <section aria-label="Membership and ecosystem" className="relative px-4 sm:px-6 pb-10 sm:pb-14">
        <div className="max-w-4xl mx-auto flex flex-col items-center gap-7">
          {/* Official NVIDIA Inception program member badge (white + green; reads on dark as-is).
              Naming per NVIDIA brand guidelines: "member of the NVIDIA Inception program". */}
          <div className="flex flex-col items-center gap-3">
            <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.5)]">Member of the</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/nvidia-inception.svg" alt="NVIDIA Inception Program member" className="h-14 sm:h-16 w-auto" />
          </div>
          {/* Ecosystem — partners in their own brand colours (aiko treatment: invert only the
              dark marks; Crossmint forced to the light foreground since an img-loaded SVG
              cannot inherit currentColor). */}
          <div className="flex flex-col items-center gap-4 pt-5 border-t border-[rgba(255,122,32,0.12)] w-full max-w-3xl">
            <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.5)]">Plugged into the agent economy</span>
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
              {/* Crossmint — currentColor wordmark → light foreground (aiko intent) */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/partner-crossmint.svg" alt="Crossmint" className="h-6 w-auto opacity-85" style={{ filter: "brightness(0) invert(1)" }} />
              {/* MoonPay — dark mark, inverted to read on dark (aiko's exact filter) */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/partner-moonpay.svg" alt="MoonPay" className="h-6 w-auto opacity-85" style={{ filter: "invert(1) grayscale(1) brightness(1.6) contrast(1.1)" }} />
              {/* Corbits — brand orange wordmark, shown as-is */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/partner-corbits.svg" alt="Corbits" className="h-5 w-auto" />
              {/* UpRock — brand mark, shown as-is */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/partner-uprock.png" alt="UpRock" className="h-7 w-auto" />
            </div>
          </div>
          {/* Required NVIDIA trademark attribution — the NVIDIA logo is used above. */}
          <p className="text-[10px] leading-relaxed text-[rgba(255,122,32,0.4)] font-mono text-center max-w-2xl">
            © 2025 NVIDIA and the NVIDIA logo are trademarks and/or registered trademarks of NVIDIA Corporation in the U.S. and other countries.
          </p>
        </div>
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
                    <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-[rgba(255,122,32,0.5)]">##  Skill Install</p>
                    <h2 className="mt-1 text-xl sm:text-2xl font-mono tracking-tight text-[#FFB060]" style={{ textShadow: '0 0 20px rgba(255,176,96,0.4)' }}>
                      $ unbrowse setup
                    </h2>
                  </div>
                  <p className="max-w-sm text-sm leading-relaxed text-[rgba(255,122,32,0.55)] font-mono">
                    Installs the Agent Skill and browser engine. MCP config is manual-only.
                  </p>
                </div>
              </div>
              <div className="p-4 sm:p-6">
                <InstallInstructions />
              </div>
          </div>

          <InstallFigure />
        </div>

        {/* Plugs into agent stack — normal flow below the card */}
        <div className="w-full max-w-4xl mt-6 max-sm:flex max-sm:justify-center sm:flex">
          <div
            className="inline-flex flex-col gap-3 px-6 py-4 rounded-sm max-sm:items-center"
            style={{ background: 'rgba(6,4,2,0.82)', border: '1px solid rgba(255,122,32,0.18)' }}
          >
            <p className="text-xs font-mono font-medium text-[rgba(255,122,32,0.45)] uppercase tracking-[0.2em] max-sm:text-center">Plugs into the agent stack you already use</p>
            <div className="flex flex-wrap max-sm:justify-center items-center gap-x-5 gap-y-2 text-[rgba(255,176,96,0.7)] sm:whitespace-nowrap">
              <span className="text-sm font-mono tracking-tight">Claude Code</span>
              <span className="text-sm font-mono tracking-tight">Claude Desktop</span>
              <span className="text-sm font-mono tracking-tight">Cursor</span>
              <span className="text-sm font-mono tracking-tight">Codex</span>
              <span className="text-sm font-mono tracking-tight">Windsurf</span>
              <span className="text-sm font-mono tracking-tight">OpenClaw</span>
              <span className="text-sm font-mono tracking-tight">Any MCP framework</span>
            </div>
          </div>
        </div>

        {/* Fair-compensation nudge — payout flow set up during install */}
        <div className="w-full max-w-4xl mt-4 max-sm:flex max-sm:justify-center sm:flex">
          <p className="text-xs font-mono text-[rgba(255,122,32,0.55)] max-sm:text-center">
            <span className="text-[rgba(255,176,96,0.85)]">$</span> Fair compensation, built in — when the routes you index get reused, you earn. Set up payouts during setup.
          </p>
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
                    Headless browsers are expensive when the page is only a route discovery step. Unbrowse reuses known first-party routes and falls back to the browser when the route is missing.
                  </p>
                </div>
                <div className="relative z-10 w-full md:w-auto md:flex-1 bg-[#060402] border border-[rgba(255,122,32,0.18)] p-5 rounded-sm flex flex-col items-center justify-center">
                  <span className="text-5xl font-bold font-display text-orange-500 tracking-tighter mb-1">3.6x</span>
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-[0.2em] mb-4">mean speedup in paper</span>
                  <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-mono bg-black/20 border border-[rgba(255,122,32,0.1)] px-4 py-2 w-full rounded-sm">
                    <span className="text-text-muted line-through">browser-first</span>
                    <span className="text-text-muted opacity-50">→</span>
                    <span className="text-orange-500 font-medium">cached route</span>
                  </div>
                </div>
              </div>

              {/* Cost - Spans 1 col */}
              <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
                <div className="mb-3 flex items-center gap-2 text-orange-500">
                  <IconScript size={16} />
                  <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Tokens</span>
                </div>
                <h3 className="text-lg font-semibold mb-2 tracking-tight">Fewer tokens</h3>
                <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
                  A direct route returns structured data instead of forcing the model to reason over a whole rendered page.
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
                Your agent calls Unbrowse over MCP and the right shadow endpoint comes back — schemas, parameters, sample values, all ready to call.
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

      {/* The live demo IS the hero chat bar; the old scripted replay section was
          removed so the only chat on the site is the real agent loop. */}

      {/* ═══ Research ═══ */}
      <section id="research" className="relative py-16 sm:py-24 flex flex-col items-center px-4 sm:px-6">
        <div className="max-w-5xl mx-auto w-full">
          <div className="text-center mb-8 flex flex-col items-center">
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">##  Research</p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">The thinking behind the engine.</h2>
            <p className="mt-3 text-text-secondary text-sm sm:text-base max-w-2xl leading-relaxed">
              Three papers: why internal APIs are the machine-native interface, how one
              signing discipline secures every layer an agent touches, and how a shared
              route graph stays fresh and fairly paid.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {PAPERS.map((paper) => {
              const cardClass =
                "group flex flex-col h-full p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 rounded-sm transition-colors hover:border-[rgba(255,122,32,0.35)] hover:bg-[#0a0705]";
              const body = (
                <>
                  <div className="mb-3 flex items-center gap-2 text-orange-500">
                    <IconScript size={16} />
                    <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-text-muted">
                      {paper.pdf ? "PDF ↗" : "Read ↗"}
                    </span>
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold mb-2 tracking-tight text-text-primary group-hover:text-orange-500 transition-colors">
                    {paper.title}
                  </h3>
                  <p className="text-text-secondary text-sm leading-relaxed">{paper.blurb}</p>
                </>
              );
              return paper.pdf ? (
                <a key={paper.href} href={paper.href} target="_blank" rel="noopener" className={cardClass}>
                  {body}
                </a>
              ) : (
                <Link key={paper.href} href={paper.href} className={cardClass}>
                  {body}
                </Link>
              );
            })}
          </div>

          <div className="mt-6 text-center">
            <Link
              href="/papers"
              className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-[0.2em] text-[rgba(255,156,64,0.8)] hover:text-[rgba(255,176,96,1)] border-b border-[rgba(255,122,32,0.3)] hover:border-[rgba(255,122,32,0.6)] pb-1 transition-colors"
            >
              read all papers <IconChevron size={11} />
            </Link>
          </div>
        </div>
      </section>

       {/* ═══ 3-Panel Visual ═══ */}
       <ThreePanelVisual />

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
