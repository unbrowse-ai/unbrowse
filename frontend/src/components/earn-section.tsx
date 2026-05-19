'use client';

import Link from "next/link";
import { IconDiamondCheck, IconArrow } from "./archival-icons";

/**
 * Supply-side / ICP-B wedge. Promoted from a single-line install
 * nudge to its own section based on wave-2 evidence (13 cited threads
 * across r/CryptoCurrency, r/ethdev, r/SaaS, r/AI_Agents asking
 * literally for "a marketplace for AI agents/APIs with instant
 * stablecoin payment").
 *
 * Wave-3 codebase fixes applied:
 *   - F1: chain is Solana via Faremeter Flex (NOT Base). Source:
 *     backend/src/services/sponsor-flex.ts + middleware/sponsor.ts:16.
 *   - U7: Crossmint lobster.cash is the payout path. Source:
 *     llms.txt:75 + prior page.tsx copy.
 *   - U8: capture and indexing are FREE; agents only pay on reuse of
 *     a paid route. Source: llms.txt:72.
 *
 * Citations trace in frontend/docs/POSITIONING.md.
 */
export function EarnSection() {
  return (
    <section id="earn" className="relative py-16 sm:py-24 flex flex-col justify-center">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 items-start">
          <div className="lg:col-span-3">
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
              ##  For the supply side
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
              The next agent on your route pays you.
            </h2>
            <p className="text-sm sm:text-base text-text-secondary mt-4 max-w-2xl leading-relaxed">
              Capture and indexing are free. Use unbrowse normally; every
              route you cache lands in the public marketplace. When the
              <em> next</em> agent reuses your route, the call settles in
              USDC on Solana via Faremeter Flex, directly to your wallet.
              No API key billing, no Stripe dashboard.
            </p>
            <p className="text-sm sm:text-base text-text-secondary mt-3 max-w-2xl leading-relaxed">
              The sponsor tier covers an agent&apos;s first <span className="text-orange-500 font-mono">$1/day</span>, so
              they explore your routes before they spend their own wallet.
              Discovery is the marketplace&apos;s job, not yours.
            </p>

            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <Link
                href="/openclaw-earn"
                className="group inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm hover:bg-orange-600 active:translate-y-px transition-all"
              >
                <span>[ Start earning ]</span>
                <IconArrow size={14} className="group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link
                href="/how-unbrowse-pays"
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all"
              >
                Mining quickstart
              </Link>
            </div>

            <p className="mt-4 text-xs font-mono text-[rgba(255,122,32,0.55)]">
              <span className="text-[rgba(255,176,96,0.85)]">$</span> Set up Crossmint lobster.cash during <code>npx unbrowse setup</code> to wire the payout address.
            </p>
          </div>

          <div className="lg:col-span-2 bg-[#060402] border border-[rgba(255,122,32,0.25)] rounded-sm p-5">
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-4">
              Receipt strip
            </p>
            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2 text-text-secondary leading-relaxed">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0 mt-1" />
                <span>x402-style flow, settled in USDC on Solana via Faremeter Flex.</span>
              </div>
              <div className="flex items-start gap-2 text-text-secondary leading-relaxed">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0 mt-1" />
                <span>Capture + indexing are free. You earn when another agent reuses your cached route.</span>
              </div>
              <div className="flex items-start gap-2 text-text-secondary leading-relaxed">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0 mt-1" />
                <span>Sponsor tier covers $1/day per agent and $50/day per platform; past that, agents fall through to their own wallet.</span>
              </div>
              <div className="flex items-start gap-2 text-text-secondary leading-relaxed">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0 mt-1" />
                <span>Payout to bank via Crossmint lobster.cash, set up in one step.</span>
              </div>
              <div className="flex items-start gap-2 text-text-secondary leading-relaxed">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0 mt-1" />
                <span>Public ledger at <Link href="/leaderboard" className="underline decoration-[rgba(255,122,32,0.4)] hover:text-[rgba(255,176,96,1)]">/leaderboard</Link> shows real routes, real wallets, real USDC.</span>
              </div>
            </div>
            <div className="mt-5 pt-4 border-t border-[rgba(255,122,32,0.15)] text-[11px] font-mono text-text-muted">
              Asked for repeatedly on r/AI_Agents, r/SaaS, r/CryptoCurrency, r/ethdev. Trace in /docs/POSITIONING.md.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
