"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getOps,
  getAnalyticsAgents,
  getAnalyticsActivation,
  getAnalyticsEngagement,
  getAnalyticsEconomics,
  type SkillManifest,
  type StatsSummary,
  type AgentProfile,
  type AgentHealth,
  type ActivationFunnel,
  type EngagementMetrics,
  type UnitEconomics,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { OpsDashboard } from "./dashboard";

export interface AnalyticsData {
  agentHealth: AgentHealth | null;
  activation: ActivationFunnel | null;
  engagement: EngagementMetrics | null;
  economics: UnitEconomics | null;
}

const EMPTY_STATS: StatsSummary = { skills: 0, endpoints: 0, domains: 0, executions: 0, agents: 0 };

export function OpsLoader() {
  const { isAuthenticated, logout } = useAuth();
  const [stats, setStats] = useState<StatsSummary>(EMPTY_STATS);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData>({ agentHealth: null, activation: null, engagement: null, economics: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      getOps(),
      getAnalyticsAgents().catch(() => null),
      getAnalyticsActivation().catch(() => null),
      getAnalyticsEngagement().catch(() => null),
      getAnalyticsEconomics().catch(() => null),
    ])
      .then(([ops, agentHealth, activation, engagement, economics]) => {
        if (cancelled) return;
        setStats(ops.stats);
        setSkills(ops.skills ?? []);
        setAgents(ops.agents ?? []);
        setAnalytics({ agentHealth, activation, engagement, economics });
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Ops
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Sign in to view ops
        </h1>
        <p className="mt-3 text-sm text-text-secondary leading-relaxed">
          The ops dashboard is gated to signed-in agents.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm w-full sm:w-auto hover:bg-orange-600 active:translate-y-px transition-[background-color,transform] duration-200 cursor-pointer"
          >
            <span>[ Sign in with email ]</span>
          </Link>
          <Link
            href="/#get-started"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-[background-color,border-color,transform] duration-200 cursor-pointer"
          >
            <span>[ Get CLI key ]</span>
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#030201",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-jetbrains-mono), monospace",
        color: "#6B5C4D",
        fontSize: "12px",
        letterSpacing: "3px",
      }}>
        LOADING OPS DATA...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Ops
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Ops unavailable
        </h1>
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <button
          onClick={logout}
          className="mt-6 inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-[background-color,border-color,transform] duration-200 cursor-pointer"
        >
          <span>[ Logout ]</span>
        </button>
      </div>
    );
  }

  return <OpsDashboard stats={stats} skills={skills} agents={agents} analytics={analytics} />;
}
