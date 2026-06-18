"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ClaimClientError,
  getEarnings,
  type EarningsResult,
} from "@/lib/claim-client";

// How Unbrowse pays — the money page, read honestly to a crypto skeptic.
//
// The story in plain terms: real usage settles in USDC, per request, no
// subscription. Every paid call is split between the people who do the work —
// the indexer who found the route, the site owner, and the platform. A separate
// trust token only bonds accountable maintenance; you never need it to use or
// get paid by Unbrowse. The earnings panel below reads the real
// /v1/claim/earnings endpoint (a mirror of on-chain settlement) — it never
// shows a projection dressed up as actuals.

// ---------------------------------------------------------------------------
// The split (who pays -> who earns). Percentages are the public 50/35/15 split;
// no internal code constants or backend file paths are surfaced here.
// ---------------------------------------------------------------------------

const SPLIT = [
  {
    who: "Indexer",
    share: 35,
    note: "The contributor who captured and maintains the route. Shared across everyone who keeps it working.",
    bar: "bg-azure-500",
  },
  {
    who: "Platform",
    share: 50,
    note: "Runs the resolve/execute infrastructure and the settlement rails.",
    bar: "bg-text-secondary",
  },
  {
    who: "Site owner",
    share: 15,
    note: "Paid to the wallet bound to the domain — only when a verified owner has claimed it. Unclaimed, this folds into the indexer pool.",
    bar: "bg-orange-500",
  },
] as const;

