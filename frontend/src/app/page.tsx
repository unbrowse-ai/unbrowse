import { Suspense } from "react";
import Link from "next/link";
import { Github } from "lucide-react";
import {
  Chapter,
  CtaLink,
  Hairline,
  EditionsHero,
  EditionsNav,
  WordSplit,
  ShadowFlow,
  SpeedupChart,
  FlywheelDiagram,
  InstallArtifact,
  type EditionsChapter,
} from "@/components/editions";
import { ChatDemo } from "@/components/chat-demo";
import { UnbrowseChatLive } from "@/components/unbrowse-chat-live";
import { ObjectionFaq } from "@/components/objection-faq";
import { LandingVisitTracker } from "@/components/landing-visit-tracker";
import { FlowingDotField } from "@/components/flowing-dot-field";
import { AntiIcpBlock } from "@/components/anti-icp-block";
import { BenchmarkTable } from "@/components/benchmark-table";
import { EarnSection } from "@/components/earn-section";
import { UniversalProofBand } from "@/components/universal-proof-band";
import { UseCasesBand } from "@/components/use-cases-band";
import { getStatsSummary, type StatsSummary } from "@/lib/api";

export const revalidate = 60;

async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/unbrowse-ai/unbrowse", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

function formatCount(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Why do I need yet another MCP server?",
      acceptedAnswer: {
        "@type": "Answer",
        text:
          "You probably already have Notion MCP, Slack MCP, Browser MCP, Playwright MCP, Gmail MCP. Unbrowse is one MCP that replaces all of them: drop one line into mcp.json and your agent gets direct access to any website without a per-site server.",
      },
    },
    {
      "@type": "Question",
      name: "How does my agent act on a website without clicking buttons?",
      acceptedAnswer: {
        "@type": "Answer",
        text:
          "Every modern website's UI calls its own internal APIs. Unbrowse captures those same internal APIs on the first visit and lets your agent call them directly with the same cookies.",
      },
    },
    {
      "@type": "Question",
      name: "How is Unbrowse different from Playwright MCP?",
      acceptedAnswer: {
        "@type": "Answer",
        text:
          "Playwright drives a real browser on every step. Unbrowse drives a real browser exactly once per site to capture the shadow APIs, then bypasses the browser forever. 3.6x mean speedup vs Playwright across 94 live domains.",
      },
    },
  ],
};

const CHAPTERS: EditionsChapter[] = [
  { id: "thesis", label: "Thesis" },
  { id: "install", label: "Install" },
  { id: "speed", label: "Speed" },
  { id: "marketplace", label: "Marketplace" },
  { id: "demo", label: "Demo" },
  { id: "faq", label: "FAQ" },
];

async function HeroStarMeta() {
  const stars = await getStarCount();
  const label = formatCount(stars);
  if (!label) {
    return (
      <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener noreferrer" className="cta-link">
        <Github className="w-4 h-4" aria-hidden /> Free, open source, runs locally
      </a>
    );
  }
  return (
    <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener noreferrer" className="cta-link">
      <Github className="w-4 h-4" aria-hidden />
      Free, open source · <span className="tabular-nums text-text-primary font-medium">{label}</span> stars on GitHub
    </a>
  );
}

/* StatsBand — three big numbers as typographic moments, NOT a feature grid.
   Brand-as-punctuation: orange appears only on ONE figure for accent. */
