"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  subscribeAuthInvalid,
  type AuthInvalidDetail,
} from "@/lib/auth-invalid-event";

// Listens for the unbrowse:auth-invalid event dispatched by lib/api.ts,
// lib/account-client.ts, and the billing pages when the backend returns 401
// `all_keys_rotated`. Renders a fixed-top banner with a /login CTA on every
// route, so a user who lands on any page during a rotation can recover
// without having to know that /login mints a new key.
export function AuthInvalidGlobalBanner() {
  const [detail, setDetail] = useState<AuthInvalidDetail | null>(null);

  useEffect(() => {
    return subscribeAuthInvalid((d) => {
      setDetail(d);
    });
  }, []);

  if (!detail) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="auth-invalid-global-banner"
      className="fixed top-0 inset-x-0 z-50 border-b border-border bg-surface-raised text-text-primary shadow-md"
    >
      <div className="mx-auto max-w-5xl px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">Your API key is no longer valid. </span>
          <span className="text-text-secondary">{detail.message}</span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link
            href="/login?reason=key_rotated"
            className="inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-text-primary text-surface text-xs font-medium hover:opacity-90"
          >
            Sign in to mint a new key
          </Link>
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="inline-flex items-center justify-center px-3 py-1.5 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
