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
  walletAddress,
  walletProvider,
}: {
  walletAddress: string | null;
  walletProvider: string | null;
}) {
  const paired = Boolean(walletAddress && walletAddress.length > 0);
  return (
    <Card title="Current status">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            paired
              ? "bg-text-primary text-surface"
              : "border border-border bg-surface text-text-muted"
          }`}
        >
          {paired ? "✓" : ""}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-text-primary">
            {paired ? "Wallet paired" : "Not paired"}
          </div>
          {paired ? (
            <>
              <div className="text-text-muted font-mono text-xs break-all">
                {walletAddress}
              </div>
              {walletProvider && (
                <div className="text-text-muted text-xs">
                  Provider: {walletProvider}
                </div>
              )}
            </>
          ) : (
            <div className="text-text-muted text-xs">
              Pair a Solana wallet to settle USDC payments on Flex.
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function WalletPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Pair your wallet
        </h1>
        <p className="text-sm text-text-secondary">
          Sign in first.{" "}
          <Link
            href="/login"
            className="text-text-primary hover:text-text-secondary underline"
          >
            /login
          </Link>
        </p>
      </main>
    );
  }

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
          Pair your wallet
        </h1>
        <p className="text-sm text-text-secondary">
          Unbrowse needs a Solana wallet to settle USDC payments through Flex.
          The wallet stays on your machine; we only store its public address.
        </p>
      </header>

      <StatusRow
        walletAddress={me?.wallet_address ?? null}
        walletProvider={me?.wallet_provider ?? null}
      />

      {error && (
        <Card>
          <p className="text-sm text-text-secondary">{error}</p>
        </Card>
      )}

      <Card title="Option 1 — lobster.cash (recommended)">
        <p className="text-sm text-text-secondary">
          lobster.cash is a developer-friendly custodial wallet that auto-funds
          your Flex escrow and signs session-key registrations. Easiest path
          for first-time users.
        </p>
        <ol className="space-y-2 text-sm text-text-secondary list-decimal pl-4">
          <li>
            Create an account at{" "}
            <a
              href="https://lobster.cash"
              target="_blank"
              rel="noreferrer"
              className="text-text-primary hover:text-text-secondary underline"
            >
              lobster.cash
            </a>
            .
          </li>
          <li>
            Install the Lobster CLI and run setup:
            <CodeBlock>npx @crossmint/lobster-cli setup</CodeBlock>
          </li>
          <li>
            Pair the wallet to your Unbrowse account:
            <CodeBlock>unbrowse setup --pair-wallet</CodeBlock>
          </li>
        </ol>
      </Card>

      <Card title="Option 2 — bring your own Solana wallet">
        <p className="text-sm text-text-secondary">
          If you already manage a Solana wallet (Phantom, Solflare, Backpack,
          or a raw keypair), pair it directly by passing its public address to{" "}
          <code className="font-mono text-text-primary">unbrowse setup</code>.
        </p>
        <ol className="space-y-2 text-sm text-text-secondary list-decimal pl-4">
          <li>
            Export your wallet's public address (base58).
          </li>
          <li>
            Set it in the environment, then pair:
            <CodeBlock>
              {`export AGENT_WALLET_ADDRESS=<your-base58-pubkey>
unbrowse setup --wallet-address $AGENT_WALLET_ADDRESS`}
            </CodeBlock>
          </li>
          <li>
            You stay custodian. Unbrowse never sees your private key.
          </li>
        </ol>
      </Card>

      <Card title="Next step">
        <p className="text-sm text-text-secondary">
          After pairing, fund your Flex escrow.
        </p>
        <Link
          href="/account/escrow"
          className="inline-block px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-all"
        >
          Fund escrow →
        </Link>
      </Card>
    </main>
  );
}
