"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { getStatus as getDomainClaimStatus, getTakedownStatus as getDomainTakedownStatus } from "@/lib/claim-client";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { PrivyLoginButtonOptional } from "@/components/privy-login-button";
import {
  AccountClientError,
  fetchBillingMe,
  fetchKeys,
  fetchMe,
  fetchPreferences,
  fetchSkills,
  patchPreferences,
  createKey,
  revokeKey,
  rotateKey,
  bindKeyFunding,
  unbindKeyFunding,
  patchSkillVisibility,
  fetchSponsorStatus,
  fetchCreditBalance,
  fetchUserCredits,
  type AccountKey,
  type AccountSkill,
  type AccountPreferences,
  type BillingMe,
  type KeyFunding,
  type CreatedKey,
  type SponsorStatus,
  type CreditBalance,
  type UserCreditBalance,
  type AccountMe,
} from "@/lib/account-client";
import { checkAuthInvalidResponse } from "@/lib/auth-invalid-event";

function copy(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(value);
  }
}

function isRegisterRequired(err: unknown): boolean {
  return err instanceof AccountClientError && err.status === 403;
}

function isAuthInvalid(err: unknown): boolean {
  return err instanceof AccountClientError && err.status === 401;
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const display = value && value.length > 0 ? value : "(not set)";
  const canCopy = Boolean(value && value.length > 0);
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-text-muted text-sm">{label}</span>
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-text-primary font-mono text-sm truncate">
          {display}
        </span>
        {canCopy && (
          <button
            type="button"
            onClick={() => copy(value as string)}
            className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
          >
            Copy
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorChip({ message }: { message: string }) {
  const [showDetails, setShowDetails] = useState(false);
  const hasDetails = typeof message === "string" && message.length > 0;
  return (
    <div className="rounded-2xl border border-border bg-surface-sunken p-4 text-sm text-text-secondary space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span>Couldn&rsquo;t load this section.</span>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
          >
            {showDetails ? "Hide" : "Details"}
          </button>
        )}
      </div>
      {showDetails && hasDetails && (
        <pre className="whitespace-pre-wrap break-words text-xs text-text-muted font-mono pt-1 border-t border-border">
          {message}
        </pre>
      )}
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface-sunken p-5 space-y-3">
      <h2 className="text-sm font-medium text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function RegisterRequiredBanner() {
  return (
    <section className="rounded-2xl border border-border bg-surface-raised p-5 space-y-2">
      <h2 className="text-sm font-medium text-text-primary">
        Bind this API key to an account
      </h2>
      <p className="text-sm text-text-secondary">
        Your API key is not yet bound to an account. Run{" "}
        <code className="font-mono text-text-primary">
          unbrowse register --email you@example.com
        </code>{" "}
        in your terminal to access this dashboard.
      </p>
    </section>
  );
}

function AuthInvalidBanner({ message }: { message: string }) {
  return (
    <section className="rounded-2xl border border-border bg-surface-raised p-5 space-y-3">
      <h2 className="text-sm font-medium text-text-primary">
        Your API key is no longer valid
      </h2>
      <p className="text-sm text-text-secondary">{message}</p>
      <div className="flex gap-3 flex-wrap pt-1">
        <Link
          href="/login"
          className="rounded-2xl bg-text-primary text-surface px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          Sign in to mint a new key
        </Link>
        <Link
          href="/"
          className="rounded-2xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-raised"
        >
          Back to home
        </Link>
      </div>
    </section>
  );
}

function ProfileSection({
  registerRequired,
}: {
  registerRequired: boolean;
}) {
  const { email, userId, agentId, logout } = useAuth();
  return (
    <SectionCard title="Profile">
      <div className="divide-y divide-border">
        <Field label="Email" value={email ?? null} />
        <Field label="User ID" value={userId ?? null} />
        <Field label="Agent ID" value={agentId ?? null} />
      </div>
      {registerRequired && (
        <p className="text-xs text-text-muted">
          Account fields shown above come from the local session. Backend
          binding is still pending.
        </p>
      )}
      <div className="pt-2">
        <button
          type="button"
          onClick={logout}
          className="px-4 py-2 rounded-lg border border-border bg-surface text-sm font-medium text-text-primary hover:bg-surface-raised transition-all"
        >
          Log out
        </button>
      </div>
    </SectionCard>
  );
}

function FundingControl({
  apiKey,
  k,
  onChange,
  onAuthError,
}: {
  apiKey: string;
  k: AccountKey;
  onChange: (keyId: string, funding: KeyFunding | null) => void;
  onAuthError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [usd, setUsd] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function bindCredit() {
    const dollars = Number.parseFloat(usd);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setErr("Enter a positive USD amount.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const f = await bindKeyFunding(apiKey, k.keyId, {
        kind: "credit",
        budget_uc: Math.round(dollars * 1_000_000),
      });
      onChange(k.keyId, f);
      setUsd("");
    } catch (e) {
      onAuthError(e);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unbind() {
    setBusy(true);
    setErr(null);
    try {
      await unbindKeyFunding(apiKey, k.keyId);
      onChange(k.keyId, null);
    } catch (e) {
      onAuthError(e);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (k.funding) {
    const label =
      k.funding.kind === "credit"
        ? `x402: $${(k.funding.budget_uc / 1_000_000).toFixed(2)} credit budget`
        : `x402: wallet ${k.funding.wallet.slice(0, 10)}...`;
    return (
      <div className="flex items-center gap-2">
        <span className="text-text-muted text-xs">{label}</span>
        <button
          type="button"
          onClick={() => void unbind()}
          disabled={busy}
          className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all disabled:opacity-50"
        >
          {busy ? "..." : "Unbind"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={usd}
          onChange={(e) => setUsd(e.target.value)}
          placeholder="USD"
          className="w-20 px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-primary"
        />
        <button
          type="button"
          onClick={() => void bindCredit()}
          disabled={busy}
          className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all disabled:opacity-50"
          title="Bind a prepaid credit budget so this key auto-pays paid skills"
        >
          {busy ? "..." : "Bind x402"}
        </button>
      </div>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}

function ApiKeysSection({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [keys, setKeys] = useState<AccountKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchKeys(apiKey)
      .then((result) => {
        if (!cancelled) setKeys(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onAuthError(err);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  async function refresh() {
    try {
      setKeys(await fetchKeys(apiKey));
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function create() {
    const name = newName.trim() || "default";
    setBusy(true);
    setError(null);
    try {
      const created = await createKey(apiKey, name);
      setRevealed(created);
      setNewName("");
      await refresh();
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate(keyId: string) {
    setActingId(keyId);
    setError(null);
    try {
      const created = await rotateKey(apiKey, keyId);
      setRevealed(created);
      await refresh();
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  }

  async function revoke(keyId: string) {
    setActingId(keyId);
    setError(null);
    try {
      await revokeKey(apiKey, keyId);
      await refresh();
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  }

  return (
    <SectionCard title="API Keys">
      {revealed && (
        <div className="rounded-lg border border-border bg-surface-raised p-3 space-y-2">
          <p className="text-xs text-text-secondary">
            New key &ldquo;{revealed.name}&rdquo;. Copy it now, it is shown
            once and cannot be retrieved again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-text-primary font-mono text-xs break-all">
              {revealed.key}
            </code>
            <button
              type="button"
              onClick={() => copy(revealed.key)}
              className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-muted hover:bg-surface-raised transition-all"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (e.g. ci-bot)"
          maxLength={64}
          className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-text-primary text-surface text-sm font-medium hover:opacity-90 transition-all disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create key"}
        </button>
      </div>

      {error && <ErrorChip message={error} />}

      {!keys ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-text-secondary">
          No API keys yet. Create one above.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {keys.map((k) => {
            const acting = actingId === k.keyId;
            const revoked = !!k.revoked_at;
            return (
              <li key={k.keyId} className="flex flex-col gap-2 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span className="text-text-primary text-sm">
                      {k.name || "(unnamed)"}
                      {revoked && (
                        <span className="ml-2 text-xs text-red-400">
                          revoked
                        </span>
                      )}
                    </span>
                    <span className="block text-text-muted font-mono text-xs truncate">
                      {k.keyId}
                      {k.created_at
                        ? ` · ${new Date(k.created_at).toLocaleDateString()}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => copy(k.keyId)}
                      className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => void rotate(k.keyId)}
                      disabled={acting || revoked}
                      className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all disabled:opacity-50"
                    >
                      {acting ? "..." : "Rotate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void revoke(k.keyId)}
                      disabled={acting || revoked}
                      className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-red-400 hover:bg-surface-raised transition-all disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
                {!revoked && (
                  <div className="flex justify-end">
                    <FundingControl
                      apiKey={apiKey}
                      k={k}
                      onAuthError={onAuthError}
                      onChange={(keyId, funding) =>
                        setKeys((prev) =>
                          prev
                            ? prev.map((x) =>
                                x.keyId === keyId ? { ...x, funding } : x,
                              )
                            : prev,
                        )
                      }
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function SkillsSection({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [skills, setSkills] = useState<AccountSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSkills(apiKey)
      .then((result) => {
        if (!cancelled) setSkills(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onAuthError(err);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  async function toggleVisibility(skill: AccountSkill) {
    const next: "public" | "private" =
      (skill.visibility ?? "public") === "public" ? "private" : "public";
    setSavingId(skill.skill_id);
    setError(null);
    try {
      await patchSkillVisibility(apiKey, skill.skill_id, next);
      setSkills((prev) =>
        prev
          ? prev.map((s) =>
              s.skill_id === skill.skill_id ? { ...s, visibility: next } : s,
            )
          : prev,
      );
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  if (error) {
    return (
      <SectionCard title="Published skills">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  if (!skills) {
    return (
      <SectionCard title="Published skills">
        <div className="text-sm text-text-muted">Loading...</div>
      </SectionCard>
    );
  }

  if (skills.length === 0) {
    return (
      <SectionCard title="Published skills">
        <div className="text-sm text-text-secondary">
          No skills published under this account yet. Browse the public
          catalog at{" "}
          <Link
            href="/search"
            className="text-text-primary hover:text-text-secondary underline"
          >
            /search
          </Link>
          .
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Published skills">
      <p className="text-xs text-text-muted">
        Private skills stay yours but are excluded from public resolve and the
        marketplace catalog.
      </p>
      <ul className="divide-y divide-border">
        {skills.map((s) => {
          const isPublic = (s.visibility ?? "public") === "public";
          const busy = savingId === s.skill_id;
          return (
            <li
              key={s.skill_id}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="text-text-primary font-mono text-sm truncate">
                {s.skill_id}
                <span className="block text-text-muted text-xs font-mono truncate">
                  {s.domain}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void toggleVisibility(s)}
                disabled={busy}
                aria-pressed={isPublic}
                className="shrink-0 px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                title={
                  isPublic
                    ? "Public: in marketplace + resolve. Click to make private."
                    : "Private: excluded from public resolve. Click to make public."
                }
              >
                {busy ? "Saving..." : isPublic ? "Public" : "Private"}
              </button>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

function PreferencesSection({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [prefs, setPrefs] = useState<AccountPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPreferences(apiKey)
      .then((result) => {
        if (!cancelled) setPrefs(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onAuthError(err);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  async function onToggle() {
    if (!prefs || saving) return;
    setSaving(true);
    try {
      const next = await patchPreferences(apiKey, {
        share_pointers: !prefs.share_pointers,
      });
      setPrefs(next);
      setError(null);
    } catch (err: unknown) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <SectionCard title="Preferences">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  if (!prefs) {
    return (
      <SectionCard title="Preferences">
        <div className="text-sm text-text-muted">Loading...</div>
      </SectionCard>
    );
  }

  const on = prefs.share_pointers;
  return (
    <SectionCard title="Preferences">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-text-primary">
            Auto-publish discovered routes to the public marketplace
          </div>
          <div className="text-xs text-text-muted">
            When on, routes you index are shared with other Unbrowse users.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Auto-publish discovered routes"
          onClick={onToggle}
          disabled={saving}
          className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full border border-border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            on ? "bg-text-primary" : "bg-surface"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full transition-all ${
              on
                ? "translate-x-6 bg-surface"
                : "translate-x-1 bg-text-secondary"
            }`}
          />
        </button>
      </div>
    </SectionCard>
  );
}

function BillingSummary({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [billing, setBilling] = useState<BillingMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBillingMe(apiKey)
      .then((result) => {
        if (!cancelled) setBilling(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onAuthError(err);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  if (error) {
    return (
      <SectionCard title="Billing">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  if (!billing) {
    return (
      <SectionCard title="Billing">
        <div className="text-sm text-text-muted">Loading...</div>
      </SectionCard>
    );
  }

  if (billing.status === "none") {
    return (
      <SectionCard title="Billing">
        <div className="text-sm text-text-secondary">
          No subscription. Visit{" "}
          <Link
            href="/billing"
            className="text-text-primary hover:text-text-secondary underline"
          >
            /billing
          </Link>{" "}
          to enroll.
        </div>
        <div>
          <Link
            href="/billing"
            className="inline-block px-4 py-2 rounded-lg border border-border bg-surface text-sm font-medium text-text-primary hover:bg-surface-raised transition-all"
          >
            Enroll
          </Link>
        </div>
      </SectionCard>
    );
  }

  const sub = billing as Exclude<BillingMe, { status: "none" }>;
  const renews =
    typeof sub.currentPeriodEnd === "number"
      ? new Date(sub.currentPeriodEnd * 1000).toLocaleDateString()
      : null;

  return (
    <SectionCard title="Billing">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-text-muted">
            Plan:{" "}
            <span className="text-text-primary font-mono">{sub.status}</span>
          </span>
          {renews && (
            <span className="text-text-muted">
              Renews:{" "}
              <span className="text-text-primary font-mono">{renews}</span>
            </span>
          )}
        </div>
        <Link
          href="/billing"
          className="px-3 py-1.5 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
        >
          Manage
        </Link>
      </div>
    </SectionCard>
  );
}

function FlexOnboardingSection({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [me, setMe] = useState<
    | (Pick<
        import("@/lib/account-client").AccountMe,
        | "wallet_address"
        | "flex_escrow_address"
        | "flex_session_key_address"
        | "flex_facilitator"
      > & { loaded: true })
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe(apiKey)
      .then((result) => {
        if (cancelled) return;
        setMe({
          wallet_address: result.wallet_address ?? null,
          flex_escrow_address: result.flex_escrow_address ?? null,
          flex_session_key_address: result.flex_session_key_address ?? null,
          flex_facilitator: result.flex_facilitator ?? null,
          loaded: true,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onAuthError(err);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  if (error) {
    return (
      <SectionCard title="Flex onboarding">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  if (!me) {
    return (
      <SectionCard title="Flex onboarding">
        <div className="text-sm text-text-muted">Loading...</div>
      </SectionCard>
    );
  }

  const steps: Array<{
    label: string;
    value: string | null | undefined;
    href: string;
    ctaLabel: string;
  }> = [
    {
      label: "Wallet paired",
      value: me.wallet_address,
      href: "/account/wallet",
      ctaLabel: "Pair wallet",
    },
    {
      label: "Escrow funded",
      value: me.flex_escrow_address,
      href: "/account/escrow",
      ctaLabel: "Fund escrow",
    },
    {
      label: "Session key registered",
      value: me.flex_session_key_address,
      href: "/account/session-key",
      ctaLabel: "Register session key",
    },
  ];

  const allComplete = steps.every((s) => s.value && s.value.length > 0);

  return (
    <SectionCard title="Flex onboarding">
      <p className="text-xs text-text-muted">
        Required to settle paid endpoints. Run{" "}
        <code className="font-mono text-text-primary">unbrowse setup</code> to
        complete all three steps in one pass, or follow each link below.
      </p>
      <ul className="divide-y divide-border">
        {steps.map((s) => {
          const done = Boolean(s.value && s.value.length > 0);
          return (
            <li
              key={s.label}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    done
                      ? "bg-text-primary text-surface"
                      : "border border-border bg-surface text-text-muted"
                  }`}
                >
                  {done ? "✓" : ""}
                </span>
                <div className="min-w-0">
                  <div className="text-sm text-text-primary">{s.label}</div>
                  {done ? (
                    <div className="text-text-muted font-mono text-xs truncate">
                      {s.value}
                    </div>
                  ) : (
                    <div className="text-text-muted text-xs">Not yet</div>
                  )}
                </div>
              </div>
              <Link
                href={s.href}
                className="shrink-0 px-3 py-1.5 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
              >
                {done ? "Manage" : s.ctaLabel}
              </Link>
            </li>
          );
        })}
      </ul>
      {allComplete && (
        <p className="text-xs text-text-muted">
          Flex onboarding complete. Paid executes will settle against your
          escrow.
        </p>
      )}
    </SectionCard>
  );
}

function TierPicker({
  apiKey,
  currentStatus,
  onAuthError,
}: {
  apiKey: string;
  currentStatus: string;
  onAuthError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState<"pro" | "metered" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upgrade(tier: "pro" | "metered") {
    setBusy(tier);
    setError(null);
    try {
      const origin =
        typeof window !== "undefined" ? window.location.origin : "https://unbrowse.ai";
      const res = await fetch(`/api/billing/checkout`, {
        // Frontend talks to the worker directly via the api-base; reusing
        // authed() via account-client would couple this picker to the
        // account module's fetch helper. Inline call keeps it lean.
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ tier, return_url: `${origin}/billing/success` }),
      }).catch(async (err) => {
        // The /api/billing/checkout shim doesn't exist; fall through to a
        // direct backend POST in that case.
        throw err;
      });
      // Surface rotated-key recovery on the shim path before falling through
      // to the direct-backend retry, which would otherwise mask a 401 as
      // "url not returned" and silently re-fire the same auth-doomed request.
      if (await checkAuthInvalidResponse(res)) {
        setError("Your API key was rotated. Sign in to mint a new one.");
        return;
      }
      let url: string | null = null;
      if (res.ok) {
        const json = (await res.json()) as { url?: string };
        url = json.url ?? null;
      }
      if (!url) {
        // Direct backend fallback (no Next.js proxy).
        const { getConfiguredApiOrigin } = await import("@/lib/api-base");
        const backend = getConfiguredApiOrigin();
        const direct = await fetch(`${backend}/v1/billing/checkout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ tier, return_url: `${origin}/billing/success` }),
        });
        if (await checkAuthInvalidResponse(direct)) {
          setError("Your API key was rotated. Sign in to mint a new one.");
          return;
        }
        if (!direct.ok) {
          throw new Error(`HTTP ${direct.status}: ${await direct.text()}`);
        }
        const json = (await direct.json()) as { url?: string };
        url = json.url ?? null;
      }
      if (!url) throw new Error("checkout returned no url");
      if (typeof window !== "undefined") window.location.href = url;
    } catch (err) {
      onAuthError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // When there's already an active subscription, hide the tier picker;
  // the "Manage subscription" link routes the user through Stripe portal.
  if (currentStatus !== "none") return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void upgrade("pro")}
          disabled={busy !== null}
          className="px-3 py-1.5 rounded-md border border-border bg-surface text-xs text-text-primary hover:bg-surface-raised transition-all disabled:opacity-50"
          title="Pro: $20/mo + 200k uc monthly credit grant"
        >
          {busy === "pro" ? "..." : "Upgrade to Pro · $20/mo"}
        </button>
        <button
          type="button"
          onClick={() => void upgrade("metered")}
          disabled={busy !== null}
          className="px-3 py-1.5 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all disabled:opacity-50"
          title="Metered: pay per execute via Stripe Meter API"
        >
          {busy === "metered" ? "..." : "Switch to Metered"}
        </button>
      </div>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

function X402Panel({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [sponsor, setSponsor] = useState<SponsorStatus | null>(null);
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [creditsEnabled, setCreditsEnabled] = useState<boolean | null>(null);
  const [userCredits, setUserCredits] = useState<UserCreditBalance | null>(null);
  const [billing, setBilling] = useState<BillingMe | null>(null);
  const [me, setMe] = useState<AccountMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, cb, b, uc, m] = await Promise.all([
          fetchSponsorStatus(apiKey).catch((err) => {
            onAuthError(err);
            throw err;
          }),
          fetchCreditBalance(apiKey),
          fetchBillingMe(apiKey),
          fetchUserCredits(apiKey).catch(() => null),
          fetchMe(apiKey).catch(() => null),
        ]);
        if (cancelled) return;
        setSponsor(s);
        setCredits(cb);
        setMe(m);
        setCreditsEnabled(cb !== null);
        setBilling(b);
        setUserCredits(uc);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKey, onAuthError]);

  if (error) {
    return (
      <SectionCard title="x402 payments">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="x402 payments">
      <p className="text-xs text-text-muted">
        Live numbers, no estimates. Sponsor tier covers your first $/day before
        x402 falls through to your own wallet or a bound credit budget.
      </p>
      {!sponsor ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {userCredits && (userCredits.granted_uc > 0 || userCredits.balance_uc > 0) && (
            <div className="rounded-lg border border-border bg-surface p-3 sm:col-span-2">
              <div className="text-xs text-text-muted">
                Your credit balance (Stripe-tier grants)
              </div>
              <div className="text-sm text-text-primary font-mono">
                ${(userCredits.balance_uc / 1_000_000).toFixed(4)}
              </div>
              <div className="text-[10px] text-text-muted font-mono">
                granted ${(userCredits.granted_uc / 1_000_000).toFixed(4)} ·
                earned ${(userCredits.earned_uc / 1_000_000).toFixed(4)} ·
                consumed ${(userCredits.consumed_uc / 1_000_000).toFixed(4)}
              </div>
            </div>
          )}
          <div className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-text-muted">Sponsor today</div>
            <div className="text-sm text-text-primary font-mono">
              {sponsor.enabled
                ? `$${sponsor.remaining_today_usd.toFixed(4)} left of $${sponsor.cap_daily_usd.toFixed(2)}`
                : "not enabled"}
            </div>
            <div className="text-[10px] text-text-muted font-mono">
              spent ${sponsor.spent_today_usd.toFixed(4)} · org
              ${sponsor.global_spent_today_usd.toFixed(2)} / $
              {sponsor.global_cap_daily_usd.toFixed(2)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-text-muted">Credit balance</div>
            <div className="text-sm text-text-primary font-mono">
              {creditsEnabled === false
                ? "not enabled"
                : credits
                  ? `$${(credits.balance_uc / 1_000_000).toFixed(4)} (${credits.is_self_sustaining ? "self-sustaining" : "subsidy"})`
                  : "Loading..."}
            </div>
            {credits && (
              <div className="text-[10px] text-text-muted font-mono">
                earned ${(credits.earned_uc / 1_000_000).toFixed(4)} ·
                spent ${(credits.consumed_uc / 1_000_000).toFixed(4)}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface p-3 sm:col-span-2">
            <div className="text-xs text-text-muted">Subscription</div>
            <div className="text-sm text-text-primary">
              {billing && billing.status !== "none"
                ? `${billing.status}${"quota" in billing && billing.quota ? ` (quota ${billing.quota})` : ""}`
                : "No active subscription"}
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Link
                href="/billing"
                className="text-xs text-text-secondary hover:text-text-primary underline"
              >
                Manage subscription →
              </Link>
              <TierPicker
                apiKey={apiKey}
                currentStatus={billing?.status ?? "none"}
                onAuthError={onAuthError}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3 sm:col-span-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-text-muted">
                Wallet (lobster.cash)
              </div>
              <a
                href="https://lobster.cash"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-text-muted hover:text-text-primary underline"
              >
                What is lobster.cash?
              </a>
            </div>
            {me?.wallet_address ? (
              <>
                <div className="text-sm text-text-primary font-mono break-all">
                  {me.wallet_address}
                </div>
                <div className="text-[10px] text-text-muted font-mono">
                  provider {me.wallet_provider ?? "lobster.cash"}
                  {me.flex_escrow_address ? (
                    <> · flex escrow {me.flex_escrow_address.slice(0, 6)}...{me.flex_escrow_address.slice(-4)}</>
                  ) : null}
                </div>
                <div className="text-[10px] text-text-muted">
                  unbrowse owns: intent, amount, recipient, memo.
                  lobster owns: provisioning, signing, broadcast.
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-text-primary">
                  No payout wallet configured.
                </div>
                <div className="text-[10px] text-text-muted">
                  Run <code className="px-1 py-0.5 rounded bg-surface-elevated">npx @crossmint/lobster-cli setup</code> on the machine you run unbrowse from. After setup, the next authed CLI call auto-publishes the wallet here.
                </div>
              </>
            )}
          </div>
          <PaymentProviderCard wallet_provider={me?.wallet_provider ?? null} />
          <DomainClaimsCard />
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Wave 4 of .claude/add-a-payment-provider-choice-prompt-to-unbrowse.
 * Mirrors the CLI's `unbrowse payment-provider` choice on the web side.
 * Reads the current rail from /v1/account/me (we already pass
 * wallet_provider into the parent), lets the user pick a different
 * rail from the same five options, and posts to
 * /v1/account/payment-provider (added in Wave 2) to update the agent
 * record. The Privy wallet pulse, lobster CLI link, and pay.sh link
 * are surfaced contextually so the user sees the next step for their
 * chosen rail without leaving /account.
 */
function PaymentProviderCard({ wallet_provider }: { wallet_provider: string | null }) {
  const initial = (wallet_provider ?? "skip") as PaymentRail;
  const [selected, setSelected] = useState<PaymentRail>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the parent's wallet_provider refreshes (e.g. after Privy
  // sign-in writes privy_embedded_solana via /v1/auth/privy/start).
  useEffect(() => {
    setSelected((wallet_provider ?? "skip") as PaymentRail);
  }, [wallet_provider]);

  async function save() {
    setStatus("saving");
    setError(null);
    try {
      const { getConfiguredApiOrigin } = await import("@/lib/api-base");
      const base = getConfiguredApiOrigin();
      const res = await fetch(`${base}/v1/account/payment-provider`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: selected }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-3 p-4 rounded-2xl border border-border-subtle bg-surface-elevated">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-text-muted">Payment rail</div>
        <div className="text-[10px] text-text-muted font-mono">{initial}</div>
      </div>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value as PaymentRail)}
        className="w-full rounded-lg bg-surface-base border border-border-subtle px-3 py-2 text-sm text-text-primary"
      >
        <option value="pay_sh">pay.sh — TouchID + USDC (x402 MPP)</option>
        <option value="lobster_cash">lobster.cash — credit card + virtual card + wallet</option>
        <option value="external_solana">External — bring your own Solana signer</option>
        <option value="privy_embedded">Privy — embedded wallet (Solana, created here)</option>
        <option value="privy_embedded_solana">Privy embedded Solana (already bound)</option>
        <option value="skip">Skip — free tier (sponsor middleware $1/day/agent)</option>
      </select>
      <div className="text-[11px] text-text-muted leading-relaxed">
        {PROVIDER_NUDGES[selected] ?? "Run `unbrowse payment-provider` from the CLI to pick a rail."}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={status === "saving" || selected === initial}
          className="px-3 py-1.5 rounded-lg bg-text-primary text-surface-base text-xs font-medium disabled:opacity-40"
        >
          {status === "saving" ? "Saving..." : status === "saved" ? "Saved" : "Update rail"}
        </button>
        {status === "error" && error ? (
          <div className="text-[10px] text-red-500 font-mono break-all">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

type PaymentRail = "pay_sh" | "lobster_cash" | "external_solana" | "privy_embedded" | "privy_embedded_solana" | "skip";

const PROVIDER_NUDGES: Record<PaymentRail, string> = {
  pay_sh:
    "Install pay.sh: npx @pay-sh/cli setup. Pay.sh prompts TouchID on each paid call; fund the local account with USDC.",
  lobster_cash:
    "Install lobster.cash: npm install -g @crossmint/lobster-cli, then lobstercash setup. Subscription billing tops up a Solana wallet; virtual cards purchase across the web.",
  external_solana:
    "Add your own Solana wallet via `unbrowse wallet` (CLI). Top up off-platform; x402 sponsor middleware settles from this address.",
  privy_embedded:
    "Sign in above with Privy and an embedded Solana wallet is created for you on first login. Fund it from any Solana wallet; backend signs x402 settlements via Privy's server API.",
  privy_embedded_solana:
    "Embedded Solana wallet is already bound to your agent. Fund the wallet_address shown above to settle paid x402 calls.",
  skip:
    "No setup needed. Sponsor middleware covers your first $1/day/agent + $50/day platform-wide. Switch rails any time.",
};

/**
 * Owner-earnings lookup card. Surfaces verified claim + opt-out status
 * for a domain the user types in. No "list-my-claimed-domains" route
 * exists yet — bindings are keyed by domain, not by user — so this is
 * a lookup form, not a list. Honest scope. If a future backend route
 * lists bindings by caller wallet, this card swaps to that.
 *
 * Pure client component: hits the public GET /v1/claim/status and
 * /v1/claim/takedown/status endpoints (no auth required for reads).
 */
function DomainClaimsCard() {
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [claim, setClaim] = useState<{ verified: boolean; wallet_address?: string; verified_at?: string } | null>(null);
  const [takedown, setTakedown] = useState<{ opted_out: boolean; opted_out_at?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    const trimmed = domain.trim().toLowerCase();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setClaim(null);
    setTakedown(null);
    try {
      const [c, t] = await Promise.all([
        getDomainClaimStatus(trimmed).catch(() => null),
        getDomainTakedownStatus(trimmed).catch(() => null),
      ]);
      setClaim(c);
      setTakedown(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3 sm:col-span-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-text-muted">
          Domain claims (owner earnings lookup)
        </div>
        <Link
          href="/claim"
          className="text-[10px] text-text-muted hover:text-text-primary underline"
        >
          Claim a new domain →
        </Link>
      </div>
      <div className="flex gap-2 mt-2 flex-wrap">
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void check(); }}
          placeholder="example.com"
          className="flex-1 min-w-[180px] rounded-md border border-border bg-surface-elevated px-2 py-1 text-sm text-text-primary font-mono"
        />
        <button
          type="button"
          onClick={() => void check()}
          disabled={loading || !domain.trim()}
          className="rounded-md border border-border bg-surface-elevated px-3 py-1 text-xs text-text-primary hover:bg-surface disabled:opacity-50"
        >
          {loading ? "Checking..." : "Check"}
        </button>
      </div>
      {error && (
        <div className="text-[10px] text-red-400 mt-1">{error}</div>
      )}
      {(claim || takedown) && (
        <div className="text-[10px] text-text-muted mt-2 space-y-1">
          {claim?.verified ? (
            <div>
              <span className="text-text-primary">verified</span>: wallet{" "}
              <span className="font-mono">
                {claim.wallet_address?.slice(0, 6)}...{claim.wallet_address?.slice(-4)}
              </span>
              {claim.verified_at && <> on {new Date(claim.verified_at).toLocaleDateString()}</>}
              . OWNER_BPS (2000 bps / 20%) routes to this wallet on every paid call to any skill for{" "}
              <span className="font-mono">{domain.trim().toLowerCase()}</span>.
            </div>
          ) : (
            <div>
              <span className="text-text-primary">not verified yet</span>. Visit{" "}
              <Link href="/claim" className="underline hover:text-text-primary">/claim</Link>{" "}
              to publish a DNS TXT record and bind a wallet. Until then, the 20% owner lane folds back into the indexer pool.
            </div>
          )}
          {takedown?.opted_out && (
            <div className="text-amber-400">
              opted out: skills for this domain are marketplace-disabled (since{" "}
              {takedown.opted_out_at ? new Date(takedown.opted_out_at).toLocaleDateString() : "unknown date"}).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuickLinks() {
  const links: Array<{ href: string; label: string; external?: boolean }> = [
    { href: "/dashboard", label: "Dashboard / earnings + activity" },
    { href: "/account/cookies", label: "Cookie cloud vault" },
    { href: "/search", label: "Marketplace / browse skills" },
    { href: "/billing", label: "Billing / subscription + usage" },
    { href: "/papers", label: "Paper / read the research" },
    {
      href: "https://github.com/unbrowse-ai/unbrowse",
      label: "GitHub repo",
      external: true,
    },
    { href: "/blog", label: "Blog" },
  ];
  return (
    <SectionCard title="Quick links">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {links.map((l) =>
          l.external ? (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-text-primary hover:text-text-secondary transition-all"
            >
              {l.label}
            </a>
          ) : (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-text-primary hover:text-text-secondary transition-all"
            >
              {l.label}
            </Link>
          ),
        )}
      </div>
    </SectionCard>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const { isAuthenticated, apiKey } = useAuth();
  const [registerRequired, setRegisterRequired] = useState(false);
  const [authInvalid, setAuthInvalid] = useState<string | null>(null);

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    fetchMe(apiKey).catch((err: unknown) => {
      if (cancelled) return;
      if (isRegisterRequired(err)) {
        setRegisterRequired(true);
      } else if (isAuthInvalid(err)) {
        setAuthInvalid(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  useEffect(() => {
    if (!authInvalid) return;
    const t = setTimeout(() => {
      router.push("/login?reason=key_rotated");
    }, 1800);
    return () => clearTimeout(t);
  }, [authInvalid, router]);

  function handleAuthError(err: unknown) {
    if (isRegisterRequired(err)) {
      setRegisterRequired(true);
    } else if (isAuthInvalid(err)) {
      setAuthInvalid((prev) =>
        prev ?? (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (!isAuthenticated || !apiKey) {
    return (
      <main className="mx-auto max-w-[70ch] px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">
          Your account
        </h1>
        <p className="text-sm text-text-secondary mb-8">
          Sign in to view your account.
        </p>
        <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-secondary space-y-3">
          <p>No API key found in this browser.</p>
          <div className="flex gap-3 flex-wrap">
            <Link href="/login" className="rounded-2xl bg-text-primary text-surface px-4 py-2 text-sm font-medium hover:opacity-90">
              Sign in with email
            </Link>
            <Link href="/" className="rounded-2xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-raised">
              Generate a key on the home page
            </Link>
            <PrivyLoginButtonOptional className="rounded-2xl" />
          </div>
        </div>
      </main>
    );
  }

  if (authInvalid) {
    return (
      <main className="mx-auto max-w-[70ch] px-6 py-16 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">
            Your account
          </h1>
          <p className="text-sm text-text-secondary">
            Redirecting you to sign in...
          </p>
        </header>
        <AuthInvalidBanner message={authInvalid} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[70ch] px-6 py-16 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">
          Your account
        </h1>
        <p className="text-sm text-text-secondary">
          Profile, API keys, skill visibility, cookie vault, x402 payments.
        </p>
      </header>

      {registerRequired && <RegisterRequiredBanner />}

      <ProfileSection registerRequired={registerRequired} />
      <FlexOnboardingSection apiKey={apiKey} onAuthError={handleAuthError} />
      <ApiKeysSection apiKey={apiKey} onAuthError={handleAuthError} />
      <SkillsSection apiKey={apiKey} onAuthError={handleAuthError} />
      <PreferencesSection apiKey={apiKey} onAuthError={handleAuthError} />
      <BillingSummary apiKey={apiKey} onAuthError={handleAuthError} />
      <X402Panel apiKey={apiKey} onAuthError={handleAuthError} />
      <QuickLinks />
    </main>
  );
}
