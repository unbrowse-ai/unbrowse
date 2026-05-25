"use client";

import type { SkillManifest, StatsSummary, AgentProfile } from "@/lib/api";
import type { AnalyticsData } from "./loader";
import { useEffect, useState } from "react";

interface Props {
  stats: StatsSummary;
  skills: SkillManifest[];
  agents: AgentProfile[];
  analytics: AnalyticsData;
}

/* -- helpers -- */

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function pct(n: number, total: number) {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

function reliabilityColor(score: number): string {
  if (score >= 0.8) return "#22c55e";
  if (score >= 0.5) return "#eab308";
  if (score >= 0.2) return "#f97316";
  return "#ef4444";
}

function methodColor(m: string): string {
  const map: Record<string, string> = {
    GET: "#22c55e", POST: "#3b82f6", PUT: "#a855f7", PATCH: "#eab308",
    DELETE: "#ef4444", WS: "#06b6d4", HEAD: "#6b7280", OPTIONS: "#6b7280",
  };
  return map[m] ?? "#6b7280";
}

const VERIFICATION_COLORS: Record<string, string> = {
  verified: "#22c55e", unverified: "#6b7280", failed: "#ef4444", pending: "#eab308",
};

/* -- main component -- */

export function OpsDashboard({ stats, skills, agents, analytics }: Props) {
  const [now, setNow] = useState("");

  useEffect(() => {
    const update = () => setNow(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, []);

  const health = analytics.agentHealth;
  const activation = analytics.activation;
  const engagement = analytics.engagement;

  // -- derived data --
  const activeSkills = skills.filter(s => s.lifecycle === "active");
  const deprecatedSkills = skills.filter(s => s.lifecycle === "deprecated");
  const totalEndpoints = skills.flatMap(s => s.endpoints).length;
  const activeEndpoints = activeSkills.flatMap(s => s.endpoints);
  const verifiedEndpoints = activeEndpoints.filter(e => e.verification_status === "verified");
  const totalDomains = new Set(skills.map(s => s.domain)).size;
  const activeDomains = new Set(activeSkills.map(s => s.domain)).size;

  // Domain distribution
  const domainMap = new Map<string, number>();
  for (const s of activeSkills) domainMap.set(s.domain, (domainMap.get(s.domain) ?? 0) + s.endpoints.length);
  const domains = [...domainMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxDomainCount = Math.max(1, ...domains.map(([, c]) => c));

  // Method distribution
  const methodMap = new Map<string, number>();
  for (const ep of activeEndpoints) methodMap.set(ep.method, (methodMap.get(ep.method) ?? 0) + 1);
  const methods = [...methodMap.entries()].sort((a, b) => b[1] - a[1]);

  // Verification breakdown
  const verificationMap = new Map<string, number>();
  for (const ep of activeEndpoints) verificationMap.set(ep.verification_status, (verificationMap.get(ep.verification_status) ?? 0) + 1);
  const totalVerification = [...verificationMap.values()].reduce((a, b) => a + b, 0);

  // Reliability
  const reliabilities = activeEndpoints.map(e => e.reliability_score);
  const avgReliability = reliabilities.length > 0 ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length : 0;

  // Churn rate
  const churnRate = health && health.total_agents > 0
    ? Math.round((health.churned_30d / health.total_agents) * 100) : 0;

  // Activation rate (registered -> first exec)
  const activationRate = activation && activation.total_registered > 0
    ? Math.round(activation.rates.registration_to_first_exec * 100) : 0;

  // Stickiness (DAU/WAU)
  const stickiness = engagement ? Math.round(engagement.dau_wau_ratio * 100) : 0;

  // Recent skills
  const recentSkills = [...skills]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  return (
    <div className="ops-root">
      <style>{OPS_STYLES}</style>
      <div className="ops-scanlines" />

      {/* -- header -- */}
      <header className="ops-header">
        <div className="ops-header-left">
          <div className="ops-pulse" />
          <span className="ops-logo">OPS</span>
          <span className="ops-subtitle">// UNBROWSE COMMAND</span>
        </div>
        <div className="ops-header-right">
          <span className="ops-clock">{now}</span>
        </div>
      </header>

      {/* -- primary metrics strip -- */}
      <section className="ops-stats-strip">
        <StatCard label="REGISTRY SKILLS" value={skills.length} sub={`${activeSkills.length} active / ${deprecatedSkills.length} deprecated`} />
        <StatCard label="REGISTRY ENDPOINTS" value={totalEndpoints} sub={`${activeEndpoints.length} on active skills / ${verifiedEndpoints.length} verified-active`} />
        <StatCard label="REGISTRY DOMAINS" value={totalDomains} sub={`${activeDomains} active`} />
        <StatCard label="AGENTS" value={health?.total_agents ?? stats.agents} sub={`${health?.active_today ?? 0} today`} />
        <StatCard label="EXECUTIONS" value={stats.executions} sub={`${health?.avg_executions_per_agent ?? 0} avg/agent`} />
      </section>

      {/* -- growth metrics strip -- */}
      <section className="ops-growth-strip">
        <GrowthCard label="DAU" value={health?.active_today ?? 0} />
        <GrowthCard label="WAU" value={health?.active_this_week ?? 0} />
        <GrowthCard label="MAU" value={health?.active_this_month ?? 0} />
        <GrowthCard label="STICKINESS" value={`${stickiness}%`} hint="DAU/WAU" good={stickiness >= 20} />
        <GrowthCard label="CHURN (30D)" value={`${churnRate}%`} hint={`${health?.churned_30d ?? 0} agents`} good={churnRate < 20} />
        <GrowthCard label="ACTIVATION" value={`${activationRate}%`} hint="reg -> exec" good={activationRate >= 50} />
        <GrowthCard label="AVG RELIABILITY" value={`${(avgReliability * 100).toFixed(0)}%`} good={avgReliability >= 0.7} />
      </section>

      {/* -- grid -- */}
      <div className="ops-grid">

        {/* Activation funnel */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">ACTIVATION FUNNEL</span>
          </div>
          {activation && activation.total_registered > 0 ? (
            <div className="ops-funnel">
              <FunnelStep label="Registered" value={activation.total_registered} max={activation.total_registered} />
              <FunnelStep label="First Execution" value={activation.executed_once} max={activation.total_registered} />
              <FunnelStep label="Discovered Skill" value={activation.discovered_skill} max={activation.total_registered} />
              <FunnelStep label="Repeat (5+)" value={activation.repeat_user} max={activation.total_registered} />
              <FunnelStep label="Power (20+)" value={activation.power_user} max={activation.total_registered} />
            </div>
          ) : (
            <div className="ops-funnel">
              <FunnelStep label="Registered" value={health?.total_agents ?? stats.agents} max={health?.total_agents ?? stats.agents} />
              <FunnelStep label="Active (7d)" value={health?.active_this_week ?? 0} max={health?.total_agents ?? stats.agents} />
              <FunnelStep label="Active (30d)" value={health?.active_this_month ?? 0} max={health?.total_agents ?? stats.agents} />
              <FunnelStep label="Churned" value={health?.churned_30d ?? 0} max={health?.total_agents ?? stats.agents} color="#ef4444" />
            </div>
          )}
        </div>

        {/* Agent leaderboard */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">TOP AGENTS</span>
            <span className="ops-panel-count">{health?.total_agents ?? agents.length} total</span>
          </div>
          <div className="ops-leaderboard">
            {(health?.top_agents ?? []).slice(0, 8).map((agent, i) => (
              <div key={agent.agent_id} className="ops-leader-row">
                <span className="ops-leader-rank">
                  {i === 0 ? "I" : i === 1 ? "II" : i === 2 ? "III" : String(i + 1).padStart(2, "0")}
                </span>
                <div className="ops-leader-info">
                  <span className="ops-leader-name">{agent.name || agent.agent_id.slice(0, 12)}</span>
                  <span className="ops-leader-meta">
                    {agent.executions} exec / {agent.skills_discovered} skills
                    {agent.last_active ? ` / ${timeAgo(agent.last_active)}` : ""}
                  </span>
                </div>
                <div className="ops-leader-bar-track">
                  <div
                    className="ops-leader-bar"
                    style={{
                      width: `${pct(agent.executions, health?.top_agents[0]?.executions ?? 1)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {(!health?.top_agents || health.top_agents.length === 0) && (
              <div className="ops-empty">No agent data</div>
            )}
          </div>
        </div>

        {/* Daily trend */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">DAILY ACTIVE (14D)</span>
          </div>
          {engagement?.daily_trend && engagement.daily_trend.length > 0 ? (
            <div className="ops-sparkline">
              {(() => {
                const trend = [...engagement.daily_trend].reverse();
                const max = Math.max(1, ...trend.map(d => d.active));
                return trend.map((d, i) => (
                  <div key={i} className="ops-spark-col">
                    <div className="ops-spark-bar-wrapper">
                      <div
                        className="ops-spark-bar"
                        style={{ height: `${(d.active / max) * 100}%` }}
                      />
                    </div>
                    <span className="ops-spark-value">{d.active}</span>
                    <span className="ops-spark-label">{d.date.slice(5)}</span>
                  </div>
                ));
              })()}
            </div>
          ) : (
            <div className="ops-empty">Engagement data unavailable</div>
          )}
        </div>

        {/* Domain distribution */}
        <div className="ops-panel ops-panel-wide">
          <div className="ops-panel-header">
            <span className="ops-panel-title">ENDPOINTS BY DOMAIN</span>
            <span className="ops-panel-count">{activeDomains} domains</span>
          </div>
          <div className="ops-bar-chart">
            {domains.map(([domain, count]) => (
              <div key={domain} className="ops-bar-row">
                <span className="ops-bar-label" title={domain}>
                  {domain.length > 22 ? domain.slice(0, 20) + ".." : domain}
                </span>
                <div className="ops-bar-track">
                  <div className="ops-bar-fill" style={{ width: `${(count / maxDomainCount) * 100}%` }} />
                </div>
                <span className="ops-bar-value">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Method + Verification */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">METHOD & VERIFICATION</span>
          </div>
          <div className="ops-donut-container">
            <DonutChart data={methods.map(([m, c]) => ({ label: m, value: c, color: methodColor(m) }))} />
            <div className="ops-donut-legend">
              {methods.map(([m, c]) => (
                <div key={m} className="ops-legend-item">
                  <span className="ops-legend-dot" style={{ background: methodColor(m) }} />
                  <span className="ops-legend-label">{m}</span>
                  <span className="ops-legend-value">{c}</span>
                </div>
              ))}
            </div>
          </div>
          {/* Verification stacked bar */}
          <div className="ops-stacked-bar-container">
            <div className="ops-stacked-bar">
              {["verified", "unverified", "pending", "failed"].map((status) => {
                const count = verificationMap.get(status) ?? 0;
                if (count === 0) return null;
                return (
                  <div key={status} className="ops-stacked-segment"
                    style={{ width: `${(count / totalVerification) * 100}%`, background: VERIFICATION_COLORS[status] }}
                    title={`${status}: ${count}`} />
                );
              })}
            </div>
            <div className="ops-verification-legend">
              {["verified", "unverified", "pending", "failed"].map((status) => {
                const count = verificationMap.get(status) ?? 0;
                if (count === 0) return null;
                return (
                  <div key={status} className="ops-legend-item">
                    <span className="ops-legend-dot" style={{ background: VERIFICATION_COLORS[status] }} />
                    <span className="ops-legend-label">{status}</span>
                    <span className="ops-legend-value">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Recent skills */}
        <div className="ops-panel ops-panel-wide">
          <div className="ops-panel-header">
            <span className="ops-panel-title">RECENT SKILLS</span>
            <span className="ops-panel-count">{skills.length} total</span>
          </div>
          <div className="ops-timeline">
            {recentSkills.map((skill) => (
              <div key={skill.skill_id} className="ops-timeline-item">
                <div className="ops-timeline-dot" />
                <div className="ops-timeline-content">
                  <div className="ops-timeline-top">
                    <span className="ops-timeline-domain">{skill.domain}</span>
                    <span className="ops-timeline-time">{timeAgo(skill.updated_at)} ago</span>
                  </div>
                  <span className="ops-timeline-intent">{skill.intent_signature}</span>
                  <div className="ops-timeline-tags">
                    <span className="ops-tag">{skill.endpoints.length} ep</span>
                    <span className="ops-tag">v{skill.version}</span>
                    <span className="ops-tag" style={{ color: skill.lifecycle === "active" ? "#22c55e" : "#6b7280" }}>
                      {skill.lifecycle}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Endpoint reliability heatmap */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">RELIABILITY HEATMAP</span>
          </div>
          <div className="ops-heatmap">
            {activeEndpoints
              .sort((a, b) => b.reliability_score - a.reliability_score)
              .slice(0, 60)
              .map((ep) => (
                <div key={ep.endpoint_id} className="ops-heatmap-cell"
                  style={{ background: reliabilityColor(ep.reliability_score) }}
                  title={`${ep.method} ${ep.url_template?.slice(0, 40)}\n${(ep.reliability_score * 100).toFixed(0)}%`} />
              ))}
          </div>
          <div className="ops-heatmap-legend">
            <span>0%</span>
            <div className="ops-heatmap-gradient" />
            <span>100%</span>
          </div>
        </div>
      </div>

      <footer className="ops-footer">
        <span>UNBROWSE OPS v2.0 // registry counts only, not EmergentDB vector totals</span>
      </footer>
    </div>
  );
}

/* -- sub-components -- */

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="ops-stat-card">
      <span className="ops-stat-value">{value.toLocaleString()}</span>
      <span className="ops-stat-label">{label}</span>
      {sub && <span className="ops-stat-sub">{sub}</span>}
    </div>
  );
}

function GrowthCard({ label, value, hint, good }: { label: string; value: number | string; hint?: string; good?: boolean }) {
  const color = good === undefined ? "var(--ops-text)" : good ? "#22c55e" : "#ef4444";
  return (
    <div className="ops-growth-card">
      <span className="ops-growth-value" style={{ color }}>{typeof value === "number" ? value.toLocaleString() : value}</span>
      <span className="ops-growth-label">{label}</span>
      {hint && <span className="ops-growth-hint">{hint}</span>}
    </div>
  );
}

function FunnelStep({ label, value, max, color }: { label: string; value: number; max: number; color?: string }) {
  const w = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="ops-funnel-step">
      <div className="ops-funnel-bar-track">
        <div className="ops-funnel-bar" style={{ width: `${w}%`, background: color ?? "var(--ops-accent)" }} />
      </div>
      <div className="ops-funnel-meta">
        <span className="ops-funnel-label">{label}</span>
        <span className="ops-funnel-value">{value} <span className="ops-funnel-pct">({max > 0 ? Math.round(w) : 0}%)</span></span>
      </div>
    </div>
  );
}

function DonutChart({ data }: { data: Array<{ label: string; value: number; color: string }> }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (total === 0) return <div className="ops-empty">No data</div>;
  let cumulative = 0;
  const segments = data.map((d) => {
    const start = cumulative;
    const angle = (d.value / total) * 360;
    cumulative += angle;
    return { ...d, start, angle };
  });
  let gradient = "";
  for (const seg of segments) gradient += `${seg.color} ${seg.start}deg ${seg.start + seg.angle}deg, `;
  gradient = gradient.slice(0, -2);

  return (
    <div className="ops-donut">
      <div className="ops-donut-ring" style={{ background: `conic-gradient(${gradient})` }}>
        <div className="ops-donut-hole">
          <span className="ops-donut-total">{total}</span>
        </div>
      </div>
    </div>
  );
}

/* -- styles -- */

const OPS_STYLES = `
  .ops-root {
    --ops-bg: #030201;
    --ops-surface: #0A0908;
    --ops-border: #1A1614;
    --ops-text: #E8E0D8;
    --ops-muted: #6B5C4D;
    --ops-accent: #FF6D00;
    --ops-accent-dim: rgba(255, 109, 0, 0.15);
    --ops-mono: var(--font-jetbrains-mono), 'JetBrains Mono', monospace;
    position: relative;
    min-height: 100vh;
    background: var(--ops-bg);
    color: var(--ops-text);
    font-family: var(--ops-mono);
    font-size: 12px;
    line-height: 1.5;
    padding: 0;
    overflow-x: hidden;
  }
  .ops-scanlines {
    position: fixed; inset: 0; pointer-events: none; z-index: 100;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
  }

  /* Header */
  .ops-header {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 24px;
    background: linear-gradient(180deg, var(--ops-bg) 0%, rgba(3,2,1,0.95) 100%);
    border-bottom: 1px solid var(--ops-border);
    backdrop-filter: blur(12px);
  }
  .ops-header-left { display: flex; align-items: center; gap: 12px; }
  .ops-pulse {
    width: 8px; height: 8px; background: var(--ops-accent); border-radius: 50%;
    box-shadow: 0 0 8px var(--ops-accent), 0 0 24px rgba(255,109,0,0.3);
    animation: ops-pulse 2s ease-in-out infinite;
  }
  @keyframes ops-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; box-shadow: 0 0 16px var(--ops-accent), 0 0 32px rgba(255,109,0,0.4); }
  }
  .ops-logo { font-size: 20px; letter-spacing: 6px; color: var(--ops-accent); text-shadow: 0 0 20px rgba(255,109,0,0.4); }
  .ops-subtitle { color: var(--ops-muted); font-size: 10px; letter-spacing: 3px; text-transform: uppercase; }
  .ops-header-right { display: flex; align-items: center; gap: 16px; }
  .ops-clock { color: var(--ops-muted); font-size: 11px; letter-spacing: 1px; font-variant-numeric: tabular-nums; }

  /* Stats Strip */
  .ops-stats-strip {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px;
    background: var(--ops-border); margin: 0;
  }
  .ops-stat-card {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px 16px; background: var(--ops-surface); gap: 4px; transition: background 0.3s;
  }
  .ops-stat-card:hover { background: #0F0D0B; }
  .ops-stat-value { font-size: 32px; color: var(--ops-text); line-height: 1; letter-spacing: 2px; }
  .ops-stat-label { font-size: 9px; letter-spacing: 4px; color: var(--ops-muted); text-transform: uppercase; }
  .ops-stat-sub { font-size: 10px; color: var(--ops-muted); opacity: 0.7; }

  /* Growth Strip */
  .ops-growth-strip {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px;
    background: var(--ops-border); margin-top: 1px;
  }
  .ops-growth-card {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 16px 8px; background: var(--ops-bg); gap: 3px;
  }
  .ops-growth-value { font-size: 22px; line-height: 1; letter-spacing: 1px; }
  .ops-growth-label { font-size: 8px; letter-spacing: 3px; color: var(--ops-muted); text-transform: uppercase; }
  .ops-growth-hint { font-size: 9px; color: var(--ops-muted); opacity: 0.5; }

  /* Grid */
  .ops-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px;
    background: var(--ops-border); margin-top: 1px;
  }

  /* Panel */
  .ops-panel {
    background: var(--ops-surface); padding: 20px;
    display: flex; flex-direction: column; gap: 16px; min-height: 260px;
  }
  .ops-panel-wide { grid-column: span 2; }
  .ops-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; border-bottom: 1px solid var(--ops-border);
  }
  .ops-panel-title { font-size: 10px; letter-spacing: 3px; color: var(--ops-accent); text-transform: uppercase; }
  .ops-panel-count { font-size: 10px; color: var(--ops-muted); }

  /* Funnel */
  .ops-funnel { display: flex; flex-direction: column; gap: 10px; flex: 1; justify-content: center; }
  .ops-funnel-step { display: flex; flex-direction: column; gap: 4px; }
  .ops-funnel-bar-track { height: 24px; background: var(--ops-accent-dim); border-radius: 3px; overflow: hidden; }
  .ops-funnel-bar { height: 100%; border-radius: 3px; transition: width 1s cubic-bezier(0.22, 1, 0.36, 1); }
  .ops-funnel-meta { display: flex; justify-content: space-between; align-items: center; }
  .ops-funnel-label { font-size: 10px; color: var(--ops-text); }
  .ops-funnel-value { font-size: 11px; color: var(--ops-muted); font-variant-numeric: tabular-nums; }
  .ops-funnel-pct { font-size: 9px; opacity: 0.6; }

  /* Sparkline */
  .ops-sparkline { display: flex; gap: 4px; align-items: flex-end; flex: 1; padding-top: 12px; }
  .ops-spark-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .ops-spark-bar-wrapper { width: 100%; height: 100px; display: flex; align-items: flex-end; }
  .ops-spark-bar {
    width: 100%; min-height: 3px; border-radius: 2px 2px 0 0;
    background: linear-gradient(180deg, var(--ops-accent), rgba(255,109,0,0.4));
    transition: height 1s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .ops-spark-value { font-size: 10px; color: var(--ops-text); font-variant-numeric: tabular-nums; }
  .ops-spark-label { font-size: 8px; color: var(--ops-muted); }

  /* Bar Chart */
  .ops-bar-chart { display: flex; flex-direction: column; gap: 6px; flex: 1; justify-content: center; }
  .ops-bar-row { display: grid; grid-template-columns: 160px 1fr 36px; align-items: center; gap: 10px; }
  .ops-bar-label { font-size: 11px; color: var(--ops-text); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ops-bar-track { height: 18px; background: var(--ops-accent-dim); border-radius: 2px; overflow: hidden; }
  .ops-bar-fill {
    height: 100%; background: linear-gradient(90deg, var(--ops-accent), #FF8F33);
    border-radius: 2px; transition: width 1s cubic-bezier(0.22, 1, 0.36, 1); position: relative;
  }
  .ops-bar-fill::after { content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 2px; background: #fff; opacity: 0.6; border-radius: 1px; }
  .ops-bar-value { font-size: 11px; color: var(--ops-muted); text-align: right; font-variant-numeric: tabular-nums; }

  /* Donut */
  .ops-donut-container { display: flex; align-items: center; gap: 20px; }
  .ops-donut { flex-shrink: 0; }
  .ops-donut-ring { width: 100px; height: 100px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .ops-donut-hole { width: 60px; height: 60px; border-radius: 50%; background: var(--ops-surface); display: flex; align-items: center; justify-content: center; }
  .ops-donut-total { font-size: 18px; color: var(--ops-text); }
  .ops-donut-legend { display: flex; flex-direction: column; gap: 5px; flex: 1; }
  .ops-legend-item { display: flex; align-items: center; gap: 8px; }
  .ops-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .ops-legend-label { font-size: 11px; color: var(--ops-text); min-width: 60px; }
  .ops-legend-value { font-size: 11px; color: var(--ops-muted); font-variant-numeric: tabular-nums; }

  /* Stacked bar */
  .ops-stacked-bar-container { display: flex; flex-direction: column; gap: 8px; }
  .ops-stacked-bar { display: flex; height: 20px; border-radius: 4px; overflow: hidden; gap: 1px; }
  .ops-stacked-segment { transition: width 1s ease; min-width: 2px; }
  .ops-verification-legend { display: flex; gap: 12px; flex-wrap: wrap; }

  /* Leaderboard */
  .ops-leaderboard { display: flex; flex-direction: column; gap: 4px; flex: 1; justify-content: center; }
  .ops-leader-row { display: grid; grid-template-columns: 28px 1fr 80px; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid rgba(30,26,22,0.5); }
  .ops-leader-row:last-child { border-bottom: none; }
  .ops-leader-rank { font-size: 11px; color: var(--ops-accent); text-align: center; }
  .ops-leader-info { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .ops-leader-name { font-size: 11px; color: var(--ops-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ops-leader-meta { font-size: 9px; color: var(--ops-muted); }
  .ops-leader-bar-track { height: 4px; background: var(--ops-accent-dim); border-radius: 2px; overflow: hidden; }
  .ops-leader-bar { height: 100%; background: var(--ops-accent); border-radius: 2px; transition: width 1s ease; }

  /* Timeline */
  .ops-timeline { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 24px; }
  .ops-timeline-item { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(30,26,22,0.5); align-items: flex-start; }
  .ops-timeline-dot { width: 6px; height: 6px; background: var(--ops-accent); border-radius: 50%; margin-top: 5px; flex-shrink: 0; box-shadow: 0 0 6px rgba(255,109,0,0.3); }
  .ops-timeline-content { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .ops-timeline-top { display: flex; justify-content: space-between; align-items: center; }
  .ops-timeline-domain { font-size: 11px; color: var(--ops-accent); font-weight: 500; }
  .ops-timeline-time { font-size: 9px; color: var(--ops-muted); flex-shrink: 0; }
  .ops-timeline-intent { font-size: 11px; color: var(--ops-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ops-timeline-tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .ops-tag { font-size: 9px; color: var(--ops-muted); padding: 1px 6px; border: 1px solid var(--ops-border); border-radius: 3px; white-space: nowrap; }

  /* Heatmap */
  .ops-heatmap { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; align-content: flex-start; }
  .ops-heatmap-cell { width: 20px; height: 20px; border-radius: 3px; opacity: 0.85; transition: opacity 0.2s, transform 0.2s; cursor: default; }
  .ops-heatmap-cell:hover { opacity: 1; transform: scale(1.3); z-index: 2; }
  .ops-heatmap-legend { display: flex; align-items: center; gap: 8px; font-size: 9px; color: var(--ops-muted); margin-top: 8px; }
  .ops-heatmap-gradient { height: 6px; width: 120px; background: linear-gradient(90deg, #ef4444, #f97316, #eab308, #84cc16, #22c55e); border-radius: 3px; }

  /* Footer */
  .ops-footer { padding: 16px 24px; text-align: center; font-size: 9px; letter-spacing: 3px; color: var(--ops-muted); border-top: 1px solid var(--ops-border); background: var(--ops-bg); text-transform: uppercase; }
  .ops-empty { color: var(--ops-muted); font-size: 11px; padding: 20px; text-align: center; }

  /* Responsive */
  @media (max-width: 1024px) {
    .ops-grid { grid-template-columns: repeat(2, 1fr); }
    .ops-panel-wide { grid-column: span 2; }
    .ops-stats-strip { grid-template-columns: repeat(3, 1fr); }
    .ops-growth-strip { grid-template-columns: repeat(4, 1fr); }
    .ops-timeline { grid-template-columns: 1fr; }
  }
  @media (max-width: 640px) {
    .ops-grid { grid-template-columns: 1fr; }
    .ops-panel-wide { grid-column: span 1; }
    .ops-stats-strip { grid-template-columns: repeat(2, 1fr); }
    .ops-growth-strip { grid-template-columns: repeat(2, 1fr); }
    .ops-bar-row { grid-template-columns: 100px 1fr 28px; }
    .ops-stat-value { font-size: 28px; }
  }
`;
