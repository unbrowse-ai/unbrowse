import { Suspense } from "react";
import Link from "next/link";
import {
  HallmarkChapter,
  HallmarkRow,
  HallmarkRows,
  HallmarkFigure,
} from "./chapter";
import { ChapterRail, type RailChapter } from "./chapter-rail";
import { StatementFooter } from "./statement-footer";
import { ScrollToButton } from "@/components/full-page-scroll";
import { HeroHands } from "@/components/hero-hands";
import { AgentWireTerminal } from "@/components/agent-wire-terminal";
import { InstallInstructions } from "@/components/install-instructions";
import {
  ChatDemo,
  ThreePanelVisual,
  RegistryShowcase,
} from "@/components/heavy-clients";
import { HeroTerminalGated } from "@/components/hero-terminal-gated";
import { EarnSection } from "@/components/earn-section";
import { ObjectionFaq } from "@/components/objection-faq";
import { AntiIcpBlock } from "@/components/anti-icp-block";
import {
  getStatsSummary,
  listPopularSkills,
  type StatsSummary,
  type PopularSkillSummary,
} from "@/lib/api";
import { IconArrow } from "@/components/archival-icons";

const RAIL: RailChapter[] = [
  { id: "ch-shadow",   label: "01 Shadow API" },
  { id: "ch-install",  label: "02 Install" },
  { id: "ch-numbers",  label: "03 Numbers" },
  { id: "ch-earn",     label: "04 Earn" },
  { id: "ch-market",   label: "05 Marketplace" },
  { id: "ch-answers",  label: "06 Answers" },
];

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

async function NumberStrip() {
  let summary: StatsSummary | null = null;
  try {
    summary = await getStatsSummary();
  } catch {
    summary = null;
  }
  const domains = summary?.domains ?? 600;
  const executions = summary?.executions ?? 1_000_000;
  const skills = summary?.skills ?? 18_000;

  return (
    <div
      className="hl-stagger"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: "1px",
        background: "var(--hl-hairline)",
        border: "1px solid var(--hl-hairline)",
        fontFamily: "var(--hl-font-mono)",
      }}
    >
      {[
        { label: "domains in registry", value: fmt(domains), i: 0 },
        { label: "agent calls",         value: fmt(executions), i: 1 },
        { label: "shadow endpoints",    value: fmt(skills), i: 2 },
      ].map((s) => (
        <div
          key={s.label}
          style={{
            background: "var(--hl-paper-2)",
            padding: "1.75rem 1rem",
            textAlign: "center",
            ["--i" as string]: s.i,
          } as React.CSSProperties}
        >
          <div
            style={{
              color: "var(--hl-accent-warm)",
              fontFamily: "var(--hl-font-display)",
              fontVariantNumeric: "tabular-nums",
              fontSize: "clamp(2rem, 4vw, 3.5rem)",
              lineHeight: 1,
              letterSpacing: "-0.03em",
            }}
          >
            {s.value}
          </div>
          <div
            style={{
              fontSize: "var(--hl-text-eyebrow)",
              textTransform: "uppercase",
              letterSpacing: "0.22em",
              color: "var(--hl-ink-faint)",
              marginTop: "0.85rem",
            }}
          >
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

async function MarketplaceGrid() {
  let skills: PopularSkillSummary[] = [];
  try {
    skills = await listPopularSkills();
  } catch {
    skills = [];
  }
  if (!skills.length) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))",
        gap: "1px",
        background: "var(--hl-hairline-faint)",
        border: "1px solid var(--hl-hairline-faint)",
        fontFamily: "var(--hl-font-mono)",
        fontSize: "0.75rem",
      }}
    >
      {skills.slice(0, 12).map((s) => (
        <Link
          key={s.skill_id}
          href={`/${s.domain}`}
          style={{
            background: "var(--hl-paper-2)",
            padding: "0.85rem",
            textAlign: "center",
            textDecoration: "none",
            color: "var(--hl-ink-muted)",
            minWidth: 0,
          }}
        >
          <div
            style={{
              color: "var(--hl-accent-warm)",
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {s.domain}
          </div>
          <div
            style={{
              color: "var(--hl-ink-faint)",
              marginTop: "0.4rem",
              fontVariantNumeric: "tabular-nums",
              fontSize: "0.625rem",
            }}
          >
            {(s.total_executions ?? 0).toLocaleString()} calls
          </div>
        </Link>
      ))}
    </div>
  );
}

/**
 * ChapterSpine — Hallmark Long Document macrostructure for the Unbrowse
 * landing. One masthead + sticky rail + six chapters + Ft5 closer.
 *
 * Every section sits on var(--hl-paper) (near-black). Dark figures may
 * appear INSIDE figure-cards, never as section bleed (SPEC §9).
 */