async function StatsBand() {
  let stats: StatsSummary | null = null;
  try { stats = await getStatsSummary(); } catch { stats = null; }
  if (!stats) return null;
  const cells = [
    { value: stats.domains?.toLocaleString() ?? "—", label: "Domains indexed", emphasised: false },
    { value: stats.endpoints?.toLocaleString() ?? "—", label: "Shadow APIs captured", emphasised: true },
    { value: stats.executions?.toLocaleString() ?? "—", label: "Agent executions", emphasised: false },
  ];
  // Per element-context rule b04f1589 (STAT NUMBER): stats here are evidence
  // SUPPORTING the chapter's primary visual (ShadowFlow), not competing for
  // the artifact slot. Sized at evidence register (2-3.25rem), not artifact
  // register (3-5.5rem reserved for chapter-leading numbers like 3.6×).
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12 mt-16 md:mt-20">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-col items-start gap-1.5">
          <span
            className="font-display tabular-nums leading-none"
            style={{
              fontSize: "clamp(2rem, 4vw, 3.25rem)",
              letterSpacing: "-0.028em",
              color: c.emphasised ? "var(--orange-text)" : "var(--text-primary)",
            }}
          >
            {c.value}
          </span>
          <span className="stamp-label">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      <Suspense fallback={null}>
        <LandingVisitTracker />
      </Suspense>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <EditionsNav
        chapters={CHAPTERS}
        primaryCta="Install"
        primaryHref="/install"
      />

      {/* FlowingDotField — restored from main's visual signature; sits behind
          the hero as a subtle canvas dot field, motion-respectful (honors
          prefers-reduced-motion via FlowingDotField's own guard). */}
      <div className="relative">
        <div className="absolute inset-0 pointer-events-none -z-10 opacity-40">
          <FlowingDotField />
        </div>
      <EditionsHero
        eyebrow="One MCP, any website"
        title={
          <>
            <WordSplit text="Direct access" />
            <br />
            <WordSplit text="to anything on the web." startIndex={2} />
            <br />
            <span className="text-text-muted">
              <WordSplit text="Without setting up" startIndex={7} />{" "}
              <WordSplit text="another MCP." startIndex={10} />
            </span>
          </>
        }
        lede="One install learns every site. First visit, your agent watches the site call its own API. Every visit after, your agent calls that API directly, signed in with your cookies."
        primaryCta="Install Unbrowse"
        primaryHref="/install"
        secondaryCta="Watch an agent book Airbnb"
        secondaryHref="#demo"
        meta={
          <Suspense fallback={null}>
            <HeroStarMeta />
          </Suspense>
        }
      />
      </div>

      {/* 01 · THESIS — visual artifact is the ShadowFlow diagram */}
      <Chapter
        id="thesis"
        number="01"
        name="Thesis"
        title={<>Use the site&apos;s own API.</>}
        lede="Every modern site is HTML wrapping a JSON API. Unbrowse watches the site call its own API on the first visit; your agent calls that API directly on every visit after."
      >
        <ShadowFlow />
        <div className="mt-10 flex flex-wrap gap-6">
          <CtaLink href="/what-is-unbrowse">What is Unbrowse</CtaLink>
          <CtaLink href="/shadow-apis-explained">How capture works</CtaLink>
        </div>
        <Suspense fallback={null}>
          <StatsBand />
        </Suspense>
        {/* AntiIcpBlock — positioning band from main, the "vs every other thing" frame */}
        <div className="mt-20"><AntiIcpBlock /></div>
      </Chapter>

      {/* USE CASES — band of agent use-cases between thesis and install */}
      <section id="use-cases" className="editions-shell" style={{ paddingBlock: "clamp(4rem, 8vw, 7rem)" }}>
        <UseCasesBand />
      </section>

      {/* 02 · INSTALL — visual artifact is the InstallArtifact code block */}
      <Chapter
        id="install"
        number="02"
        name="Install"
        title={<>One command, any host.</>}
        lede="Wires Unbrowse into Claude Code, Cursor, Codex, Windsurf, Claude Desktop, OpenClaw, and every MCP-aware framework after. Your first call lands in under two minutes."
      >
        <InstallArtifact />
        <div className="mt-10 flex flex-wrap gap-6">
          <Link href="/install" className="cta-primary cta-accent">
            Read the install guide
          </Link>
          <CtaLink href="/docs">Open the docs</CtaLink>
        </div>
      </Chapter>

      {/* 03 · SPEED — visual artifact is the SpeedupChart with the 3.6x as
          display-type punctuation, NOT a stat in a grid */}
      <Chapter
        id="speed"
        number="03"
        name="Speed"
        title={<>3.6x faster. 40x cheaper.</>}
        lede="The Unbrowse paper benchmarks shadow-API capture against Playwright across 94 live production websites. Cached routes return in 50-200ms versus 5-30s for browser automation. Token cost drops 40x because there is no DOM, no screenshots, no headers to ferry."
      >
        <SpeedupChart meanMs={1840} playwrightMs={6624} />
        {/* BenchmarkTable — concrete per-site results table from main, the data
            backing the 3.6x claim. Reads as the receipts. */}
        <div className="mt-16"><BenchmarkTable /></div>
        <div className="mt-10 flex flex-wrap gap-6">
          <CtaLink href="/benchmark-deep-dive">Read the benchmark deep-dive</CtaLink>
          <CtaLink href="/papers">Read the paper</CtaLink>
        </div>
      </Chapter>

      {/* 04 · MARKETPLACE — visual artifact is the FlywheelDiagram */}
      <Chapter
        id="marketplace"
        number="04"
        name="Marketplace"
        title={<>Capture once. Earn forever.</>}
        lede="The first agent to capture a domain is its indexer of record. Every later agent that reuses a paid route pays USDC on Solana via Faremeter Flex; the indexer earns the royalty. Discovery is the marketplace's job, not yours."
      >
        <FlywheelDiagram />
        {/* EarnSection — concrete earnings surface from main, the
            who-earns-what under the flywheel. */}
        <div className="mt-16"><EarnSection /></div>
        <div className="mt-10 flex flex-wrap gap-6">
          <Link href="/openclaw-earn" className="cta-primary cta-accent">
            Start earning
          </Link>
          <CtaLink href="/how-unbrowse-pays">How Unbrowse pays</CtaLink>
          <CtaLink href="/claim">Claim a domain</CtaLink>
        </div>
      </Chapter>

      {/* 05 · DEMO — the demo IS the visual artifact (real chat surface) */}
      <Chapter
        id="demo"
        number="05"
        name="Demo"
        title={<>Watch an agent book Airbnb without a browser.</>}
        lede="One agent browses Airbnb. Every agent on the network can now search listings, check availability, and book."
      >
        <div className="space-y-16">
          <ChatDemo />
          <div>
            <div className="mb-6 flex items-baseline justify-between gap-4 flex-wrap">
              <h3 className="font-display text-2xl sm:text-3xl text-text-primary" style={{ letterSpacing: "-0.022em" }}>
                Resolve against the live marketplace
              </h3>
              <p className="text-sm text-text-muted">
                Anonymous, no signup. <code className="font-mono">POST /v1/search</code>.
              </p>
            </div>
            <UnbrowseChatLive />
          </div>
        </div>
      </Chapter>

      {/* PROOF BAND — testimonial / quote shape from main, between demo and FAQ */}
      <section id="proof" className="editions-shell" style={{ paddingBlock: "clamp(4rem, 8vw, 7rem)" }}>
        <UniversalProofBand />
      </section>

      {/* 06 · FAQ — restraint: the answers ARE the artifact */}
      <Chapter
        id="faq"
        number="06"
        name="FAQ"
        title={<>The objections developers actually have.</>}
        lede="Real questions from real shipped agents. Honest answers, not marketing."
      >
        <ObjectionFaq />
      </Chapter>

      {/* CLOSING — inverse dark CTA band */}
      <Chapter
        id="start"
        inverse
        name="Get started"
        title={<>Stop maintaining per-site MCP servers.</>}
        lede="One install. Any website. Free to run locally; pay only when you reuse paid routes."
      >
        <div className="flex flex-wrap gap-4 items-center mt-4">
          <Link href="/install" className="cta-primary cta-accent">
            Install Unbrowse
          </Link>
          <Link href="/playground" className="cta-link" style={{ color: "var(--text-inverse)" }}>
            Try the playground
          </Link>
          <Link href="/papers" className="cta-link" style={{ color: "var(--text-inverse)" }}>
            Read the paper
          </Link>
        </div>
      </Chapter>
    </>
  );
}
