"use client";

/* Subscribe button — starts the LIVE Aiko early-bird checkout ($100/mo, charged
 * upfront). POSTs to /api/aiko-checkout, which creates a Stripe Checkout Session
 * server-side, then redirects the browser to the hosted Stripe page. */

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

export function SubscribeButton({ label }: { label: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/aiko-checkout", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) {
        window.location.href = data.url;
        return; // navigating away; keep the spinner
      }
      setError(data.error ?? "Checkout is unavailable right now. Please try again.");
    } catch {
      setError("Could not start checkout. Please try again.");
    }
    setLoading(false);
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: "0.4rem" }}>
      <button className="aiko-cta" onClick={start} disabled={loading} style={{ border: "none", cursor: loading ? "wait" : "pointer" }}>
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting checkout</> : <>{label} <ArrowRight className="w-4 h-4" /></>}
      </button>
      {error && <span style={{ color: "var(--a-accent-warm)", fontSize: "0.8rem" }}>{error}</span>}
    </span>
  );
}
