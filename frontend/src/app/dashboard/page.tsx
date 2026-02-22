"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { getMyProfile, getSkill, type AgentProfile, type SkillManifest } from "@/lib/api";

export default function DashboardPage() {
  const { isAuthenticated, agentName, logout } = useAuth();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    getMyProfile()
      .then(async (p) => {
        setProfile(p);
        // Fetch skill details for discovered skills
        const fetched = await Promise.all(
          p.skills_discovered.map((id) => getSkill(id))
        );
        setSkills(fetched.filter(Boolean) as SkillManifest[]);
      })
      .catch((err) => setError((err as Error).message));
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-2xl mx-auto px-6 pt-32 pb-20 text-center">
        <h1 className="text-3xl font-bold mb-4">Agent Dashboard</h1>
        <p className="text-text-secondary mb-8">Register your agent to view your dashboard.</p>
        <Link
          href="/#get-started"
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-orange-500
                     text-white font-semibold rounded-2xl hover:bg-orange-600 transition-all"
        >
          Get Your API Key
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-32 pb-20">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-text-muted text-sm font-mono mt-1">{agentName}</p>
        </div>
        <button
          onClick={logout}
          className="px-4 py-2 text-sm text-text-muted border border-border rounded-xl
                     hover:text-red-400 hover:border-red-400/30 transition-colors"
        >
          Logout
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-6">{error}</p>}

      {profile && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-10">
            <StatCard value={profile.skills_discovered.length} label="Skills Discovered" />
            <StatCard value={profile.total_executions} label="Total Executions" />
            <StatCard value={profile.total_feedback_given} label="Feedback Given" />
          </div>

          {/* Discovered skills */}
          <div>
            <h2 className="text-xl font-bold mb-4">Skills You Discovered</h2>
            {skills.length === 0 ? (
              <div className="p-8 rounded-2xl border border-border bg-surface text-center">
                <p className="text-text-muted">No skills discovered yet.</p>
                <p className="text-text-muted text-sm mt-2">
                  Use <code className="text-orange-500">/unbrowse</code> to capture a website and your first skill will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {skills.map((skill) => (
                  <Link
                    key={skill.skill_id}
                    href={`/skills/${skill.skill_id}`}
                    className="block p-5 rounded-2xl border border-border bg-surface hover:border-orange-500/30 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-text-primary">{skill.name}</span>
                      <span className="text-xs font-mono text-text-muted">v{skill.version}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-text-muted font-mono">
                      <span>{skill.domain}</span>
                      <span>{skill.endpoints.length} endpoints</span>
                      <span className={skill.lifecycle === "active" ? "text-emerald-500" : "text-red-400"}>
                        {skill.lifecycle}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Agent info */}
          <div className="mt-10 p-5 rounded-2xl border border-border bg-surface">
            <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">Agent Info</h3>
            <div className="space-y-2 text-sm font-mono">
              <div className="flex justify-between">
                <span className="text-text-muted">Agent ID</span>
                <span className="text-text-secondary">{profile.agent_id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Registered</span>
                <span className="text-text-secondary">{new Date(profile.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="p-5 rounded-2xl border border-border bg-surface text-center">
      <div className="text-2xl font-bold font-mono gradient-text">{value.toLocaleString()}</div>
      <div className="text-xs text-text-muted font-mono uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}
