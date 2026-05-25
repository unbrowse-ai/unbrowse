import { Chapter } from "@/components/editions";
import "./chapters.css";

/**
 * Chapter [09] Objections — Wave-2B port of §14 ObjectionFaq + FAQ JSON-LD.
 *
 * 8 objections lifted verbatim from a corpus of 76 Reddit threads
 * (r/AI_Agents, r/mcp, r/LocalLLaMA, r/LangChain, r/ChatGPTCoding,
 * r/webscraping, r/SaaS, r/CryptoCurrency, r/ethdev, r/MachineLearning,
 * r/programming, r/sideproject) pulled 2026-05-19. Trace in
 * frontend/docs/POSITIONING.md.
 *
 * Truth-drift fixed inline (NOT in objection-faq.tsx so we do not collide
 * with other surfaces still rendering the legacy component):
 *   - "Crypto is sketchy" answer previously said "USDC on Base L2" —
 *     rewritten to "USDC on Solana via Faremeter Flex." Matches the
 *     EarnSection chain language and backend services/sponsor-flex.ts.
 *
 * Cream-on-ink-text styling lives in chapters.css under .ed-objection.
 * FAQ JSON-LD schema block is inlined at the bottom so GEO crawlers still
 * pick up the structured data when this chapter is the source of truth.
 */
export function Ch09Objections() {
  const rows: Array<{ q: string; a: string; cite: string }> = [
    {
      q: "We need traces and selectors for CI.",
      a: "Keep Playwright for CI. unbrowse is for runtime agents, not the test harness.",
      cite: "implied vs Playwright MCP (t3_1spvkrz)",
    },
    {
      q: "Charlotte / Browser DevTools MCP exist on the same efficiency frame.",
      a: "Same efficiency frame. unbrowse adds a shared route cache via marketplace, auth inheritance from your real Chrome, and a sponsor tier for first-time-agent discovery.",
      cite: "t3_1rhjxet, t3_1rrta8f",
    },
    {
      q: "Residential proxies are sketchy.",
      a: "Used only as fallback, only when the bare browser is challenged, only on networks you can audit. The default path is your real Chrome with your real cookies.",
      cite: "t3_1o1zlt0, t3_1qzbk1v",
    },
    {
      q: "How does it find the right API on a new site?",
      a: "Capture during the first browse, rank against the agent's intent, cache. The shared marketplace means the second agent on the same site usually skips the browse entirely.",
      cite: "t3_1rz29ac, t3_1sx45zv",
    },
    {
      q: "Crypto is sketchy.",
      a: "USDC on Solana via Faremeter Flex. Capture and indexing are free; settlement only on agent-to-route execute. You can cash out to a bank via Crossmint lobster.cash.",
      cite: "t3_1pe54l3, t3_1s3ozz0",
    },
    {
      q: "How do agents find my route after I publish?",
      a: "Resolve queries the marketplace during route selection. First-mover routes on a domain get a sponsor-tier boost so they show up before competitors. Marketplace is open at /search.",
      cite: "t3_1p63m3b, t3_1pgebeh, t3_1s16g2b",
    },
    {
      q: "Codex / Grok refuse to fetch URLs.",
      a: 'Right. unbrowse is the web tool, the coding agent stays in its lane. There is no "against the rules" on a public URL when the web-fetch is a separate MCP call.',
      cite: "t3_1pqsqbz",
    },
    {
      q: "I want first-party SDKs for the services I care about.",
      a: "Keep them. Use unbrowse for the long tail and for sites that have no MCP. The universal MCP is for the 80% of sites no one will write a first-party MCP for.",
      cite: "t3_1rz29ac, t3_1sumut0",
    },
  ];

  // FAQ JSON-LD: schema.org export of the same Q&A surface. Kept in the
  // chapter so the GEO crawler payload travels with the visible block.
  // (Numbers verified against the paper + codebase. Do NOT re-introduce
  // Song et al.'s +24% as ours. Do NOT claim Base settlement.)
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: rows.map((r) => ({
      "@type": "Question",
      name: r.q,
      acceptedAnswer: { "@type": "Answer", text: r.a },
    })),
  };

  return (
    <Chapter
      id="objections"
      number="[09]"
      name="Objections"
      title="Real objections. Real answers."
      lede="Eight objections lifted verbatim from a corpus of seventy-six Reddit threads."
    >
      <div className="ed-objection-list">
        {rows.map((r) => (
          <details key={r.q} className="ed-objection">
            <summary>
              <span className="q">{r.q}</span>
              <span className="toggle" aria-hidden="true">
                +
              </span>
            </summary>
            <div className="body">
              <p className="cite">cite: {r.cite}</p>
              <p className="answer">{r.a}</p>
            </div>
          </details>
        ))}
      </div>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </Chapter>
  );
}
