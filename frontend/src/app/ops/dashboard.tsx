"use client";

import type { SkillManifest, StatsSummary, AgentProfile } from "@/lib/api";
import { useEffect, useState } from "react";

interface Props {
  stats: StatsSummary;
  skills: SkillManifest[];
  agents: AgentProfile[];
}

/* ── helpers ──────────────────────────────────────────── */

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
    GET: "#22c55e",
    POST: "#3b82f6",
    PUT: "#a855f7",
    PATCH: "#eab308",
    DELETE: "#ef4444",
    WS: "#06b6d4",
    HEAD: "#6b7280",
    OPTIONS: "#6b7280",
  };
  return map[m] ?? "#6b7280";
}

const VERIFICATION_COLORS: Record<string, string> = {
  verified: "#22c55e",
  unverified: "#6b7280",
  failed: "#ef4444",
  pending: "#eab308",
};

/* ── main component ──────────────────────────────────── */

export function OpsDashboard({ stats, skills, agents }: Props) {
  const [now, setNow] = useState("");

  useEffect(() => {
    const update = () => setNow(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, []);

  // ── derived data ──

  // Domain distribution
  const domainMap = new Map<string, number>();
  for (const s of skills) {
    domainMap.set(s.domain, (domainMap.get(s.domain) ?? 0) + 1);
  }
  const domains = [...domainMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  const maxDomainCount = Math.max(1, ...domains.map(([, c]) => c));

  // Method distribution
  const methodMap = new Map<string, number>();
  for (const s of skills) {
    for (const ep of s.endpoints) {
      methodMap.set(ep.method, (methodMap.get(ep.method) ?? 0) + 1);
    }
  }
  const methods = [...methodMap.entries()].sort((a, b) => b[1] - a[1]);
  const totalEndpointsCounted = methods.reduce((a, [, c]) => a + c, 0);

  // Verification breakdown
  const verificationMap = new Map<string, number>();
  for (const s of skills) {
    for (const ep of s.endpoints) {
      verificationMap.set(ep.verification_status, (verificationMap.get(ep.verification_status) ?? 0) + 1);
    }
  }
  const totalVerification = [...verificationMap.values()].reduce((a, b) => a + b, 0);

  // Reliability distribution (buckets)
  const reliabilityBuckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  for (const s of skills) {
    for (const ep of s.endpoints) {
      const idx = Math.min(4, Math.floor(ep.reliability_score * 5));
      reliabilityBuckets[idx]++;
    }
  }
  const maxBucket = Math.max(1, ...reliabilityBuckets);

  // Recent skills (sorted by updated_at)
  const recentSkills = [...skills]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 8);

  // Top agents
  const topAgents = [...agents]
    .sort((a, b) => (b.skills_discovered.length + b.total_executions) - (a.skills_discovered.length + a.total_executions))
    .slice(0, 8);

  // Lifecycle breakdown
  const lifecycleMap = new Map<string, number>();
  for (const s of skills) {
    lifecycleMap.set(s.lifecycle, (lifecycleMap.get(s.lifecycle) ?? 0) + 1);
  }

  // Average reliability
  let totalReliability = 0;
  let reliabilityCount = 0;
  for (const s of skills) {
    for (const ep of s.endpoints) {
      totalReliability += ep.reliability_score;
      reliabilityCount++;
    }
  }
  const avgReliability = reliabilityCount > 0 ? totalReliability / reliabilityCount : 0;

  // Endpoints per skill distribution
  const epPerSkill = skills.map((s) => s.endpoints.length);
  const avgEpPerSkill = epPerSkill.length > 0 ? epPerSkill.reduce((a, b) => a + b, 0) / epPerSkill.length : 0;
  const maxEpPerSkill = Math.max(0, ...epPerSkill);

  // Schema coverage
  let withSchema = 0;
  let withoutSchema = 0;
  for (const s of skills) {
    for (const ep of s.endpoints) {
      if (ep.response_schema) withSchema++;
      else withoutSchema++;
    }
  }

  // Execution type breakdown
  const execTypeMap = new Map<string, number>();
  for (const s of skills) {
    execTypeMap.set(s.execution_type, (execTypeMap.get(s.execution_type) ?? 0) + 1);
  }

  return (
    <div className="ops-root">
      <style>{OPS_STYLES}</style>

      {/* ── scanline overlay ── */}
      <div className="ops-scanlines" />

      {/* ── header ── */}
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

      {/* ── big numbers ── */}
      <section className="ops-stats-strip">
        <StatCard label="SKILLS" value={stats.skills} />
        <StatCard label="ENDPOINTS" value={stats.endpoints} />
        <StatCard label="DOMAINS" value={stats.domains} />
        <StatCard label="EXECUTIONS" value={stats.executions} />
        <StatCard label="AGENTS" value={stats.agents} />
      </section>

      {/* ── grid ── */}
      <div className="ops-grid">

        {/* Domain distribution */}
        <div className="ops-panel ops-panel-wide">
          <div className="ops-panel-header">
            <span className="ops-panel-title">DOMAIN DISTRIBUTION</span>
            <span className="ops-panel-count">{domainMap.size} domains</span>
          </div>
          <div className="ops-bar-chart">
            {domains.map(([domain, count]) => (
              <div key={domain} className="ops-bar-row">
                <span className="ops-bar-label" title={domain}>
                  {domain.length > 22 ? domain.slice(0, 20) + ".." : domain}
                </span>
                <div className="ops-bar-track">
                  <div
                    className="ops-bar-fill"
                    style={{ width: `${(count / maxDomainCount) * 100}%` }}
                  />
                </div>
                <span className="ops-bar-value">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Method donut */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">METHOD BREAKDOWN</span>
            <span className="ops-panel-count">{totalEndpointsCounted} endpoints</span>
          </div>
          <div className="ops-donut-container">
            <DonutChart data={methods.map(([m, c]) => ({ label: m, value: c, color: methodColor(m) }))} />
            <div className="ops-donut-legend">
              {methods.map(([m, c]) => (
                <div key={m} className="ops-legend-item">
                  <span className="ops-legend-dot" style={{ background: methodColor(m) }} />
                  <span className="ops-legend-label">{m}</span>
                  <span className="ops-legend-value">{c}</span>
                  <span className="ops-legend-pct">{pct(c, totalEndpointsCounted)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Verification status */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">VERIFICATION STATUS</span>
          </div>
          <div className="ops-stacked-bar-container">
            <div className="ops-stacked-bar">
              {["verified", "unverified", "pending", "failed"].map((status) => {
                const count = verificationMap.get(status) ?? 0;
                if (count === 0) return null;
                return (
                  <div
                    key={status}
                    className="ops-stacked-segment"
                    style={{
                      width: `${(count / totalVerification) * 100}%`,
                      background: VERIFICATION_COLORS[status],
                    }}
                    title={`${status}: ${count}`}
                  />
                );
              })}
            </div>
            <div className="ops-verification-legend">
              {["verified", "unverified", "pending", "failed"].map((status) => {
                const count = verificationMap.get(status) ?? 0;
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

          {/* Quick metrics */}
          <div className="ops-metrics-row">
            <div className="ops-metric">
              <span className="ops-metric-value">{(avgReliability * 100).toFixed(1)}%</span>
              <span className="ops-metric-label">AVG RELIABILITY</span>
            </div>
            <div className="ops-metric">
              <span className="ops-metric-value">{avgEpPerSkill.toFixed(1)}</span>
              <span className="ops-metric-label">AVG EP/SKILL</span>
            </div>
            <div className="ops-metric">
              <span className="ops-metric-value">{maxEpPerSkill}</span>
              <span className="ops-metric-label">MAX EP/SKILL</span>
            </div>
          </div>
        </div>

        {/* Reliability histogram */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">RELIABILITY DISTRIBUTION</span>
          </div>
          <div className="ops-histogram">
            {reliabilityBuckets.map((count, i) => {
              const labels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
              const colors = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e"];
              return (
                <div key={i} className="ops-histogram-col">
                  <div className="ops-histogram-bar-wrapper">
                    <div
                      className="ops-histogram-bar"
                      style={{
                        height: `${(count / maxBucket) * 100}%`,
                        background: colors[i],
                      }}
                    />
                  </div>
                  <span className="ops-histogram-count">{count}</span>
                  <span className="ops-histogram-label">{labels[i]}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Schema & lifecycle gauges */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">COVERAGE & LIFECYCLE</span>
          </div>
          <div className="ops-gauge-grid">
            <GaugeRing
              label="SCHEMA"
              value={withSchema}
              total={withSchema + withoutSchema}
              color="#3b82f6"
            />
            <GaugeRing
              label="ACTIVE"
              value={lifecycleMap.get("active") ?? 0}
              total={skills.length}
              color="#22c55e"
            />
            <GaugeRing
              label="HTTP"
              value={execTypeMap.get("http") ?? 0}
              total={skills.length}
              color="#FF6D00"
            />
            <GaugeRing
              label="VERIFIED"
              value={verificationMap.get("verified") ?? 0}
              total={totalVerification}
              color="#a855f7"
            />
          </div>
        </div>

        {/* Agent leaderboard */}
        <div className="ops-panel">
          <div className="ops-panel-header">
            <span className="ops-panel-title">AGENT LEADERBOARD</span>
            <span className="ops-panel-count">{agents.length} agents</span>
          </div>
          <div className="ops-leaderboard">
            {topAgents.map((agent, i) => (
              <div key={agent.agent_id} className="ops-leader-row">
                <span className="ops-leader-rank">
                  {i === 0 ? "I" : i === 1 ? "II" : i === 2 ? "III" : String(i + 1).padStart(2, "0")}
                </span>
                <div className="ops-leader-info">
                  <span className="ops-leader-name">{agent.name || agent.agent_id.slice(0, 12)}</span>
                  <span className="ops-leader-meta">
                    {agent.skills_discovered.length} skills / {agent.total_executions} exec
                  </span>
                </div>
                <div className="ops-leader-bar-track">
                  <div
                    className="ops-leader-bar"
                    style={{
                      width: `${pct(
                        agent.skills_discovered.length + agent.total_executions,
                        (topAgents[0]?.skills_discovered.length ?? 0) + (topAgents[0]?.total_executions ?? 0)
                      )}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {topAgents.length === 0 && (
              <div className="ops-empty">No agents registered yet</div>
            )}
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
                    {skill.endpoints.some((e) => e.response_schema) && (
                      <span className="ops-tag" style={{ color: "#3b82f6" }}>schema</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Endpoint reliability heatmap */}
        <div className="ops-panel ops-panel-wide">
          <div className="ops-panel-header">
            <span className="ops-panel-title">ENDPOINT RELIABILITY HEATMAP</span>
            <span className="ops-panel-count">top 80 endpoints</span>
          </div>
          <div className="ops-heatmap">
            {skills
              .flatMap((s) => s.endpoints.map((ep) => ({ ...ep, domain: s.domain })))
              .sort((a, b) => b.reliability_score - a.reliability_score)
              .slice(0, 80)
              .map((ep) => (
                <div
                  key={ep.endpoint_id}
                  className="ops-heatmap-cell"
                  style={{ background: reliabilityColor(ep.reliability_score) }}
                  title={`${ep.method} ${ep.domain}\n${(ep.reliability_score * 100).toFixed(0)}% reliability`}
                />
              ))}
          </div>
          <div className="ops-heatmap-legend">
            <span>0%</span>
            <div className="ops-heatmap-gradient" />
            <span>100%</span>
          </div>
        </div>
      </div>

      {/* ── footer ── */}
      <footer className="ops-footer">
        <span>UNBROWSE OPS v1.0 // INTERNAL USE ONLY</span>
      </footer>
    </div>
  );
}

/* ── sub-components ──────────────────────────────────── */

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="ops-stat-card">
      <span className="ops-stat-value">{value.toLocaleString()}</span>
      <span className="ops-stat-label">{label}</span>
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

  // Build conic-gradient
  let gradient = "";
  for (const seg of segments) {
    gradient += `${seg.color} ${seg.start}deg ${seg.start + seg.angle}deg, `;
  }
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

function GaugeRing({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const p = total > 0 ? (value / total) * 100 : 0;
  const circumference = 2 * Math.PI * 36;
  const offset = circumference - (p / 100) * circumference;

  return (
    <div className="ops-gauge">
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r="36" fill="none" stroke="#1E1A16" strokeWidth="6" />
        <circle
          cx="44"
          cy="44"
          r="36"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 44 44)"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="ops-gauge-inner">
        <span className="ops-gauge-pct">{Math.round(p)}%</span>
      </div>
      <span className="ops-gauge-label">{label}</span>
    </div>
  );
}

/* ── styles ──────────────────────────────────────────── */

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

  /* CRT scanlines */
  .ops-scanlines {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0, 0, 0, 0.03) 2px,
      rgba(0, 0, 0, 0.03) 4px
    );
  }

  /* ─── Header ─── */
  .ops-header {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 24px;
    background: linear-gradient(180deg, var(--ops-bg) 0%, rgba(3,2,1,0.95) 100%);
    border-bottom: 1px solid var(--ops-border);
    backdrop-filter: blur(12px);
  }
  .ops-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .ops-pulse {
    width: 8px;
    height: 8px;
    background: var(--ops-accent);
    border-radius: 50%;
    box-shadow: 0 0 8px var(--ops-accent), 0 0 24px rgba(255,109,0,0.3);
    animation: ops-pulse 2s ease-in-out infinite;
  }
  @keyframes ops-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--ops-accent); }
    50% { opacity: 0.5; box-shadow: 0 0 16px var(--ops-accent), 0 0 32px rgba(255,109,0,0.4); }
  }
  .ops-logo {
    font-family: 'Fonetika', var(--ops-mono);
    font-size: 20px;
    letter-spacing: 6px;
    color: var(--ops-accent);
    text-shadow: 0 0 20px rgba(255,109,0,0.4);
  }
  .ops-subtitle {
    color: var(--ops-muted);
    font-size: 10px;
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .ops-header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .ops-clock {
    color: var(--ops-muted);
    font-size: 11px;
    letter-spacing: 1px;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Stats Strip ─── */
  .ops-stats-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1px;
    background: var(--ops-border);
    margin: 0;
  }
  .ops-stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 28px 16px;
    background: var(--ops-surface);
    gap: 6px;
    transition: background 0.3s;
  }
  .ops-stat-card:hover {
    background: #0F0D0B;
  }
  .ops-stat-value {
    font-family: 'Fonetika', var(--ops-mono);
    font-size: 36px;
    color: var(--ops-text);
    line-height: 1;
    letter-spacing: 2px;
  }
  .ops-stat-label {
    font-size: 9px;
    letter-spacing: 4px;
    color: var(--ops-muted);
    text-transform: uppercase;
  }

  /* ─── Grid ─── */
  .ops-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--ops-border);
    margin-top: 1px;
  }

  /* ─── Panel ─── */
  .ops-panel {
    background: var(--ops-surface);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 280px;
  }
  .ops-panel-wide {
    grid-column: span 2;
  }
  .ops-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--ops-border);
  }
  .ops-panel-title {
    font-size: 10px;
    letter-spacing: 3px;
    color: var(--ops-accent);
    text-transform: uppercase;
  }
  .ops-panel-count {
    font-size: 10px;
    color: var(--ops-muted);
  }

  /* ─── Bar Chart ─── */
  .ops-bar-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    justify-content: center;
  }
  .ops-bar-row {
    display: grid;
    grid-template-columns: 160px 1fr 36px;
    align-items: center;
    gap: 10px;
  }
  .ops-bar-label {
    font-size: 11px;
    color: var(--ops-text);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ops-bar-track {
    height: 18px;
    background: var(--ops-accent-dim);
    border-radius: 2px;
    overflow: hidden;
  }
  .ops-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--ops-accent), #FF8F33);
    border-radius: 2px;
    transition: width 1s cubic-bezier(0.22, 1, 0.36, 1);
    position: relative;
  }
  .ops-bar-fill::after {
    content: '';
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #fff;
    opacity: 0.6;
    border-radius: 1px;
  }
  .ops-bar-value {
    font-size: 11px;
    color: var(--ops-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Donut ─── */
  .ops-donut-container {
    display: flex;
    align-items: center;
    gap: 20px;
    flex: 1;
  }
  .ops-donut {
    flex-shrink: 0;
  }
  .ops-donut-ring {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .ops-donut-hole {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--ops-surface);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ops-donut-total {
    font-family: 'Fonetika', var(--ops-mono);
    font-size: 22px;
    color: var(--ops-text);
  }
  .ops-donut-legend {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }
  .ops-legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ops-legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .ops-legend-label {
    font-size: 11px;
    color: var(--ops-text);
    min-width: 60px;
  }
  .ops-legend-value {
    font-size: 11px;
    color: var(--ops-muted);
    font-variant-numeric: tabular-nums;
    min-width: 28px;
    text-align: right;
  }
  .ops-legend-pct {
    font-size: 10px;
    color: var(--ops-muted);
    opacity: 0.6;
  }

  /* ─── Stacked bar ─── */
  .ops-stacked-bar-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .ops-stacked-bar {
    display: flex;
    height: 28px;
    border-radius: 4px;
    overflow: hidden;
    gap: 1px;
  }
  .ops-stacked-segment {
    transition: width 1s ease;
    min-width: 2px;
  }
  .ops-verification-legend {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  /* ─── Metrics row ─── */
  .ops-metrics-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--ops-border);
    border-radius: 4px;
    overflow: hidden;
    margin-top: auto;
  }
  .ops-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 14px 8px;
    background: var(--ops-bg);
    gap: 4px;
  }
  .ops-metric-value {
    font-family: 'Fonetika', var(--ops-mono);
    font-size: 20px;
    color: var(--ops-text);
  }
  .ops-metric-label {
    font-size: 8px;
    letter-spacing: 2px;
    color: var(--ops-muted);
  }

  /* ─── Histogram ─── */
  .ops-histogram {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex: 1;
    padding-top: 12px;
  }
  .ops-histogram-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .ops-histogram-bar-wrapper {
    width: 100%;
    height: 120px;
    display: flex;
    align-items: flex-end;
  }
  .ops-histogram-bar {
    width: 100%;
    min-height: 3px;
    border-radius: 2px 2px 0 0;
    transition: height 1s cubic-bezier(0.22, 1, 0.36, 1);
    position: relative;
  }
  .ops-histogram-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 100%);
    border-radius: inherit;
  }
  .ops-histogram-count {
    font-size: 12px;
    color: var(--ops-text);
    font-variant-numeric: tabular-nums;
  }
  .ops-histogram-label {
    font-size: 9px;
    color: var(--ops-muted);
    white-space: nowrap;
  }

  /* ─── Gauge rings ─── */
  .ops-gauge-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    flex: 1;
    align-items: center;
  }
  .ops-gauge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    position: relative;
  }
  .ops-gauge-inner {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 88px;
    height: 88px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ops-gauge-pct {
    font-family: 'Fonetika', var(--ops-mono);
    font-size: 18px;
    color: var(--ops-text);
  }
  .ops-gauge-label {
    font-size: 8px;
    letter-spacing: 2px;
    color: var(--ops-muted);
  }

  /* ─── Leaderboard ─── */
  .ops-leaderboard {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    justify-content: center;
  }
  .ops-leader-row {
    display: grid;
    grid-template-columns: 28px 1fr 80px;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid rgba(30, 26, 22, 0.5);
  }
  .ops-leader-row:last-child {
    border-bottom: none;
  }
  .ops-leader-rank {
    font-size: 11px;
    color: var(--ops-accent);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .ops-leader-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
  }
  .ops-leader-name {
    font-size: 11px;
    color: var(--ops-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ops-leader-meta {
    font-size: 9px;
    color: var(--ops-muted);
  }
  .ops-leader-bar-track {
    height: 4px;
    background: var(--ops-accent-dim);
    border-radius: 2px;
    overflow: hidden;
  }
  .ops-leader-bar {
    height: 100%;
    background: var(--ops-accent);
    border-radius: 2px;
    transition: width 1s ease;
  }

  /* ─── Timeline ─── */
  .ops-timeline {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0 24px;
  }
  .ops-timeline-item {
    display: flex;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid rgba(30, 26, 22, 0.5);
    align-items: flex-start;
  }
  .ops-timeline-dot {
    width: 6px;
    height: 6px;
    background: var(--ops-accent);
    border-radius: 50%;
    margin-top: 5px;
    flex-shrink: 0;
    box-shadow: 0 0 6px rgba(255, 109, 0, 0.3);
  }
  .ops-timeline-content {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .ops-timeline-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .ops-timeline-domain {
    font-size: 11px;
    color: var(--ops-accent);
    font-weight: 500;
  }
  .ops-timeline-time {
    font-size: 9px;
    color: var(--ops-muted);
    flex-shrink: 0;
  }
  .ops-timeline-intent {
    font-size: 11px;
    color: var(--ops-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ops-timeline-tags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ops-tag {
    font-size: 9px;
    color: var(--ops-muted);
    padding: 1px 6px;
    border: 1px solid var(--ops-border);
    border-radius: 3px;
    white-space: nowrap;
  }

  /* ─── Heatmap ─── */
  .ops-heatmap {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    flex: 1;
    align-content: flex-start;
  }
  .ops-heatmap-cell {
    width: 22px;
    height: 22px;
    border-radius: 3px;
    opacity: 0.85;
    transition: opacity 0.2s, transform 0.2s;
    cursor: default;
  }
  .ops-heatmap-cell:hover {
    opacity: 1;
    transform: scale(1.3);
    z-index: 2;
  }
  .ops-heatmap-legend {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 9px;
    color: var(--ops-muted);
    margin-top: 8px;
  }
  .ops-heatmap-gradient {
    height: 6px;
    width: 120px;
    background: linear-gradient(90deg, #ef4444, #f97316, #eab308, #84cc16, #22c55e);
    border-radius: 3px;
  }

  /* ─── Footer ─── */
  .ops-footer {
    padding: 16px 24px;
    text-align: center;
    font-size: 9px;
    letter-spacing: 3px;
    color: var(--ops-muted);
    border-top: 1px solid var(--ops-border);
    background: var(--ops-bg);
    text-transform: uppercase;
  }

  /* ─── Empty state ─── */
  .ops-empty {
    color: var(--ops-muted);
    font-size: 11px;
    padding: 20px;
    text-align: center;
  }

  /* ─── Responsive ─── */
  @media (max-width: 1024px) {
    .ops-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .ops-panel-wide {
      grid-column: span 2;
    }
    .ops-stats-strip {
      grid-template-columns: repeat(3, 1fr);
    }
    .ops-stat-card:nth-child(4),
    .ops-stat-card:nth-child(5) {
      grid-column: span 1;
    }
    .ops-timeline {
      grid-template-columns: 1fr;
    }
    .ops-gauge-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (max-width: 640px) {
    .ops-grid {
      grid-template-columns: 1fr;
    }
    .ops-panel-wide {
      grid-column: span 1;
    }
    .ops-stats-strip {
      grid-template-columns: repeat(2, 1fr);
    }
    .ops-bar-row {
      grid-template-columns: 100px 1fr 28px;
    }
    .ops-stat-value {
      font-size: 28px;
    }
  }
`;
