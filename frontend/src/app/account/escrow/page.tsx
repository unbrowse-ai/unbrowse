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
  escrowAddress,
  walletAddress,
  facilitator,
}: {
  escrowAddress: string | null;
  walletAddress: string | null;
  facilitator: string | null;
}) {
  const funded = Boolean(escrowAddress && escrowAddress.length > 0);
  const explorerUrl = funded
    ? `https://solscan.io/account/${escrowAddress}`
    : null;
  return (
    <Card title="Current status">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            funded
              ? "bg-text-primary text-surface"
              : "border border-border bg-surface text-text-muted"
          }`}
        >
          {funded ? "✓" : ""}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-text-primary">
            {funded ? "Escrow funded" : "Not funded"}
          </div>
          {funded ? (
            <>
              <div className="text-text-muted font-mono text-xs break-all">
                {escrowAddress}
              </div>
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-text-primary hover:text-text-secondary underline"
                >
                  View on Solscan ↗
                </a>
              )}
              {facilitator && (
                <div className="text-text-muted text-xs">
                  Facilitator: <span className="font-mono">{facilitator}</span>
                </div>
              )}
            </>
          ) : (
            <div className="text-text-muted text-xs">
              {walletAddress
                ? "Wallet paired. Run the funding command below to create + deposit into the escrow PDA."
                : "Pair a wallet first, then fund the escrow."}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function EscrowPage() {
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
            Fund your Flex escrow
          </h1>
          <p className="text-sm text-text-secondary">
            Sign in first to fund a Flex escrow for x402 settlement.
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

  const walletPaired = Boolean(
    me?.wallet_address && me.wallet_address.length > 0,
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
          Fund your Flex escrow
        </h1>
        <p className="text-sm text-text-secondary">
          Your Flex escrow is a prepaid USDC balance held in a program-derived
          account (PDA) on Solana. Paid executes draw from this balance and
          settle to creators atomically.
        </p>
      </header>

      <StatusRow
        escrowAddress={me?.flex_escrow_address ?? null}
        walletAddress={me?.wallet_address ?? null}
        facilitator={me?.flex_facilitator ?? null}
      />

      {error && (
        <Card>
          <p className="text-sm text-text-secondary">{error}</p>
        </Card>
      )}

      {!walletPaired && (
        <Card title="Pair a wallet first">
          <p className="text-sm text-text-secondary">
            Your wallet isn't paired yet. The escrow is funded from your
            wallet, so pairing has to happen first.
          </p>
          <Link
            href="/account/wallet"
            className="inline-block px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-all"
          >
            Pair wallet →
          </Link>
        </Card>
      )}

      <Card title="Fund via CLI (recommended)">
        <p className="text-sm text-text-secondary">
          Funds $5.00 USDC into the escrow PDA owned by your wallet. The
          default amount is plenty for several thousand resolve+execute calls
          at marketplace prices.
        </p>
        <CodeBlock>unbrowse setup --fund-escrow 5.00</CodeBlock>
        <p className="text-xs text-text-muted">
          Smaller deposits work too — pass any USDC amount (minimum $0.10).
          You can top up later with the same command.
        </p>
      </Card>

      <Card title="Fund via SDK">
        <p className="text-sm text-text-secondary">
          If you're integrating Unbrowse from code, use the SDK directly. The
          amount is in micro-USDC (1_000_000 µ¢ = $1).
        </p>
        <CodeBlock>
          {`import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = Unbrowse.spawn({ apiKey: process.env.UNBROWSE_API_KEY });
await unbrowse.fundEscrow({ amountUsdc: "5000000" });`}
        </CodeBlock>
      </Card>

      <Card title="Next step">
        <p className="text-sm text-text-secondary">
          After funding, register a session key so off-chain payment
          authorizations can be signed without your main wallet key.
        </p>
        <Link
          href="/account/session-key"
          className="inline-block px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-all"
        >
          Register session key →
        </Link>
      </Card>
    </main>
  );
}
