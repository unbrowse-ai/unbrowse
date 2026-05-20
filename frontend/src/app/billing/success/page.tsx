"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { getConfiguredApiOrigin } from "@/lib/api-base";
import { checkAuthInvalidResponse } from "@/lib/auth-invalid-event";

const API_URL = getConfiguredApiOrigin();

export default function BillingSuccessPage() {
  const { apiKey } = useAuth();
  const [status, setStatus] = useState<string>("Confirming subscription...");

  useEffect(() => {
    if (!apiKey) {
      setStatus("No API key found. Visit /billing to subscribe.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/v1/billing/success`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (await checkAuthInvalidResponse(res)) {
          if (!cancelled) setStatus("Your API key was rotated. Sign in to mint a new one.");
          return;
        }
        const body = (await res.json()) as { status?: string };
        if (cancelled) return;
        if (body?.status === "active" || body?.status === "trialing") {
          setStatus("Subscription active. Redirecting...");
          setTimeout(() => {
            window.location.href = "/billing";
          }, 1000);
        } else {
          setStatus(
            `Status: ${body?.status ?? "pending"}. Webhooks may still be processing.`
          );
          setTimeout(() => {
            window.location.href = "/billing";
          }, 3000);
        }
      } catch (err) {
        if (!cancelled) setStatus(`Sync failed: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-text-primary mb-4">
        Billing
      </h1>
      <p className="text-sm text-text-secondary">{status}</p>
    </main>
  );
}
