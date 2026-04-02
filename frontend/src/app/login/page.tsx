"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, ArrowRightLeft, WalletCards } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { getCurrentTos, type CurrentTos } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const { isAuthenticated, register, loginWithApiKey } = useAuth();
  const [tos, setTos] = useState<CurrentTos | null>(null);
  const [registerName, setRegisterName] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState<"register" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) router.replace("/dashboard");
  }, [isAuthenticated, router]);

  useEffect(() => {
    getCurrentTos().then(setTos).catch(() => setTos(null));
  }, []);

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tos) {
      setError("Terms metadata unavailable. Retry in a moment.");
      return;
    }
    setBusy("register");
    setError(null);
    try {
      await register(registerName.trim(), tos.version);
      router.push("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("import");
    setError(null);
    try {
      await loginWithApiKey(apiKeyInput);
      router.push("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,109,0,0.18),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(255,109,0,0.1),transparent_30%)]" />
      <div className="max-w-6xl mx-auto grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="relative rounded-[32px] border border-border bg-surface-raised p-8 sm:p-10 orange-glow">
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.22em] text-orange-500">
            Agent Identity
          </div>
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
            Log into your economics surface.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-text-secondary">
            Dashboard data is bound to the agent key. Register a fresh agent for this browser, or paste an existing API key to recover its spend, earnings, and rank.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <InfoPill icon={<WalletCards className="h-4 w-4" />} title="Money" copy="Graph fees, creator payouts, attribution credits." />
            <InfoPill icon={<ArrowRightLeft className="h-4 w-4" />} title="Savings" copy="Real time and cost fields only. No estimates in the dashboard." />
            <InfoPill icon={<KeyRound className="h-4 w-4" />} title="Key-bound" copy="One dashboard per agent key. Import to continue an existing account." />
          </div>

          {tos && (
            <div className="mt-8 rounded-3xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">Current Terms</p>
                  <p className="mt-1 text-sm text-text-secondary">Version {tos.version}</p>
                </div>
                <a
                  href={tos.url}
                  target="_blank"
                  rel="noopener"
                  className="rounded-xl border border-orange-500/20 px-4 py-2 text-sm font-medium text-orange-500 transition-colors hover:border-orange-500/40 hover:bg-orange-500/10"
                >
                  Read full terms
                </a>
              </div>
              <p className="mt-4 text-sm leading-6 text-text-secondary">{tos.summary}</p>
            </div>
          )}

          {error && (
            <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </section>

        <section className="grid gap-6">
          <form onSubmit={handleRegister} className="rounded-[28px] border border-border bg-surface p-7">
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">Register New Agent</p>
            <h2 className="mt-3 text-2xl font-semibold">Create a local web account</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Generates a fresh agent key and stores it in this browser only.
            </p>
            <label className="mt-6 block text-sm font-medium text-text-secondary">
              Agent name
              <input
                value={registerName}
                onChange={(event) => setRegisterName(event.target.value)}
                placeholder="lewis@unbrowse.ai"
                className="mt-2 w-full rounded-2xl border border-border bg-surface-sunken px-4 py-3 text-text-primary outline-none transition-colors focus:border-orange-500/40"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null || !registerName.trim() || !tos}
              className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-orange-500 px-5 py-3 font-semibold text-white transition-all hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "register" ? "Creating agent..." : "Register agent"}
            </button>
          </form>

          <form onSubmit={handleImport} className="rounded-[28px] border border-border bg-surface p-7">
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">Import Existing Agent</p>
            <h2 className="mt-3 text-2xl font-semibold">Paste an existing API key</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Use this when the agent already exists and you want its dashboard, savings telemetry, and leaderboard rank.
            </p>
            <label className="mt-6 block text-sm font-medium text-text-secondary">
              API key
              <textarea
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                rows={5}
                placeholder="ubr_live_..."
                className="mt-2 w-full rounded-2xl border border-border bg-surface-sunken px-4 py-3 font-mono text-sm text-text-primary outline-none transition-colors focus:border-orange-500/40"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null || !apiKeyInput.trim()}
              className="mt-6 inline-flex w-full items-center justify-center rounded-2xl border border-orange-500/20 bg-orange-500/10 px-5 py-3 font-semibold text-orange-500 transition-all hover:border-orange-500/40 hover:bg-orange-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "import" ? "Verifying key..." : "Import key"}
            </button>
          </form>

          <div className="rounded-[28px] border border-border bg-surface-sunken p-7">
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">Public Surface</p>
            <h2 className="mt-3 text-2xl font-semibold">Want the network board first?</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              The public leaderboard is readable without login. Log in only when you want personal spend, earnings, savings, and settings.
            </p>
            <Link
              href="/leaderboard"
              className="mt-6 inline-flex items-center gap-2 rounded-2xl border border-border px-5 py-3 font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
            >
              Open leaderboard
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function InfoPill({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-4">
      <div className="flex items-center gap-2 text-orange-500">{icon}<span className="text-sm font-semibold text-text-primary">{title}</span></div>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{copy}</p>
    </div>
  );
}
