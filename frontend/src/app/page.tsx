/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
 * macrostructure: Long Document · genre: modern-minimal
 * theme: studied-DNA (source: shopify.com/editions/winter2026)
 * paper: orange-on-near-black (--hl-paper #070503) · accent: orange (--hl-accent #FF5200, ≤5%)
 * display: Fonetika (var(--hl-font-display)) · body: Google Sans italic (var(--hl-font-body))
 * nav: N5 Floating pill (chapter rail) · footer: Ft5 Statement
 * mobile: pass (36, 59, 61–65) · contrast: pass (46–50) · honest: pass (56) · tokens: pass (58)
 */

import { FlowingDotField } from "@/components/flowing-dot-field";
import { MobileNav } from "@/components/mobile-nav";
import { ChapterSpine } from "@/components/hallmark/chapter-spine";

export const revalidate = 60;

// FAQ JSON-LD aligned with the masthead H1 frame. Numbers traced to honest
// inventory (paper §7, /v1/stats/summary). No invented metrics (gate 56).
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
        text: "Playwright MCP drives a real browser and streams the full accessibility tree on every call — about 114K tokens per typical task. Microsoft's own Playwright team recommends their CLI over their MCP for that reason. Unbrowse calls the website's internal API instead, returning the answer the agent asked for in roughly 5K tokens. Across 94 live domains the paper measures 3.6x mean (5.4x median) speedup over Playwright on read-shaped tasks.",
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

        {/* === Agent-readable instructions (sr-only) — preserved verbatim
            from the prior landing because removing it would tank the
            llms.txt + AI-search citation surface. */}
        <section
          id="agent-instructions"
          aria-label="Instructions for AI agents"
          className="sr-only"
          data-agent="true"
        >
          <h2>Unbrowse: direct access to anything on the web, without setting up another MCP</h2>
          <p>
            One MCP server, any website. Devs are already running a stack of
            per-site MCPs (Notion, Slack, Browser MCP, Playwright MCP, Gmail
            MCP, hand-rolled scrapers); unbrowse is the one that replaces them
            all. The first time your agent visits a site, unbrowse runs a
            headless browser, captures the shadow APIs the page itself calls,
            and publishes those routes to a shared marketplace. Every later
            call on the same site skips the browser entirely and returns the
            JSON answer in milliseconds. Drop one line into mcp.json and your
            agent gets direct access to any website without per-site setup.
            Browser automation tools (click, fill, submit, eval) exist in the
            MCP surface only as the cold fallback for sites whose APIs have
            not been captured yet. JA4 TLS impersonation handles bot
            detection. Cookies from your real Chrome authenticate every
            shadow-API call. Auth-walled endpoints get demoted in resolve.
            Routes cache after first browse; agents that reuse a paid route
            pay USDC on Solana via Faremeter Flex. Across 94 live domains,
            3.6x mean (5.4x median) speedup vs Playwright.
          </p>
          <p>MCP setup: npx unbrowse setup --mcp</p>
          <p>Claude Code: claude mcp add unbrowse -- npx -y unbrowse mcp</p>
          <p>Manual MCP wiring: add to mcp.json with command &quot;npx&quot; args [&quot;-y&quot;, &quot;unbrowse&quot;, &quot;mcp&quot;]</p>
          <p>Full documentation: https://www.unbrowse.ai/skill.md</p>
        </section>

        {/* === The Hallmark chapter spine — Long Document, archival-editorial */}
        <ChapterSpine />
      </div>
    </>
  );
}
