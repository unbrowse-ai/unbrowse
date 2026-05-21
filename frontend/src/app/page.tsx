import { Suspense } from "react";
import Link from "next/link";
import { ChatDemo } from "@/components/chat-demo";
import { InstallInstructions } from "@/components/install-instructions";
import { ThreePanelVisual } from "@/components/three-panel-visual";
import { RegistryShowcase } from "@/components/registry-showcase";
import { ScrollToButton } from "@/components/full-page-scroll";
import { LandingVisitTracker } from "@/components/landing-visit-tracker";
import { FlowingDotField } from "@/components/flowing-dot-field";
import { HeroHands } from "@/components/hero-hands";
import { HeroTerminalGated } from "@/components/hero-terminal-gated";
import { AudienceToggle } from "@/components/audience-toggle";
import {
  HeroSubhead,
  HeroPrimaryCtaLabel,
  HeroWhyItMatters,
  HeroHeadlineInner,
  HeroSpeedProofStrip,
} from "@/components/hero-copy";
import { InstallFigure } from "@/components/install-figure";
import { DemoParallax } from "@/components/demo-parallax";
import { MobileNav } from "@/components/mobile-nav";
import { UniversalProofBand } from "@/components/universal-proof-band";
import { UseCasesBand } from "@/components/use-cases-band";
import { ZeroSetupBand } from "@/components/zero-setup-band";
import { BenchmarkTable } from "@/components/benchmark-table";
import { EarnSection } from "@/components/earn-section";
import { AntiIcpBlock } from "@/components/anti-icp-block";
import { ObjectionFaq } from "@/components/objection-faq";
import { TrustStrip } from "@/components/trust-strip";
import { Github } from "lucide-react";
import {
  getStatsSummary,
  listPopularSkills,
  type StatsSummary,
  type PopularSkillSummary,
} from "@/lib/api";
import { IconArrow, IconChevron } from "@/components/archival-icons";

export const revalidate = 60;

const WHITEPAPER_URL = "https://arxiv.org/abs/2604.00694";
// FAQ JSON-LD aligned with the locked H1: "Direct access to anything on
// the web. Without setting up another MCP." First question carries the
// pain frame; numbers verified against the paper + codebase. Do NOT
// re-introduce Song et al.'s +24% number as ours. Do NOT claim Base
// settlement (Solana via Faremeter Flex).
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Why do I need yet another MCP server?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "You probably already have Notion MCP, Slack MCP, Browser MCP, Playwright MCP, Gmail MCP, and a few hand-rolled site-specific ones. Unbrowse is one MCP that replaces all of them: drop a single line into your mcp.json and your agent gets direct access to any website without a per-site server. New site appears, same MCP server captures it on the first visit; there is no new MCP to install, no new config block, no new auth flow.",
      },
    },
    {
      "@type": "Question",
      name: "How does my agent act on a website without clicking buttons?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Every modern website's UI calls its own internal APIs. When you tap \"Reserve\" on Airbnb, the page POSTs to /api/v3/reservations with your cookies. Unbrowse captures those same internal APIs on the first visit and lets your agent call them directly with the same cookies. Your agent says its intent in natural language; unbrowse_resolve picks the right captured endpoint, unbrowse_execute calls it. Browser automation tools (click, fill, submit, eval) are also exposed in the MCP surface but only as the cold-start fallback when a new site's APIs have not been captured yet.",
      },
    },
    {
      "@type": "Question",
      name: "How is Unbrowse different from Playwright MCP?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Playwright MCP drives a real browser and streams the full accessibility tree on every call, about 114K tokens per typical task. Microsoft's own Playwright team recommends their CLI over their MCP for that reason. Unbrowse calls the website's internal API instead, returning the answer the agent asked for in roughly 5K tokens. Across 94 live domains the paper measures 3.6x mean (5.4x median) speedup over Playwright on read-shaped tasks.",
      },
    },
    {
      "@type": "Question",
      name: "Does Unbrowse get blocked by Cloudflare Turnstile or Datadome?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Most of the time the agent never hits the WAF because it never loads the page; it calls the JSON endpoint the page would have called. When a fresh-site capture is required, unbrowse_fetch ships with libcurl-impersonate so the TLS handshake matches the JA4 fingerprint of a real Chrome, combined with your own browser cookies, so Turnstile / Datadome / PerimeterX usually never fire. If the bare-browser path is still challenged, residential-proxy fallback is one env var away (UNBROWSE_PROXY_URL).",
      },
    },
    {
      "@type": "Question",
      name: "Does my agent inherit my browser logins, and what happens when a login expires?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes, opt-in per domain. Cookies from your real Chrome and Firefox authenticate every shadow-API call; per-domain auth profiles live in your system Keychain. When an endpoint returns a 401, the ranker marks it auth_walled and demotes it the next time you resolve. Three login-hint surfaces (Keychain / browser / agent prompt) tell you exactly where to reauthenticate. Nothing leaves your machine.",
      },
    },
    {
      "@type": "Question",
      name: "How does the earnings flow work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Capture and indexing are free. Use Unbrowse normally; every shadow-API route you capture lands in the public marketplace. When the next agent reuses your route the call settles in USDC on Solana via Faremeter Flex, directly to your wallet. The sponsor tier covers an agent's first $1/day so they explore your routes before they spend their own. Set up Crossmint lobster.cash during `npx unbrowse setup` to wire the payout address.",
      },
    },
    {
      "@type": "Question",
      name: "Is Unbrowse free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Unbrowse is open source under AGPL-3.0 and runs locally. There are no paid tiers, cloud proxies, or usage credits required to install or run it. The marketplace settles in USDC; the tool itself is free.",
      },
    },
    {
      "@type": "Question",
      name: "How do I install Unbrowse?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Run npx unbrowse setup --mcp and your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, Codex, OpenClaw) gets wired in one step. For Claude Code: claude mcp add unbrowse -- npx -y unbrowse mcp. For manual setup, add {\"unbrowse\": {\"command\": \"npx\", \"args\": [\"-y\", \"unbrowse\", \"mcp\"]}} to your mcp.json and restart.",
      },
    },
  ],
};

