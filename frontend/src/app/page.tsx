import { Suspense } from "react";
import Link from "next/link";
import {
  Chapter,
  EditionsHero,
  EditionsNav,
  LenisProvider,
  type EditionsChapter,
} from "@/components/editions";
import { EditionsPageBodyClass } from "@/components/editions-page-body-class";

export const revalidate = 60;

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
        text: "You probably already have Notion MCP, Slack MCP, Browser MCP, Playwright MCP, Gmail MCP, and a few hand-rolled site-specific ones. Unbrowse is one MCP that replaces all of them: drop a single line into your mcp.json and your agent gets direct access to any website without a per-site server.",
      },
    },
    {
      "@type": "Question",
      name: "How is Unbrowse different from Playwright MCP?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Playwright MCP drives a real browser and streams the full accessibility tree on every call. Unbrowse calls the website's internal API instead, returning the answer the agent asked for in roughly 5K tokens. Across 94 live domains the paper measures 3.6x mean (5.4x median) speedup over Playwright on read-shaped tasks.",
      },
    },
  ],
};

// Wave-1 chapter index. Wave-2 will add the other 10 chapters
// (Install, Universal proof, Use cases, Zero setup, Benchmarks,
// Earn, Demo, Registry, Compat, FAQ).
const chapters: EditionsChapter[] = [
  { id: "hero", label: "Cover" },
  { id: "thesis", label: "Thesis" },
];

export default function Home() {
  return (
    <>
      <EditionsPageBodyClass />
      <LenisProvider>
        <div className="editions-surface">
          <script
            type="application/ld+json"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
          />

          {/* ─── Agent-readable instructions (carried over from May-18) ─── */}
          <section
            id="agent-instructions"
            aria-label="Instructions for AI agents"
            className="sr-only"
            data-agent="true"
          >
            <h2>
              Unbrowse: direct access to anything on the web, without setting
              up another MCP
            </h2>
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
            <p>
              Manual MCP wiring: add to mcp.json with command &quot;npx&quot;
              args [&quot;-y&quot;, &quot;unbrowse&quot;, &quot;mcp&quot;]
            </p>
            <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
          </section>

          {/* ─── Sticky chapter nav ─── */}
          <EditionsNav chapters={chapters} />

          {/* ─── Chapter 00: Hero (cream, no top border) ─── */}
          <EditionsHero />

          {/* ─── Chapter 01: Thesis ─── */}
          <Chapter
            id="thesis"
            number="[01]"
            name="Thesis"
            title="One MCP. Any website."
            lede="Not a stack of per-site MCPs. Not another framework on top of Playwright. The web layer your agent already wants."
          >
            <Suspense fallback={null}>
              <ThesisDiff />
            </Suspense>
          </Chapter>

          {/* ─── Wave-1 footer (minimal cream, full SiteFooter returns in Wave-2) ─── */}
          <EditionsFooterWave1 />
        </div>
      </LenisProvider>
    </>
  );
}

/**
 * ThesisDiff — single contained dark figure inside the thesis chapter.
 * Shows the Playwright-to-unbrowse import swap as a code diff. Dark
 * surface only lives inside this card; the chapter background stays cream
 * (SPEC §9).
 */
function ThesisDiff() {
  return (
    <div className="ed-dark-figure">
      <pre>
        <span className="ed-diff-out">{`import { chromium } from "playwright";`}</span>
        {"\n"}
        <span className="ed-diff-in">{`import { Browser } from "@unbrowse/sdk";`}</span>
      </pre>
    </div>
  );
}

function EditionsFooterWave1() {
  return (
    <footer className="chapter" style={{ paddingBlock: "clamp(2rem, 5vw, 4rem)" }}>
      <div className="editions-shell flex flex-wrap items-center justify-between gap-4 text-sm" style={{ color: "var(--ed-ink-muted)" }}>
        <span>&copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
        <div className="flex items-center gap-5">
          <Link href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener noreferrer" className="editions-nav-link">
            GitHub
          </Link>
          <Link href="/faq" className="editions-nav-link">FAQ</Link>
          <Link href="/terms" className="editions-nav-link">Terms</Link>
          <Link href="/privacy" className="editions-nav-link">Privacy</Link>
        </div>
      </div>
    </footer>
  );
}
