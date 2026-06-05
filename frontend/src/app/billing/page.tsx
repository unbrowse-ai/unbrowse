"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { getConfiguredApiOrigin } from "@/lib/api-base";

// Per-request x402 model — no subscriptions. Discovery + internal-API routing are
// free; paid execution settles over x402 (Solana/USDC) as a fair three-way split
// (indexer, domain owner, platform). A sponsor tier covers a free allowance from
// the platform vault; beyond it, the agent's own wallet (e.g. lobster.cash) pays
// per request. This page reflects that — it does NOT sell a monthly plan.
type SponsorState =
  | { sponsored?: boolean; remaining_uc?: number; cap_uc?: number; used_uc?: number; mode?: string }
  | { error: string };

const API_URL = getConfiguredApiOrigin();
const fmtUsd = (uc?: number) => (typeof uc === "number" ? `$${(uc / 1_000_000).toFixed(4)}` : "—");

export default function BillingPage() {
  const { apiKey, isAuthenticated } = useAuth();
  const [s, setS] = useState<SponsorState | null>(null);

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${API_URL}/v1/account/sponsor-status`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => r.json() as Promise<SponsorState>)
      .then(setS)
      .catch((err) => setS({ error: String(err) }));
  }, [apiKey]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">
        Payments
      </h1>
      <p className="text-sm text-text-secondary mb-8 max-w-[70ch]">
        You pay <strong>per request</strong>, not by subscription. Discovery and
        internal-API routing are free; paid execution settles over <strong>x402</strong>{" "}
        in USDC as a fair split between the indexer who captured the route, the
        domain owner, and the platform. Fund an agent wallet (we recommend{" "}
        <a href="https://lobster.cash" className="underline">lobster.cash</a>) and it
        pays each request automatically — no card, no monthly plan.
      </p>

      {!isAuthenticated && (
        <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-secondary">
          No API key found. Generate one on the home page first.
        </div>
      )}

      {isAuthenticated && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm space-y-2">
            <div className="text-text-primary font-medium mb-1">Free allowance (sponsor tier)</div>
            {!s && <div className="text-text-muted">Loading…</div>}
            {s && "error" in s && <div className="font-mono text-text-primary">{s.error}</div>}
            {s && !("error" in s) && (
              <>
                <div className="flex justify-between"><span className="text-text-muted">Sponsored</span><span className="font-mono text-text-primary">{s.sponsored ? "yes" : "no"}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Remaining (free)</span><span className="font-mono text-text-primary">{fmtUsd(s.remaining_uc)}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Used</span><span className="font-mono text-text-primary">{fmtUsd(s.used_uc)}</span></div>
              </>
            )}
            <p className="text-text-muted pt-2">
              When the free allowance runs out, requests are paid per-call from your
              x402 wallet. Nothing to manage here — fund the wallet and go.
            </p>
          </div>

          <div className="flex gap-3">
            <a href="https://lobster.cash" className="px-5 py-2.5 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-opacity duration-200">
              Set up a wallet
            </a>
            <a href="/how-unbrowse-pays" className="px-5 py-2.5 rounded-lg border border-border bg-surface text-sm font-medium text-text-primary hover:bg-surface-raised transition-colors duration-200">
              How payment works
            </a>
          </div>
        </div>
      )}
    </main>
  );
}
