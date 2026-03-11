"use client";

import { useEffect, useState } from "react";
import type { SkillManifest, StatsSummary, AgentProfile, AgentHealth, ActivationFunnel, EngagementMetrics } from "@/lib/api";
import { OpsDashboard } from "./dashboard";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export interface AnalyticsData {
  agentHealth: AgentHealth | null;
  activation: ActivationFunnel | null;
  engagement: EngagementMetrics | null;
}

export function OpsLoader() {
  const [stats, setStats] = useState<StatsSummary>({ skills: 0, endpoints: 0, domains: 0, executions: 0, agents: 0 });
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData>({ agentHealth: null, activation: null, engagement: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [opsRes, healthRes, activationRes, engagementRes] = await Promise.all([
          fetch(`${API_URL}/v1/ops`).then((r) => r.ok ? r.json() as Promise<{ stats: StatsSummary; skills: SkillManifest[]; agents: AgentProfile[] }> : null),
          fetch(`${API_URL}/v1/analytics/agents`).then((r) => r.ok ? r.json() as Promise<AgentHealth> : null).catch(() => null),
          fetch(`${API_URL}/v1/analytics/activation`).then((r) => r.ok ? r.json() as Promise<ActivationFunnel> : null).catch(() => null),
          fetch(`${API_URL}/v1/analytics/engagement`).then((r) => r.ok ? r.json() as Promise<EngagementMetrics> : null).catch(() => null),
        ]);
        if (opsRes) {
          setStats(opsRes.stats);
          setSkills(opsRes.skills ?? []);
          setAgents(opsRes.agents ?? []);
        }
        setAnalytics({ agentHealth: healthRes, activation: activationRes, engagement: engagementRes });
      } catch {
        // render with empty data
      }
      setLoading(false);
    }
    load();
  }, []);

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

  return <OpsDashboard stats={stats} skills={skills} agents={agents} analytics={analytics} />;
}
