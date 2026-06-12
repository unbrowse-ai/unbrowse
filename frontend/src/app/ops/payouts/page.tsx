"use client";

/**
 * /ops/payouts — operator view of the custodial indexer payment flow.
 *
 * Hits the admin-gated GET /v1/admin/disburse/plan (dry run, moves no funds)
 * and renders: the gate flags, the total owed, the per-contributor plan
 * (earned / paid / owed + destination wallet), and the skipped rows with their
 * reason (no_wallet / below_min / nothing_owed). This is the "track indexed
 * sites + payment flow" surface. noindex; admin-key gated client-side.
 *
 * The admin key is held in localStorage only (never sent anywhere but the
 * backend Authorization header) so the operator doesn't re-paste it each visit.
 */

import { useEffect, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
const LS_KEY = "unbrowse_admin_key";

interface PlanItem {
  agent_id: string;
  wallet_address: string;
  earned_uc: number;
  paid_uc: number;
  owed_uc: number;
  owed_usd: number;
}
interface SkipItem {
  agent_id: string;
  reason: string;
  earned_uc: number;
  paid_uc: number;
  owed_uc: number;
}
interface Plan {
  dry_run?: boolean;
  generated_at: string;
  min_usd: number;
  disburse_enabled: boolean;
  signer_configured: boolean;
  recipients: PlanItem[];
  skipped: SkipItem[];
  total_owed_uc: number;
  total_owed_usd: number;
  recipient_count: number;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const ucToUsd = (uc: number) => usd(uc / 1_000_000);
const shortAddr = (a: string) => (a && a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a || "—");

export default function PayoutsPage() {
  const [adminKey, setAdminKey] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const k = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
    if (k) {
      setSavedKey(k);
      setAdminKey(k);
    }
  }, []);

  const load = async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/admin/disburse/plan`, {
        headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      });
      if (res.status === 401) throw new Error("Unauthorized — wrong admin key.");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Plan;
      setPlan(body);
      window.localStorage.setItem(LS_KEY, key);
      setSavedKey(key);
    } catch (e) {
      setError((e as Error).message);
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (savedKey) load(savedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const card = "border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm";

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-28 font-mono">
      <p className="text-[11px] uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
        ##  Indexer payouts · payment flow
      </p>
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-primary mb-1">
        Custodial disbursement
      </h1>
      <p className="text-sm text-text-secondary leading-relaxed max-w-2xl">
        Platform collects revenue (PayAI exact → treasury), the attribution ledger
        records each indexer&apos;s earned cut, and a sweep pays each indexer their
        owed balance via direct USDC transfer from the platform wallet. This view
        is a <span className="text-orange-400">dry run</span> — it moves no funds.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (adminKey.trim()) load(adminKey.trim());
        }}
        className={`mt-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-end ${card}`}
      >
        <label className="flex-1 text-xs uppercase tracking-[0.2em] text-[rgba(255,122,32,0.5)]">
          Admin key
          <input
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="Bearer ADMIN_KEY"
            className="mt-2 block w-full border border-[rgba(255,122,32,0.18)] bg-[#060402] px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-[rgba(255,122,32,0.4)] focus:outline-none rounded-sm"
          />
        </label>
        <button
          type="submit"
          disabled={!adminKey.trim() || loading}
          className="inline-flex items-center justify-center px-6 py-2.5 bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-sm"
        >
          {loading ? "Loading…" : "Load plan"}
        </button>
      </form>

      {error && (
        <p className="mt-4 border border-red-500/30 bg-red-950/30 rounded-sm px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {plan && (
        <>
          {/* Gate flags */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Owed total" value={usd(plan.total_owed_usd)} tone="orange" />
            <Stat label="Recipients" value={String(plan.recipient_count)} />
            <Flag label="Disburse enabled" on={plan.disburse_enabled} />
            <Flag label="Signer configured" on={plan.signer_configured} />
          </div>
          <p className="mt-2 text-[11px] text-text-muted">
            Min payout {usd(plan.min_usd)} · generated {new Date(plan.generated_at).toLocaleString()}
            {!plan.disburse_enabled && (
              <span className="text-[rgba(255,176,96,0.8)]">
                {" "}· execution OFF (set DISBURSE_ENABLED=1 to allow real transfers)
              </span>
            )}
          </p>

          {/* Recipients */}
          <div className={`mt-6 ${card}`}>
            <div className="px-5 py-3 border-b border-[rgba(255,122,32,0.18)] text-xs uppercase tracking-[0.2em] text-[rgba(255,122,32,0.6)]">
              Owed — would be paid
            </div>
            {plan.recipients.length === 0 ? (
              <p className="px-5 py-6 text-sm text-text-muted">
                Nothing owed above the minimum yet. Indexers accrue here as paid executions settle.
              </p>
            ) : (
              <div className="divide-y divide-[rgba(255,122,32,0.1)]">
                {plan.recipients.map((r) => (
                  <div key={r.agent_id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="text-text-primary truncate">{r.agent_id}</div>
                      <div className="text-[11px] text-text-muted">→ {shortAddr(r.wallet_address)}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-orange-400 font-semibold">{usd(r.owed_usd)}</div>
                      <div className="text-[11px] text-text-muted">
                        earned {ucToUsd(r.earned_uc)} · paid {ucToUsd(r.paid_uc)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Skipped */}
          {plan.skipped.length > 0 && (
            <div className={`mt-4 ${card}`}>
              <div className="px-5 py-3 border-b border-[rgba(255,122,32,0.18)] text-xs uppercase tracking-[0.2em] text-[rgba(255,122,32,0.6)]">
                Skipped ({plan.skipped.length})
              </div>
              <div className="divide-y divide-[rgba(255,122,32,0.1)]">
                {plan.skipped.map((s) => (
                  <div key={s.agent_id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                    <span className="text-text-secondary truncate">{s.agent_id}</span>
                    <span className="shrink-0 text-[11px] text-text-muted">
                      {s.reason === "no_wallet" && "no wallet bound"}
                      {s.reason === "below_min" && `below min (${ucToUsd(s.owed_uc)})`}
                      {s.reason === "nothing_owed" && "settled"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "orange" }) {
  return (
    <div className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-lg font-bold ${tone === "orange" ? "text-orange-400" : "text-text-primary"}`}>
        {value}
      </div>
    </div>
  );
}

function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-sm font-bold ${on ? "text-green-400" : "text-[rgba(255,176,96,0.7)]"}`}>
        {on ? "ON" : "OFF"}
      </div>
    </div>
  );
}
