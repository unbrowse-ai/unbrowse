"use client";

/* Aiko waitlist email capture — posts to the same-origin /api/aiko-waitlist
 * route (state pattern mirrors src/components/api-key-generator.tsx). For
 * people who want the early-bird but aren't ready to subscribe today. */

import { useState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function AikoWaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setError("That email does not look right. Mind checking it?");
      setStatus("error");
      return;
    }
    setError(null);
    setStatus("loading");
    try {
      const res = await fetch("/api/aiko-waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Something went wrong. Try again in a moment.");
      }
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="aiko-card" style={{
        display: "flex", alignItems: "center", gap: "0.75rem",
        border: "1px solid var(--a-border-strong)", borderRadius: "0.8rem",
        background: "var(--a-card-2)", padding: "1.1rem 1.25rem",
      }}>
        <span style={{
          width: "1.9rem", height: "1.9rem", borderRadius: "50%", flexShrink: 0,
          background: "var(--a-accent)", color: "var(--a-accent-ink)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          <Check className="w-4 h-4" strokeWidth={3} />
        </span>
        <p style={{ margin: 0, color: "var(--a-ink)", fontSize: "0.97rem" }}>
          You&apos;re on the list. We&apos;ll email you when your early-bird seat opens.
        </p>
      </div>
    );
  }

  const loading = status === "loading";

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (status === "error") setStatus("idle"); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="you@work.com"
          aria-label="Email address"
          style={{
            flex: "1 1 14rem", minWidth: 0,
            padding: "0.85rem 1rem", borderRadius: "0.7rem",
            background: "var(--a-bg-2)", border: "1px solid var(--a-border-strong)",
            color: "var(--a-ink)", fontSize: "0.97rem", outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={loading || !email.trim()}
          className="aiko-cta"
          style={{ border: "none", cursor: loading ? "wait" : "pointer", opacity: loading || !email.trim() ? 0.6 : 1 }}
        >
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving</> : <>Join the waitlist <ArrowRight className="w-4 h-4" /></>}
        </button>
      </div>
      {error && (
        <p style={{ margin: "0.6rem 0 0", color: "var(--a-accent-warm)", fontSize: "0.85rem" }}>{error}</p>
      )}
    </div>
  );
}
