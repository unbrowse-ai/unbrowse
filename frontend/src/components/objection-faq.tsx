'use client';

/**
 * Reddit-objection FAQ. Each row is a real objection voiced in the
 * /reddit corpus pulled 2026-05-19 (76 threads across r/AI_Agents,
 * r/mcp, r/LocalLLaMA, r/LangChain, r/ChatGPTCoding, r/webscraping,
 * r/SaaS, r/CryptoCurrency, r/ethdev, r/MachineLearning, r/programming,
 * r/sideproject). Trace in frontend/docs/POSITIONING.md.
 */
export function ObjectionFaq() {
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
      a: "USDC on Solana via Faremeter Flex. Settlement is gas-light and instant; pay.sh routes payouts straight to a bank account. You never touch the chain unless you want to.",
      cite: "t3_1pe54l3, t3_1s3ozz0",
    },
    {
      q: "How do agents find my route after I publish?",
      a: "Resolve queries the marketplace during route selection. First-mover routes on a domain get a sponsor-tier boost so they show up before competitors. Marketplace is open at /search.",
      cite: "t3_1p63m3b, t3_1pgebeh, t3_1s16g2b",
    },
    {
      q: "Codex / Grok refuse to fetch URLs.",
      a: "Right. unbrowse is the web tool, the coding agent stays in its lane. There is no \"against the rules\" on a public URL when the web-fetch is a separate MCP call.",
      cite: "t3_1pqsqbz",
    },
    {
      q: "I want first-party SDKs for the services I care about.",
      a: "Keep them. Use unbrowse for the long tail and for sites that have no MCP. The universal MCP is for the 80% of sites no one will write a first-party MCP for.",
      cite: "t3_1rz29ac, t3_1sumut0",
    },
  ];

  return (
    <section id="objections" className="relative py-16 sm:py-24">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-8">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
            ##  Asked on Reddit
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
            Real objections. Real answers.
          </h2>
          <p className="text-sm text-text-secondary mt-3 max-w-2xl mx-auto leading-relaxed">
            Eight objections lifted verbatim from threads in the corpus.
            Every answer cites the Reddit thread it came from.
          </p>
        </div>

        <div className="border-t border-[rgba(255,122,32,0.18)]">
          {rows.map((r) => (
            <details
              key={r.q}
              className="group border-b border-[rgba(255,122,32,0.18)] bg-[#070503]/40 transition-colors hover:bg-[#070503]/90"
            >
              <summary className="cursor-pointer list-none p-5 flex items-start justify-between gap-4">
                <span className="text-base sm:text-lg font-medium text-text-primary leading-snug tracking-tight">
                  {r.q}
                </span>
                <span
                  aria-hidden="true"
                  className="text-lg font-mono text-[rgba(255,176,96,0.85)] shrink-0 leading-none mt-1 group-open:rotate-45 transition-transform duration-200"
                >
                  +
                </span>
              </summary>
              <div className="px-5 pb-5 -mt-1 space-y-2 max-w-3xl">
                <p className="text-sm sm:text-base text-text-secondary leading-relaxed">
                  {r.a}
                </p>
                <p className="text-[11px] font-mono text-[rgba(255,122,32,0.55)]">
                  cite: {r.cite}
                </p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
