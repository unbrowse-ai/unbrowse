"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  AccountClientError,
  fetchMe,
  type AccountMe,
} from "@/lib/account-client";

function isRegisterRequired(err: unknown): boolean {
  return err instanceof AccountClientError && err.status === 403;
}

function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface-sunken p-5 space-y-3">
      {title && (
        <h2 className="text-sm font-medium text-text-primary">{title}</h2>
      )}
      {children}
    </section>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="rounded-lg border border-border bg-surface p-3 text-xs font-mono text-text-primary overflow-x-auto whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function StatusRow({
  sessionKeyAddress,
  escrowAddress,
}: {
  sessionKeyAddress: string | null;
  escrowAddress: string | null;
}) {
  const registered = Boolean(
    sessionKeyAddress && sessionKeyAddress.length > 0,
  );
  return (
    <Card title="Current status">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            registered
              ? "bg-text-primary text-surface"
              : "border border-border bg-surface text-text-muted"
          }`}
        >
          {registered ? "✓" : ""}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-text-primary">
            {registered ? "Session key registered" : "Not registered"}
          </div>
          {registered ? (
            <div className="text-text-muted font-mono text-xs break-all">
              {sessionKeyAddress}
            </div>
          ) : (
            <div className="text-text-muted text-xs">
              {escrowAddress
                ? "Escrow funded. Register a session key to start signing paid requests."
                : "Fund the escrow first, then register a session key."}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function SessionKeyPage() {
  const { isAuthenticated, apiKey } = useAuth();
  const [me, setMe] = useState<AccountMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    fetchMe(apiKey)
      .then((res) => {
        if (!cancelled) setMe(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isRegisterRequired(err)) {
          setError(
            "Your API key is not bound to an account. Run `unbrowse register --email you@example.com`.",
          );
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  if (!isAuthenticated || !apiKey) {
    return (
      <main className="mx-auto max-w-[70ch] px-6 py-16 space-y-6">
        <header>
          <Link
            href="/account"
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            ← Back to account
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
            Register a session key
          </h1>
          <p className="text-sm text-text-secondary">
            Sign in first to register a Flex session key.
          </p>
        </header>
        <Link
          href="/login"
          className="inline-block rounded-2xl bg-text-primary text-surface px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          Sign in with email
        </Link>
      </main>
    );
  }

  const escrowFunded = Boolean(
    me?.flex_escrow_address && me.flex_escrow_address.length > 0,
  );

  return (
    <main className="mx-auto max-w-[70ch] px-6 py-16 space-y-6">
      <header>
        <Link
          href="/account"
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          ← Back to account
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
          Register a session key
        </h1>
        <p className="text-sm text-text-secondary">
          A session key is an Ed25519 keypair the local Unbrowse client uses
          to sign payment authorizations off-chain. Your main wallet key never
          touches a paid request — the session key is scoped to your escrow
          and revocable on demand.
        </p>
      </header>

      <StatusRow
        sessionKeyAddress={me?.flex_session_key_address ?? null}
        escrowAddress={me?.flex_escrow_address ?? null}
      />

      {error && (
        <Card>
          <p className="text-sm text-text-secondary">{error}</p>
        </Card>
      )}

      {!escrowFunded && (
        <Card title="Fund the escrow first">
          <p className="text-sm text-text-secondary">
            Session keys authorize spends against your Flex escrow. Without a
            funded escrow there's nothing to sign against.
          </p>
          <Link
            href="/account/escrow"
            className="inline-block px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-opacity duration-200"
          >
            Fund escrow →
          </Link>
        </Card>
      )}

      <Card title="Register via CLI (recommended)">
        <p className="text-sm text-text-secondary">
          Generates a fresh keypair locally, stores the private half in your
          OS keychain, and submits the public address as the active session
          key for your escrow.
        </p>
        <CodeBlock>unbrowse setup --register-session-key</CodeBlock>
        <p className="text-xs text-text-muted">
          The private key never leaves your machine. Rotate it any time by
          running the same command again — the previous key is revoked
          atomically.
        </p>
      </Card>

      <Card title="Register via SDK">
        <p className="text-sm text-text-secondary">
          If you generated the keypair yourself, pass the public address to
          the SDK.
        </p>
        <CodeBlock>
          {`import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = Unbrowse.spawn({ apiKey: process.env.UNBROWSE_API_KEY });
await unbrowse.registerSessionKey({
  sessionKeyAddress: "<base58-ed25519-pubkey>",
});`}
        </CodeBlock>
      </Card>

      <Card title="You're done">
        <p className="text-sm text-text-secondary">
          Once the session key is registered, paid endpoints settle
          automatically. Head back to the account dashboard to verify all
          three steps are complete.
        </p>
        <Link
          href="/account"
          className="inline-block px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-opacity duration-200"
        >
          Back to account →
        </Link>
      </Card>
    </main>
  );
}
