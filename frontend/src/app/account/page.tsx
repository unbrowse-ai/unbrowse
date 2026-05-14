"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  AccountClientError,
  fetchBillingMe,
  fetchKeys,
  fetchMe,
  fetchPreferences,
  fetchSkills,
  patchPreferences,
  type AccountKey,
  type AccountSkill,
  type AccountPreferences,
  type BillingMe,
} from "@/lib/account-client";

function copy(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(value);
  }
}

function isRegisterRequired(err: unknown): boolean {
  return err instanceof AccountClientError && err.status === 403;
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
  return (
    <div className="rounded-2xl border border-border bg-surface-sunken p-4 text-sm text-text-secondary">
      Failed to load: {message}
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

function ApiKeysSection({
  apiKey,
  onAuthError,
}: {
  apiKey: string;
  onAuthError: (err: unknown) => void;
}) {
  const [keys, setKeys] = useState<AccountKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) {
    return (
      <SectionCard title="API Keys">
        <ErrorChip message={error} />
      </SectionCard>
    );
  }

  if (!keys) {
    return (
      <SectionCard title="API Keys">
        <div className="text-sm text-text-muted">Loading...</div>
      </SectionCard>
    );
  }

  if (keys.length === 0) {
    return (
      <SectionCard title="API Keys">
        <div className="text-sm text-text-secondary">
          No API keys returned. Generate one on the home page.
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="API Keys">
      <ul className="divide-y divide-border">
        {keys.map((k) => (
          <li
            key={k.keyId}
            className="flex items-center justify-between gap-4 py-2"
          >
            <span className="text-text-primary font-mono text-sm truncate">
              {k.keyId}
            </span>
            <button
              type="button"
              onClick={() => copy(k.keyId)}
              className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-text-secondary hover:bg-surface-raised transition-all"
            >
              Copy
            </button>
          </li>
        ))}
      </ul>
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
          No skills published under this account yet. Skill ownership tracking
          ships in a follow-up. Browse the public catalog at{" "}
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
      <ul className="divide-y divide-border">
        {skills.map((s) => (
          <li
            key={s.skill_id}
            className="flex items-center justify-between gap-4 py-2"
          >
            <span className="text-text-primary font-mono text-sm truncate">
              {s.skill_id}
            </span>
            <span className="text-text-muted text-xs font-mono truncate">
              {s.domain}
            </span>
          </li>
        ))}
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

function QuickLinks() {
  const links: Array<{ href: string; label: string; external?: boolean }> = [
    { href: "/dashboard", label: "Dashboard / earnings + activity" },
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
  const { isAuthenticated, apiKey } = useAuth();
  const [registerRequired, setRegisterRequired] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    fetchMe(apiKey).catch((err: unknown) => {
      if (!cancelled && isRegisterRequired(err)) {
        setRegisterRequired(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  function handleAuthError(err: unknown) {
    if (isRegisterRequired(err)) setRegisterRequired(true);
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
          <div className="flex gap-3">
            <Link href="/login" className="rounded-2xl bg-text-primary text-surface px-4 py-2 text-sm font-medium hover:opacity-90">
              Sign in with email
            </Link>
            <Link href="/" className="rounded-2xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-raised">
              Generate a key on the home page
            </Link>
          </div>
        </div>
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
          Profile, API keys, and skill ownership for this Unbrowse account.
        </p>
      </header>

      {registerRequired && <RegisterRequiredBanner />}

      <ProfileSection registerRequired={registerRequired} />
      <FlexOnboardingSection apiKey={apiKey} onAuthError={handleAuthError} />
      <ApiKeysSection apiKey={apiKey} onAuthError={handleAuthError} />
      <SkillsSection apiKey={apiKey} onAuthError={handleAuthError} />
      <PreferencesSection apiKey={apiKey} onAuthError={handleAuthError} />
      <BillingSummary apiKey={apiKey} onAuthError={handleAuthError} />
      <QuickLinks />
    </main>
  );
}