function SplitBar() {
  return (
    <div className="space-y-4">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {SPLIT.map((s) => (
          <div
            key={s.who}
            className={s.bar}
            style={{ width: `${s.share}%` }}
            aria-hidden
          />
        ))}
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {SPLIT.map((s) => (
          <li
            key={s.who}
            className="space-y-1 rounded-xl border border-border bg-surface p-4"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-text-primary">
                {s.who}
              </span>
              <span className="font-mono text-sm text-text-secondary">
                {s.share}%
              </span>
            </div>
            <p className="text-xs leading-relaxed text-text-muted">{s.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real earnings reader. Reads GET /v1/claim/earnings for a domain. Every number
// shown here is a real read of on-chain settlement; nothing is projected.
// ---------------------------------------------------------------------------

function EarningsReader() {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EarningsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCheck(e: React.FormEvent) {
    e.preventDefault();
    if (!domain.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await getEarnings(domain.trim());
      setResult(r);
    } catch (err) {
      if (err instanceof ClaimClientError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface-raised p-6">
      <header className="space-y-1">
        <h2 className="text-xl font-medium text-text-primary">
          Check what a domain has earned
        </h2>
        <p className="text-sm text-text-secondary">
          A live read of on-chain settlement, keyed by domain. The owner share is
          already paid to the wallet on-chain — this is a mirror of that record,
          not a balance to withdraw.
        </p>
      </header>

      <form onSubmit={onCheck} className="flex flex-col gap-3 sm:flex-row">
        <input
          name="earnings-domain"
          type="text"
          inputMode="url"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-orange-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !domain.trim()}
          className="shrink-0 rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {busy ? "Reading..." : "Read earnings"}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm text-text-primary">
          Could not read earnings: {error}
        </div>
      )}

      {result && !result.verified && (
        <div className="rounded-lg border border-border bg-surface-sunken p-4 text-sm text-text-secondary">
          No verified owner wallet is bound to that domain yet, so there is
          nothing to read. Bind a wallet on the{" "}
          <Link href="/claim" className="underline hover:text-text-primary">
            claim page
          </Link>{" "}
          first; the owner share then settles to it on every paid call.
        </div>
      )}

      {result && result.verified && (
        <div className="space-y-4 rounded-lg border border-azure-400 bg-azure-50 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-text-muted">
              Real on-chain settlement · {result.domain}
            </span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              live read
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-2xl font-semibold text-text-primary">
                ${result.earned_usd}
              </p>
              <p className="text-xs text-text-muted">USDC settled to the owner</p>
            </div>
            {typeof result.payout_count === "number" && (
              <div>
                <p className="text-2xl font-semibold text-text-primary">
                  {result.payout_count}
                </p>
                <p className="text-xs text-text-muted">payouts</p>
              </div>
            )}
            {result.pending_usd && result.pending_usd !== "0.00" && (
              <div>
                <p className="text-2xl font-semibold text-text-primary">
                  ${result.pending_usd}
                </p>
                <p className="text-xs text-text-muted">pending settlement</p>
              </div>
            )}
          </div>
          {result.last_settled_at && (
            <p className="text-xs text-text-muted">
              Last settled {new Date(result.last_settled_at).toLocaleString()}
              {result.last_tx ? (
                <>
                  {" · "}
                  <code className="break-all font-mono">{result.last_tx}</code>
                </>
              ) : null}
            </p>
          )}
          {result.earned_usd === "0.00" &&
            (!result.payout_count || result.payout_count === 0) && (
              <p className="text-xs text-text-muted">
                This domain is bound but has not been paid yet. The number will
                move the first time a paid call hits a route on it.
              </p>
            )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HowUnbrowsePays() {
  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-16">
      <header className="space-y-4">
        <Link
          href="/"
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          ← Home
        </Link>
        <span className="eyebrow" style={{ display: "block" }}>Economics</span>
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
          How Unbrowse Pays
        </h1>
        <p className="max-w-[60ch] text-base text-text-secondary">
          The short version: you pay for real usage in USDC, per request, and the
          money is split between the people who did the work. No subscription, no
          coin to buy, no investment pitch.
        </p>
      </header>

      {/* USDC settles usage — plain. */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium text-text-primary">
          You pay for usage, in USDC
        </h2>
        <p className="text-sm leading-relaxed text-text-secondary">
          Discovery is free: resolving an intent, searching cached endpoints, or
          reading a route graph costs nothing. The only billed step is execution —
          when a workflow actually runs a captured route on your behalf, that one
          call settles in USDC over x402. You pay per request, only for requests
          that execute. There is no monthly plan to cancel and no balance to
          top up.
        </p>
      </section>

      {/* The split — who pays -> who earns, as a visual. */}
      <section className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-xl font-medium text-text-primary">
            Who pays, who earns
          </h2>
          <p className="text-sm text-text-secondary">
            An agent (or its owner) pays for a call. That single payment is split
            on-chain at settlement time between three roles:
          </p>
        </div>
        <SplitBar />
        <p className="text-xs text-text-muted">
          A paid call against a domain with a verified owner settles 50 / 35 / 15
          to platform, indexer pool, and site owner. With no owner bound, the
          owner&rsquo;s share folds back into the indexer pool — nothing is held
          back.
        </p>
      </section>

      {/* Real earnings read. */}
      <EarningsReader />

      {/* The token — de-emphasised, honest. */}
      <section className="space-y-3 border-l-2 border-border pl-5">
        <h2 className="text-base font-medium text-text-secondary">
          About the trust token
        </h2>
        <p className="text-sm leading-relaxed text-text-muted">
          There is a separate token that <em>bonds accountable maintenance</em> —
          it is collateral that route maintainers stake so a broken route has a
          cost, not a currency you buy and not an investment. You never need to
          hold it to use Unbrowse or to get paid as a site owner: usage settles in
          USDC, full stop. Nothing on this page is an offer, a solicitation, or a
          promise of profit.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium text-text-primary">The papers behind this</h2>
        <p className="text-sm leading-relaxed text-text-muted">
          This page is the short version. The economics — proof of indexing, bonded,
          slashable maintenance, trust tiers, and delta-based attribution — are laid out
          in{" "}
          <a href="/unbrowse-maintenance-network.pdf" target="_blank" rel="noopener" className="underline hover:text-text-secondary">
            Unbrowse Maintenance Network
          </a>
          . How your credentials stay private — bound to your wallet by zero-knowledge
          proof and revealed only under signature, content-addressed and sealed at every
          layer an agent touches — is in{" "}
          <a href="/crypto-was-all-you-needed.pdf" target="_blank" rel="noopener" className="underline hover:text-text-secondary">
            Crypto Was All You Needed
          </a>
          . All of them:{" "}
          <Link href="/papers" className="underline hover:text-text-secondary">/papers</Link>.
        </p>
      </section>

      <footer className="space-y-2 border-t border-border pt-6 text-xs text-text-muted">
        <p>
          Own a domain? You can{" "}
          <Link href="/claim" className="underline hover:text-text-secondary">
            bind a wallet and earn the owner share
          </Link>
          , or opt your domain out entirely.
        </p>
      </footer>
    </main>
  );
}
