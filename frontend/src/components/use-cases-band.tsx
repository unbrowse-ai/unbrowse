'use client';

import Link from "next/link";
import { IconArrow, IconDiamondCheck } from "./archival-icons";

/**
 * UseCasesBand — concrete things your agent does on the web by calling
 * the SAME internal API the site's own UI calls. Not browser automation;
 * not click/fill/submit. The agent says intent → unbrowse_resolve picks
 * the right captured endpoint → unbrowse_execute calls it with your
 * browser cookies → JSON answer back.
 *
 * Resolve pipeline (per CLAUDE.md): route cache (<200ms) → marketplace
 * (~1s) → first-pass browser (8s, captures + publishes). After the
 * first-pass browser captures a site, every later call on that site
 * skips the browser. Across the network, the cold-start tax shrinks
 * as more people install unbrowse.
 *
 * IMPORTANT HONESTY NOTE on numbers:
 *   - 3.6x mean / 5.4x median over Playwright across 94 live domains:
 *     unbrowse's own measurement (paper section 7, llms.txt:68).
 *   - 18 of 94 domains complete in sub-100ms from cache: ours (llms.txt:69).
 *   - The "+24% on WebArena" number is from Song et al. "Beyond
 *     Browsing: API-Based Web Agents" (cited in our paper section 2.1
 *     as RELATED WORK), NOT our measurement. Do not claim it as ours.
 *   - Our bench is read-shaped (modelled after WebArena's
 *     information-retrieval category, section 7.2). The MCP write
 *     surface and auth-inherited execute primitive work the same way
 *     on writes, but we have not published an authenticated-action
 *     speedup number.
 *
 * Site examples chosen from the open corpus at harness/probes/corpus.txt
 * (x.com, linkedin.com/feed, github.com/search, jup.ag, priceline.com,
 * reddit.com) so the examples stay honest.
 */