export function ChapterSpine() {
  return (
    <div className="hl-spine">
      {/* === Masthead (H1 Marquee, archival surface) === */}
      <section className="hl-masthead">
        <div className="hl-masthead__inner">
          <span className="hl-masthead__eyebrow">
            Free · open source · AGPL-3.0 · runs locally
          </span>

          <h1 className="hl-masthead__h1">
            <span className="hl-word" style={{ ["--i" as string]: 0 } as React.CSSProperties}>The</span>{" "}
            <span className="hl-word" style={{ ["--i" as string]: 1 } as React.CSSProperties}>API</span>{" "}
            <span className="hl-word" style={{ ["--i" as string]: 2 } as React.CSSProperties}>layer</span>{" "}
            <span className="hl-word" style={{ ["--i" as string]: 3 } as React.CSSProperties}>for</span>{" "}
            <em className="hl-word" style={{ ["--i" as string]: 4 } as React.CSSProperties}>AI agents.</em>
          </h1>

          <p className="hl-masthead__lede">
            Your agent calls the shadow API the page would have called — not the
            browser. One MCP server, any site.
          </p>

          <div className="hl-masthead__ctas">
            <ScrollToButton sectionId="ch-install" className="hl-cta">
              <span>npx unbrowse setup</span>
              <IconArrow size={14} />
            </ScrollToButton>
            <Link href="/papers" className="hl-cta--ghost">
              Read the paper →
            </Link>
          </div>

          {/* AgentWireTerminal becomes the masthead figure-card — the product
              IS the proof. CRT Sistine hands sit underneath via HeroHands. */}
          <div style={{ marginTop: "clamp(3rem, 6vw, 5rem)" }}>
            <AgentWireTerminal />
          </div>
        </div>
        <HeroHands />
      </section>

      {/* Sticky chapter rail floats above first chapter */}
      <ChapterRail chapters={RAIL} />

      {/* === Chapter 01 — The shadow API === */}
      <HallmarkChapter
        id="ch-shadow"
        first
        numeral="01"
        name="The shadow API"
        title={<>Every site already runs an API. Your agent should call it.</>}
        lede={
          <>
            When you tap <em>Reserve</em>, the page POSTs to <code>/api/v3/reservations</code>{" "}
            with your cookies. Unbrowse captures the same endpoints on the first visit
            and lets your agent call them directly — in roughly 5K tokens instead of
            Playwright&rsquo;s ~114K.
          </>
        }
      >
        <Suspense fallback={<div aria-hidden style={{ minHeight: 420 }} />}>
          <ChatDemo />
        </Suspense>
        <HallmarkRows>
          <HallmarkRow
            label="Capture on first visit"
            body="HAR + JS interceptor record every fetch and XHR the page fires. Cookies from your real Chrome authenticate every call."
          />
          <HallmarkRow
            label="Replay on every call after"
            body="resolve picks the right endpoint for the intent; execute returns the JSON answer your agent asked for."
          />
        </HallmarkRows>
      </HallmarkChapter>

      {/* === Chapter 02 — Install === */}
      <HallmarkChapter
        id="ch-install"
        numeral="02"
        name="Install"
        title={<>One line into your MCP host. Any agent.</>}
        lede={
          <>
            Plugs into Claude Code, Claude Desktop, Cursor, Codex, Windsurf, and
            OpenClaw. Replaces the per-site MCP stack you&rsquo;ve been
            assembling by hand.
          </>
        }
      >
        <HallmarkFigure caption={<>$ unbrowse setup --mcp</>}>
          <InstallInstructions />
        </HallmarkFigure>
      </HallmarkChapter>

      {/* === Chapter 03 — The numbers === */}
      <HallmarkChapter
        id="ch-numbers"
        numeral="03"
        name="The numbers"
        title={<>3.6&times; mean. 5.4&times; median. 18 of 94 sub-100ms.</>}
        lede={
          <>
            Across 94 live domains the paper measures 3.6&times; mean and 5.4&times;
            median speed-up over Playwright on read-shaped tasks &mdash; roughly
            5K response tokens against Playwright&rsquo;s ~114K. Eighteen of those
            ninety-four sites resolve in under 100ms on a warm cache.
          </>
        }
      >
        <Suspense fallback={<div aria-hidden style={{ minHeight: 300 }} />}>
          <NumberStrip />
        </Suspense>
        <div style={{ marginTop: "clamp(1.5rem, 3vw, 2.5rem)" }}>
          <Suspense fallback={<div aria-hidden style={{ minHeight: 320 }} />}>
            <HeroTerminalGated />
          </Suspense>
        </div>
      </HallmarkChapter>

      {/* === Chapter 04 — Earn === */}
      <HallmarkChapter
        id="ch-earn"
        numeral="04"
        name="Earn while you browse"
        title={<>Index a route. Get paid every time another agent reuses it.</>}
        lede={
          <>
            Capture and indexing are free. When the next agent reuses your route
            the call settles in USDC on Solana via Faremeter Flex, directly to
            your wallet. The sponsor tier covers an agent&rsquo;s first $1/day.
          </>
        }
      >
        <EarnSection />
      </HallmarkChapter>

      {/* === Chapter 05 — Marketplace === */}
      <HallmarkChapter
        id="ch-market"
        numeral="05"
        name="Marketplace"
        title={<>600+ domains already cached. Your agent skips the browser.</>}
        lede={
          <>
            Every agent indexes; every agent benefits. The marketplace is the
            shared substrate. New domains land every day.
          </>
        }
      >
        <Suspense fallback={<div aria-hidden style={{ minHeight: 240 }} />}>
          <MarketplaceGrid />
        </Suspense>
        <div style={{ marginTop: "clamp(2rem, 4vw, 3rem)" }}>
          <Suspense fallback={<div aria-hidden style={{ minHeight: 320 }} />}>
            <RegistryShowcase />
          </Suspense>
        </div>
        <div style={{ marginTop: "clamp(2rem, 4vw, 3rem)" }}>
          <Suspense fallback={<div aria-hidden style={{ minHeight: 280 }} />}>
            <ThreePanelVisual />
          </Suspense>
        </div>
      </HallmarkChapter>

      {/* === Chapter 06 — Answers === */}
      <HallmarkChapter
        id="ch-answers"
        numeral="06"
        name="Answers"
        title={<>The eight questions every agent builder asks.</>}
        lede={
          <>
            MCP overload, browser blocks, login expiry, the earnings flow,
            licence, install. Everything you&rsquo;d ask before wiring this
            into your stack.
          </>
        }
      >
        <ObjectionFaq />
        <div style={{ marginTop: "clamp(2.5rem, 5vw, 4rem)" }}>
          <AntiIcpBlock />
        </div>
      </HallmarkChapter>

      <StatementFooter />
    </div>
  );
}
