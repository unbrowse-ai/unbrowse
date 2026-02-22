"use client";

import { useEffect, useState } from "react";
import type { SkillManifest, StatsSummary, AgentProfile } from "@/lib/api";
import { OpsDashboard } from "./dashboard";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export function OpsLoader() {
  const [stats, setStats] = useState<StatsSummary>({ skills: 0, endpoints: 0, domains: 0, executions: 0, agents: 0 });
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [statsRes, skillsRes, agentsRes] = await Promise.all([
          fetch(`${API_URL}/v1/stats/summary`).then((r) => r.json() as Promise<StatsSummary>),
          fetch(`${API_URL}/v1/skills`).then((r) => r.json() as Promise<{ skills: SkillManifest[] }>),
          fetch(`${API_URL}/v1/agents?limit=50`).then((r) => r.json() as Promise<{ agents: AgentProfile[] }>),
        ]);
        setStats(statsRes);
        setSkills(skillsRes.skills ?? []);
        setAgents(agentsRes.agents ?? []);
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

  return <OpsDashboard stats={stats} skills={skills} agents={agents} />;
}
