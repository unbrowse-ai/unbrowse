"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  AccountClientError,
  deleteSyncedCookieDomain,
  listSyncedCookieDomains,
  purgeCookieVault,
  type SyncedDomain,
} from "@/lib/account-client";

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

export default function CookieVaultPage() {
  const { isAuthenticated, apiKey } = useAuth();
  const [domains, setDomains] = useState<SyncedDomain[] | null>(null);
  const [vaultEnabled, setVaultEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  async function refresh() {
    if (!apiKey) return;
    try {
      const list = await listSyncedCookieDomains(apiKey);
      setDomains(list);
      setVaultEnabled(true);
    } catch (err) {
      if (err instanceof AccountClientError && err.status === 503) {
        setVaultEnabled(false);
        setDomains([]);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!apiKey) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  async function remove(domain: string) {
    if (!apiKey) return;
    setBusyDomain(domain);
    setError(null);
    try {
      await deleteSyncedCookieDomain(apiKey, domain);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyDomain(null);
    }
  }

  async function purgeAll() {
    if (!apiKey) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Purge the entire cookie vault for this account? Every synced domain's encrypted cookies will be deleted.",
      );
      if (!ok) return;
    }
    setPurging(true);
    setError(null);
    try {
      await purgeCookieVault(apiKey);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurging(false);
    }
  }

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
            Cookie cloud vault
          </h1>
          <p className="text-sm text-text-secondary">
            Sign in first to manage your encrypted cookie vault.
          </p>
        </header>
        <Card>
          <Link
            href="/login"
            className="rounded-2xl bg-text-primary text-surface px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Sign in with email
          </Link>
        </Card>
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
          Cookie cloud vault
        </h1>
        <p className="text-sm text-text-secondary">
          Per-account encrypted cookie vault. Cookies are wrapped under your
          account&rsquo;s data key (AES-GCM envelope encryption) so the server
          can hold ciphertext only. Push cookies from the Unbrowse CLI; this
          screen lists synced domains and lets you remove or purge them.
        </p>
      </header>

      {vaultEnabled === false && (
        <Card>
          <p className="text-sm text-text-secondary">
            Cookie cloud sync is not enabled on this deployment yet
            (<code className="font-mono text-xs">COOKIE_VAULT_MASTER_KEY</code>{" "}
            is unset). When it&rsquo;s enabled, synced domains will appear
            here.
          </p>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-sm text-red-400">{error}</p>
        </Card>
      )}

      {vaultEnabled !== false && (
        <Card title="Synced domains">
          <p className="text-xs text-text-muted">
            Push cookies for a domain with the CLI:
            <code className="block mt-1 font-mono text-text-secondary break-all">
              unbrowse cookies push &lt;domain&gt;
            </code>
          </p>
          {!domains ? (
            <div className="text-sm text-text-muted">Loading...</div>
          ) : domains.length === 0 ? (
            <div className="text-sm text-text-secondary">
              No domains synced yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {domains.map((d) => (
                <li
                  key={d.domain}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-text-primary font-mono text-sm truncate">
                      {d.domain}
                    </span>
                    <span className="block text-text-muted text-xs font-mono truncate">
                      {d.cookie_count} cookie{d.cookie_count === 1 ? "" : "s"} ·
                      synced {new Date(d.last_sync).toLocaleString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(d.domain)}
                    disabled={busyDomain === d.domain}
                    className="shrink-0 px-2 py-1 rounded-md border border-border bg-surface text-xs text-red-400 hover:bg-surface-raised transition-[background-color,opacity] duration-200 disabled:opacity-50"
                  >
                    {busyDomain === d.domain ? "..." : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {domains && domains.length > 0 && (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => void purgeAll()}
                disabled={purging}
                className="px-3 py-2 rounded-lg border border-border bg-surface text-sm text-red-400 hover:bg-surface-raised transition-[background-color,opacity] duration-200 disabled:opacity-50"
              >
                {purging ? "Purging..." : "Purge entire vault"}
              </button>
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