async function HeroStats() {
  let summary: StatsSummary | null = null;
  try {
    summary = await getStatsSummary();
  } catch {
    summary = null;
  }
  const domains = summary?.domains ?? 600;
  const executions = summary?.executions ?? 1_000_000;
  const skills = summary?.skills ?? 18_000;

  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
  };

  return (
    <section
      id="hero-stats"
      aria-label="Live unbrowse marketplace stats"
      className="relative py-10"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-3 gap-3 sm:gap-6 text-center font-mono">
          {[
            { label: "domains in registry", value: fmt(domains) },
            { label: "agent visits", value: fmt(executions) },
            { label: "shadow API endpoints", value: fmt(skills) },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-[#070503]/90 border border-[rgba(255,122,32,0.18)] rounded-sm py-5 px-3"
            >
              <div className="text-3xl sm:text-4xl text-orange-500 tracking-tighter font-display">
                {s.value}
              </div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-text-muted mt-2">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

async function PopularSkillsGrid() {
  let skills: PopularSkillSummary[] = [];
  try {
    skills = await listPopularSkills();
  } catch {
    skills = [];
  }
  if (!skills.length) return null;

  return (
    <section
      id="popular-skills"
      aria-label="Top routes already in the marketplace"
      className="relative py-12"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-4 text-center">
          ##  Top routes already cached
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono text-xs">
          {skills.slice(0, 12).map((s) => (
            <Link
              key={s.skill_id}
              href={`/${s.domain}`}
              className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm px-3 py-3 hover:border-[rgba(255,122,32,0.4)] transition-colors text-center"
            >
              <div className="text-[rgba(255,176,96,0.9)] truncate">
                {s.domain}
              </div>
              <div className="text-text-muted mt-1 text-[10px]">
                {s.total_executions ?? 0} calls
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <FlowingDotField />
      <MobileNav />
      <LandingVisitTracker />
      <div className="relative selection:bg-orange-500/30" style={{ zIndex: 2 }}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
        {/* ═══ Agent-Readable Instructions ═══ */}
        <section
          id="agent-instructions"
          aria-label="Instructions for AI agents"
          className="sr-only"
          data-agent="true"
        >
          <h2>Unbrowse: direct access to anything on the web, without setting up another MCP</h2>
          <p>
            One MCP server, any website. Devs are already running a stack
            of per-site MCPs (Notion, Slack, Browser MCP, Playwright MCP,
            Gmail MCP, hand-rolled scrapers); unbrowse is the one that
            replaces them all. The first time your agent visits a site,
            unbrowse runs a headless browser, captures the shadow APIs the
            page itself calls, and publishes those routes to a shared
            marketplace. Every later call on the same site skips the
            browser entirely and returns the JSON answer in milliseconds.
            Drop one line into mcp.json and your agent gets direct access
            to any website without per-site setup. Browser automation
            tools (click, fill, submit, eval) exist in the MCP surface
            only as the cold fallback for sites whose APIs have not been
            captured yet. JA4 TLS impersonation handles bot detection.
            Cookies from your real Chrome authenticate every shadow-API
            call. Auth-walled endpoints get demoted in resolve. Routes
            cache after first browse; agents that reuse a paid route pay
            USDC on Solana via Faremeter Flex. Across 94 live domains,
            3.6x mean (5.4x median) speedup vs Playwright.
          </p>
          <p>MCP setup: npx unbrowse setup --mcp</p>
          <p>Claude Code: claude mcp add unbrowse -- npx -y unbrowse mcp</p>
          <p>Manual MCP wiring: add to mcp.json with command &quot;npx&quot; args [&quot;-y&quot;, &quot;unbrowse&quot;, &quot;mcp&quot;]</p>
          <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
        </section>

        {/* ═══ Hero (h1: "Direct access to anything on the web. Without setting up another MCP.") ═══ */}
        <section
          className="relative flex flex-col justify-start overflow-hidden"
          style={{ minHeight: "90dvh" }}
        >
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
                <span className="flex items-center gap-1">
                  Star on GitHub{" "}
                  <IconChevron
                    size={11}
                    className="group-hover:translate-x-0.5 transition-transform"
                  />
                </span>
              </a>
              <Suspense fallback={<div className="h-7" />}>
                <AudienceToggle />
              </Suspense>
            </div>

            <Suspense
              fallback={
                <div className="animate-fade-up stagger-1 mb-2 flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
                  <span className="px-3 py-1.5 bg-[#070503]/85 border border-[rgba(255,122,32,0.22)] rounded-sm">
                    <span className="text-orange-500 font-medium">1 MCP</span>{" "}
                    <span className="text-text-muted">for any site</span>
                  </span>
                </div>
              }
            >
              <HeroSpeedProofStrip />
            </Suspense>

            <h1 className="animate-fade-up stagger-1 text-[2.6rem] sm:text-6xl lg:text-[5.5rem] leading-[1.05] tracking-tight text-balance text-text-primary font-display">
              <Suspense
                fallback={
                  <>
                    Direct access to anything on the web.{" "}
                    <br className="hidden sm:block" />
                    <span className="text-orange-500">Without setting up another MCP.</span>
                  </>
                }
              >
                <HeroHeadlineInner />
              </Suspense>
            </h1>

            <Suspense
              fallback={
                <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
                  One MCP server, any site. First visit captures the site&apos;s
                  shadow APIs; your agent calls them directly forever after,
                  signed in with your cookies.
                </p>
              }
            >
              <HeroSubhead />
            </Suspense>

            <div className="animate-fade-up stagger-3 flex flex-col items-center gap-4 mt-10">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <ScrollToButton
                  sectionId="install"
                  umamiEvent="install_cta_click"
                  className="group flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500
                             text-white font-mono font-medium text-sm w-full sm:w-auto
                             hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
                >
                  <Suspense
                    fallback={<span>[ npx unbrowse setup → ]</span>}
                  >
                    <HeroPrimaryCtaLabel />
                  </Suspense>
                  <IconArrow
                    size={14}
                    className="group-hover:translate-x-1 transition-transform"
                  />
                </ScrollToButton>
                <ScrollToButton
                  sectionId="use-cases"
                  className="flex items-center justify-center gap-2 px-7 py-2.5
                             bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto
                             hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
                >
                  [ See what your agent can do ]
                </ScrollToButton>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="mt-8 h-14 w-full max-w-3xl rounded-sm border border-[rgba(255,122,32,0.12)]" />
              }
            >
              <TrustStrip />
            </Suspense>

            <Suspense fallback={null}>
              <HeroWhyItMatters />
            </Suspense>

            <Suspense fallback={null}>
              <HeroTerminalGated />
            </Suspense>
          </div>

          <HeroHands />
        </section>

        {/* ═══ Install ═══ */}
        <section
          id="install"
          className="relative py-20 sm:py-28 flex flex-col items-center px-4 sm:px-6"
        >
          <div className="relative w-full max-w-4xl">
            <div className="relative w-full border border-[rgba(255,122,32,0.45)] bg-[#060402] overflow-hidden rounded-sm shadow-2xl shadow-black/40">
              <div className="border-b border-[rgba(255,122,32,0.2)] bg-[rgba(0,0,0,0.35)] px-5 py-4 sm:px-6 sm:py-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-[rgba(255,122,32,0.5)]">
                      ##  MCP Install
                    </p>
                    <h2
                      className="mt-1 text-xl sm:text-2xl font-mono tracking-tight text-[#FFB060]"
                      style={{ textShadow: "0 0 20px rgba(255,176,96,0.4)" }}
                    >
                      $ unbrowse setup --mcp
                    </h2>
                  </div>
                  <p className="max-w-sm text-sm leading-relaxed text-[rgba(255,122,32,0.55)] font-mono">
                    Wires the Unbrowse MCP server into your agent host. One
                    command per client.
                  </p>
                </div>
              </div>
              <div className="p-4 sm:p-6">
                <InstallInstructions />
              </div>
            </div>

            <InstallFigure />
          </div>

          <div className="w-full max-w-4xl mt-6 max-sm:flex max-sm:justify-center sm:flex">
            <div
              className="inline-flex flex-col gap-3 px-6 py-4 rounded-sm max-sm:items-center"
              style={{
                background: "rgba(6,4,2,0.82)",
                border: "1px solid rgba(255,122,32,0.18)",
              }}
            >
              <p className="text-xs font-mono font-medium text-[rgba(255,122,32,0.45)] uppercase tracking-[0.2em] max-sm:text-center">
                Plugs into the agent stack you already use
              </p>
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
        </section>

        <UniversalProofBand />
        <UseCasesBand />
        <ZeroSetupBand />
        <BenchmarkTable />

        <Suspense fallback={<div aria-hidden style={{ minHeight: 90 }} />}>
          <HeroStats />
        </Suspense>
        <Suspense fallback={<div aria-hidden style={{ minHeight: 220 }} />}>
          <PopularSkillsGrid />
        </Suspense>

        <EarnSection />

        <section
          id="demo"
          className="relative py-16 sm:py-24 flex flex-col justify-center"
        >
          <DemoParallax />
          <div className="relative max-w-5xl mx-auto px-4 sm:px-6 w-full">
            <div className="text-center mb-5">
              <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
                ##  See it in action
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2 text-balance text-text-primary">
                Example: <span className="text-orange-500">airbnb.com</span>
              </h2>
              <p className="text-text-secondary text-sm max-w-xl mx-auto leading-relaxed">
                One agent browses Airbnb. Every agent on the network can now
                search listings, check availability, and book, instantly, no
                browser.
              </p>
            </div>
            <ChatDemo />
          </div>
        </section>

        <RegistryShowcase />
        <ThreePanelVisual />
        <ObjectionFaq />
        <AntiIcpBlock />

        <footer
          className="fixed bottom-0 inset-x-0 z-40 bg-[#060402]/95"
          style={{ borderTop: "1px solid rgba(255,122,32,0.2)" }}
        >
          <div className="max-w-7xl mx-auto px-6 h-10 flex items-center justify-between gap-4">
            <span className="text-xs text-[rgba(255,122,32,0.4)] font-mono">
              $ &copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd.
            </span>
            <div className="hidden sm:flex items-center gap-5 text-xs text-[rgba(255,122,32,0.55)] font-mono">
              <a
                href="https://github.com/unbrowse-ai/unbrowse"
                target="_blank"
                rel="noopener"
                className="hover:text-[rgba(255,176,96,0.9)] transition-colors"
              >
                GitHub
              </a>
              <Link
                href="/faq"
                className="hover:text-[rgba(255,176,96,0.9)] transition-colors"
              >
                FAQ
              </Link>
              <Link
                href="/terms"
                className="hover:text-[rgba(255,176,96,0.9)] transition-colors"
              >
                Terms
              </Link>
              <Link
                href="/privacy"
                className="hover:text-[rgba(255,176,96,0.9)] transition-colors"
              >
                Privacy
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
