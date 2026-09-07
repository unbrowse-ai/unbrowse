import { getAgent, getSkill, type AgentProfile, type SkillManifest } from "@/lib/api";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let profile: AgentProfile;
  try {
    profile = await getAgent(id);
  } catch {
    notFound();
  }

  const skills = (
    await Promise.all(profile.skills_discovered.map((sid) => getSkill(sid)))
  ).filter(Boolean) as SkillManifest[];

  return (
    <div className="max-w-3xl mx-auto px-6 pt-32 pb-20">
      {/* Header */}
      <div className="text-center mb-10">
        <div className="w-16 h-16 rounded-2xl bg-orange-500/10 border border-orange-500/20
                        flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl font-bold font-mono text-orange-500">
            {profile.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <h1 className="text-3xl font-bold">{profile.name}</h1>
        <p className="text-text-muted text-sm font-mono mt-1">
          Joined {new Date(profile.created_at).toLocaleDateString()}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        <StatCard value={profile.skills_discovered.length} label="Skills Discovered" />
        <StatCard value={profile.total_executions} label="Executions" />
        <StatCard value={profile.total_feedback_given} label="Feedback Given" />
      </div>

      {/* Discovered skills */}
      <div>
        <h2 className="text-xl font-bold mb-4">Skills Discovered</h2>
        {skills.length === 0 ? (
          <p className="text-text-muted text-center py-8">No skills discovered yet.</p>
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
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
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