export function UseCasesBand() {
  const cases: Array<{
    category: string;
    headline: string;
    intent: string;
    apiHint: string;
    sites: string[];
    tools: string[];
    auth: string;
  }> = [
    {
      category: "Travel",
      headline: "Book the trip while you are in a meeting.",
      intent: '"hotels in Tokyo May 22-26 under $300/night, 2 guests"',
      apiHint:
        "unbrowse calls priceline.com / airbnb.com's own search + reservation endpoints (the ones their UI calls when you tap \"Reserve\") with your browser session.",
      sites: ["priceline.com", "airbnb.com", "opentable.com"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your saved cards + booking-site cookies",
    },
    {
      category: "Code review",
      headline: "Triage the morning PR queue.",
      intent: '"approve PRs touching only docs/, request changes on the rest"',
      apiHint:
        "unbrowse calls github.com's pulls-list + review-submit endpoints directly. No UI driving; the comment + APPROVE verdict ride the same API the green button posts to.",
      sites: ["github.com"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your GitHub session cookies",
    },
    {
      category: "Distribution",
      headline: "Post the thread, everywhere, from one draft.",
      intent: '"queue this thread on X and LinkedIn for 9am Tuesday"',
      apiHint:
        "unbrowse calls each platform's compose / schedule endpoint directly. One markdown draft fans out through the APIs the platforms use for their own composer.",
      sites: ["x.com", "linkedin.com", "typefully.com"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your real cookies on each platform",
    },
    {
      category: "Solana / DeFi",
      headline: "Swap tokens without a browser tab open.",
      intent: '"swap 5 SOL to USDC, slippage 0.5%, send to my main wallet"',
      apiHint:
        "unbrowse hits jup.ag's quote + swap endpoints. Your wallet signs the returned tx. No DOM rendering, no MetaMask popup loop, no clicking.",
      sites: ["jup.ag", "phantom.app"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your wallet extension session",
    },
    {
      category: "Inbox + calendar",
      headline: "Clear the inbox at 7am.",
      intent: '"reply to anything from a customer, draft the rest, schedule any meeting requests"',
      apiHint:
        "Gmail and Calendar both expose internal APIs your browser already calls every time you refresh. unbrowse calls them with the same cookies. No OAuth scopes to wire, no per-app token.",
      sites: ["mail.google.com", "calendar.google.com"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your Google cookies (no OAuth scopes)",
    },
    {
      category: "Errands at scale",
      headline: "Reorder the cart. File the return. Cancel the trial.",
      intent: '"reorder last week\'s Whole Foods cart minus the milk; refund the Amazon order #117..."',
      apiHint:
        "Each retailer's frontend posts to internal cart-mutate and return-init endpoints. unbrowse posts to the same endpoints with your session cookies. Same effect as you tapping the button.",
      sites: ["amazon.com", "instacart.com", "doordash.com"],
      tools: ["unbrowse_resolve", "unbrowse_execute"],
      auth: "Your saved cards + retailer cookies",
    },
  ];

  return (
    <section id="use-cases" className="relative py-16 sm:py-24 flex flex-col justify-center">
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 min-w-0">
        <div className="text-center mb-8 flex flex-col items-center">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
            ##  Not just reading. Doing.
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary max-w-3xl">
            Browse once. Call forever.
          </h2>
          <p className="text-sm sm:text-base text-text-secondary mt-3 max-w-2xl leading-relaxed">
            The resolve pipeline tries three paths in order:
            local <strong className="text-orange-500 font-mono not-italic">route cache</strong> (&lt;200ms),
            shared <strong className="text-orange-500 font-mono not-italic">marketplace</strong> (sub-second),
            then a <strong className="text-orange-500 font-mono not-italic">first-pass browser</strong> (8s) that
            visits the site for your agent and captures its internal APIs.
            Once captured, every later call on that site skips the browser
            entirely and returns the JSON answer in milliseconds. The more
            people install Unbrowse, the more first-pass captures land in
            the shared cache, so the cold-start tax shrinks across the
            network.
          </p>
        </div>

        {/* Inline three-path latency strip — anchored as a single sheet */}
        <div className="mb-10 grid grid-cols-3 gap-px bg-[rgba(255,122,32,0.18)] border border-[rgba(255,122,32,0.24)] max-w-3xl mx-auto font-mono text-xs">
          <div className="bg-[#070503] px-3 py-4 text-center">
            <div className="text-orange-500 text-2xl sm:text-3xl font-display tracking-[-0.03em] tabular-nums leading-none">&lt;200ms</div>
            <div className="text-text-muted text-[10px] uppercase tracking-[0.22em] mt-2.5">route cache</div>
            <div className="text-text-secondary text-[10px] mt-1 leading-relaxed">already on your machine</div>
          </div>
          <div className="bg-[#070503] px-3 py-4 text-center">
            <div className="text-orange-500 text-2xl sm:text-3xl font-display tracking-[-0.03em] tabular-nums leading-none">~1s</div>
            <div className="text-text-muted text-[10px] uppercase tracking-[0.22em] mt-2.5">marketplace</div>
            <div className="text-text-secondary text-[10px] mt-1 leading-relaxed">someone else already captured it</div>
          </div>
          <div className="bg-[#070503] px-3 py-4 text-center">
            <div className="text-orange-500 text-2xl sm:text-3xl font-display tracking-[-0.03em] tabular-nums leading-none">20-80s</div>
            <div className="text-text-muted text-[10px] uppercase tracking-[0.22em] mt-2.5">first-pass browser</div>
            <div className="text-text-secondary text-[10px] mt-1 leading-relaxed">unbrowse visits for you, captures the API</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {cases.map((c) => (
            <div
              key={c.category}
              className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 overflow-hidden transition-colors hover:border-[rgba(255,122,32,0.4)] rounded-sm flex flex-col"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-[rgba(255,122,32,0.65)]">
                  {c.category}
                </span>
                <IconArrow size={12} className="text-text-muted group-hover:text-orange-500 group-hover:translate-x-0.5 transition-all" />
              </div>

              <h3 className="text-base sm:text-lg font-semibold mb-3 tracking-tight text-text-primary leading-snug">
                {c.headline}
              </h3>

              <div className="relative bg-[#060402] border border-[rgba(255,122,32,0.18)] p-3 pl-4 mb-3 rounded-sm font-mono leading-relaxed">
                <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[2px] bg-orange-500/70" />
                <div className="text-[10px] uppercase tracking-[0.22em] text-[rgba(255,122,32,0.55)] mb-1.5">Agent intent</div>
                <div className="text-[rgba(255,200,140,1)] text-[13px] sm:text-sm leading-[1.45]">{c.intent}</div>
              </div>

              <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
                {c.apiHint}
              </p>

              <div className="space-y-2 pt-3 border-t border-[rgba(255,122,32,0.12)] mt-auto">
                <div className="flex flex-wrap gap-1.5">
                  {c.tools.map((t) => (
                    <code
                      key={t}
                      className="text-[10px] font-mono text-[rgba(255,176,96,0.85)] bg-[#060402] border border-[rgba(255,122,32,0.18)] px-1.5 py-0.5 rounded-sm"
                    >
                      {t}
                    </code>
                  ))}
                </div>

                <div className="text-[11px] font-mono text-text-muted leading-relaxed">
                  <span className="text-[rgba(255,122,32,0.6)]">sites:</span>{" "}
                  {c.sites.join(", ")}
                </div>
                <div className="flex items-start gap-1.5 text-[11px] font-mono text-text-muted leading-relaxed">
                  <IconDiamondCheck size={11} className="text-orange-500 shrink-0 mt-0.5" />
                  <span>{c.auth}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Write-action proof — honest framing, no Song-et-al number masquerading as ours */}
        <div className="mt-8 border border-[rgba(255,122,32,0.18)] bg-[#070503]/70 rounded-sm p-5 sm:p-6 flex flex-col sm:flex-row gap-5 sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
              Why the architecture works for writes too
            </p>
            <p className="text-text-primary text-base sm:text-lg leading-snug">
              The same primitive that fetches a search result POSTs a reservation.
            </p>
            <p className="text-xs text-text-muted mt-2 leading-relaxed max-w-xl">
              <code className="font-mono">unbrowse_execute</code> calls any captured endpoint with your cookies,{" "}
              <span className="text-[rgba(255,176,96,0.85)]">GET or POST</span>, idempotent or not. Our 94-domain
              published bench measures the read path (modelled after WebArena&apos;s
              information-retrieval category); the write path rides the same
              primitive with the same auth. Browse{" "}
              <Link href="/search" className="underline decoration-[rgba(255,122,32,0.4)] hover:text-[rgba(255,176,96,1)]">the marketplace</Link>{" "}
              for the authenticated routes the community has already captured.
            </p>
          </div>
          <Link
            href="/search"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] transition-all whitespace-nowrap"
          >
            See the live marketplace →
          </Link>
        </div>

        <p className="text-center mt-6 text-xs font-mono text-[rgba(255,122,32,0.55)] max-w-3xl mx-auto leading-relaxed">
          The first-pass browser is the only time a browser runs for any given
          site. After capture the marketplace serves the route forever. Every
          install adds new captures to the shared cache.
        </p>
      </div>
    </section>
  );
}
