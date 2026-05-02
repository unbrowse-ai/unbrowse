"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

type Phase = "idle" | "awaiting" | "error";

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { loginWithEmail, consumeMagicToken } = useAuth();

  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // If the user lands here from the verify-link flow, consume immediately.
  useEffect(() => {
    const tokenParam = searchParams.get("token");
    const signedIn = searchParams.get("signed_in");
    if (tokenParam && signedIn === "1") {
      setActiveToken(tokenParam);
      setPhase("awaiting");
    }
    // We deliberately read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll consumeMagicToken whenever we have an active token.
  useEffect(() => {
    if (phase !== "awaiting" || !activeToken) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let cancelled = false;
    consumeMagicToken(activeToken, { signal: ctrl.signal })
      .then(() => {
        if (cancelled) return;
        router.push("/dashboard");
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = (err as Error).message;
        if (msg === "aborted") return;
        setError(msg);
        setPhase("error");
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [phase, activeToken, consumeMagicToken, router]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setError(null);
      setSubmitting(true);
      try {
        const { token } = await loginWithEmail(email);
        setActiveEmail(email.trim());
        setActiveToken(token);
        setPhase("awaiting");
      } catch (err) {
        setError((err as Error).message);
        setPhase("error");
      } finally {
        setSubmitting(false);
      }
    },
    [email, submitting, loginWithEmail]
  );

  const handleResend = useCallback(async () => {
    if (!activeEmail || submitting) return;
    setError(null);
    setSubmitting(true);
    abortRef.current?.abort();
    try {
      const { token } = await loginWithEmail(activeEmail);
      setActiveToken(token);
      setPhase("awaiting");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  }, [activeEmail, submitting, loginWithEmail]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setActiveToken(null);
    setActiveEmail(null);
    setError(null);
    setPhase("idle");
  }, []);

  return (
    <div className="max-w-md mx-auto px-6 pt-32 pb-20">
      <div className="rounded-2xl border border-border bg-surface p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Sign in</h1>
          <p className="text-sm text-text-muted mt-2">
            Enter your email. We send a one-time link, no password.
          </p>
        </div>

        {phase === "idle" && (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form-idle">
            <label className="block text-xs font-mono uppercase tracking-wider text-text-muted">
              Email
              <input
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@domain.com"
                className="mt-2 block w-full rounded-xl border border-border bg-bg px-4 py-3
                           text-sm text-text-primary placeholder:text-text-muted
                           focus:border-orange-500/50 focus:outline-none transition-colors"
              />
            </label>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3
                         rounded-xl bg-orange-500 text-white font-semibold text-sm
                         hover:bg-orange-600 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Sending..." : "Send sign-in link"}
            </button>
          </form>
        )}

        {phase === "awaiting" && (
          <div className="space-y-5" data-testid="login-form-awaiting">
            <div className="rounded-xl border border-border bg-bg p-5">
              <p className="text-sm text-text-primary">
                Check your email
              </p>
              <p className="text-sm text-text-muted mt-2">
                We sent a sign-in link
                {activeEmail ? (
                  <>
                    {" to "}
                    <span className="font-mono text-text-secondary">{activeEmail}</span>
                  </>
                ) : null}
                . Click it to finish signing in. This page will update automatically.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleResend}
                disabled={submitting || !activeEmail}
                className="px-4 py-2.5 rounded-xl border border-border text-sm
                           text-text-secondary hover:text-text-primary hover:border-orange-500/30
                           transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Sending..." : "Resend link"}
              </button>
              <button
                onClick={reset}
                className="px-4 py-2.5 rounded-xl text-sm text-text-muted hover:text-text-primary
                           transition-colors"
              >
                Use a different email
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4" data-testid="login-form-error">
            <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4">
              <p className="text-sm text-red-400">{error ?? "Something went wrong."}</p>
            </div>
            <button
              onClick={reset}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3
                         rounded-xl border border-border text-sm text-text-primary
                         hover:border-orange-500/30 transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-border">
          <p className="text-xs text-text-muted">
            Already have an API key from the CLI?{" "}
            <Link href="/dashboard" className="text-orange-500 hover:underline">
              Open dashboard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="max-w-md mx-auto px-6 pt-32 pb-20" />}> 
      <LoginInner />
    </Suspense>
  );
}
