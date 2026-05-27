"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { getConfiguredApiOrigin } from "@/lib/api-base";

type SubState =
  | { status: "none" }
  | {
      status: string;
      subscriptionId?: string;
      priceId?: string;
      currentPeriodStart?: number;
      currentPeriodEnd?: number;
      cancelAtPeriodEnd?: boolean;
      quota?: number;
      overageAllowed?: boolean;
    }
  | { error: string };

const API_URL = getConfiguredApiOrigin();

export default function BillingPage() {
  const { apiKey, isAuthenticated } = useAuth();
  const [sub, setSub] = useState<SubState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/v1/billing/me`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => r.json() as Promise<SubState>)
      .then(setSub)
      .catch((err) => setSub({ error: String(err) }));
  }, [apiKey]);

  async function startCheckout() {
    if (!apiKey) return;
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/v1/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ return_url: `${window.location.origin}/billing/success` }),
      });
      const body = (await r.json()) as { url?: string; error?: string };
      if (body.url) window.location.href = body.url;
      else alert(body.error ?? "Failed to start checkout");
    } finally {
      setLoading(false);
    }
  }

  async function openPortal() {
    if (!apiKey) return;
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/v1/billing/portal`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const body = (await r.json()) as { url?: string; error?: string };
      if (body.url) window.location.href = body.url;
      else alert(body.error ?? "No customer record yet");
    } finally {
      setLoading(false);
    }
  }

  const active =
    sub && "status" in sub && (sub.status === "active" || sub.status === "trialing");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">
        Billing
      </h1>
      <p className="text-sm text-text-secondary mb-8 max-w-[70ch]">
        Pay for skill execution with a subscription. Your API key authorizes calls
        without the Privy wallet step.
      </p>

      {!isAuthenticated && (
        <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-secondary">
          No API key found. Generate one on the home page first.
        </div>
      )}

      {isAuthenticated && !sub && (
        <div className="text-sm text-text-muted">Loading subscription status...</div>
      )}

      {sub && "error" in sub && (
        <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-primary font-mono">
          {sub.error}
        </div>
      )}

      {sub && "status" in sub && sub.status === "none" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-secondary">
            Plan: none. Subscribe to skip the Privy wallet flow.
          </div>
          <button
            onClick={startCheckout}
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-text-primary text-surface text-sm font-medium
                       hover:opacity-90 active:scale-[0.98] transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Loading..." : "Subscribe"}
          </button>
        </div>
      )}

      {active && sub && "status" in sub && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-text-muted">Plan</span>
              <span className="text-text-primary font-mono">{sub.status}</span>
            </div>
            {typeof sub.quota === "number" && (
              <div className="flex justify-between">
                <span className="text-text-muted">Monthly quota</span>
                <span className="text-text-primary font-mono">{sub.quota}</span>
              </div>
            )}
            {sub.currentPeriodEnd && (
              <div className="flex justify-between">
                <span className="text-text-muted">Renews</span>
                <span className="text-text-primary font-mono">
                  {new Date(sub.currentPeriodEnd * 1000).toLocaleDateString()}
                </span>
              </div>
            )}
            {sub.cancelAtPeriodEnd && (
              <div className="text-text-secondary">Cancels at period end.</div>
            )}
            {sub.overageAllowed && (
              <div className="text-text-muted">Overage enabled (metered).</div>
            )}
          </div>
          <button
            onClick={openPortal}
            disabled={loading}
            className="px-5 py-2.5 rounded-lg border border-border bg-surface text-sm font-medium
                       text-text-primary hover:bg-surface-raised transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Loading..." : "Manage subscription"}
          </button>
        </div>
      )}
    </main>
  );
}
