import {
  EditionsHero,
  EditionsNav,
  EditionsFooter,
  LenisProvider,
  type EditionsChapter,
} from "@/components/editions";
import { Ch01Thesis } from "@/components/editions/chapters/ch01-thesis";
import { Ch02Problem } from "@/components/editions/chapters/ch02-problem";
import { Ch03Mechanism } from "@/components/editions/chapters/ch03-mechanism";
import { Ch04Numbers } from "@/components/editions/chapters/ch04-numbers";
import { Ch05Install } from "@/components/editions/chapters/ch05-install";
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

// Wave-2A chapter index — 5 chapters port from May-18 onto cream.
// Wave-2B will add chapters 06-10 (Marketplace, Demo, Earn, Objections,
// Anti-ICP).
const chapters: EditionsChapter[] = [
  { id: "hero", label: "Cover" },
  { id: "thesis", label: "Thesis" },
  { id: "problem", label: "Problem" },
  { id: "mechanism", label: "Mechanism" },
  { id: "numbers", label: "Numbers" },
  { id: "install", label: "Install" },
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

          {/* ─── Chapters 01-05 ─── */}
          <Ch01Thesis />
          <Ch02Problem />
          <Ch03Mechanism />
          <Ch04Numbers />
          <Ch05Install />

          {/* ─── Editions footer (cream) ─── */}
          <EditionsFooter />
        </div>
      </LenisProvider>
    </>
  );
}
