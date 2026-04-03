import Link from "next/link";
import { ArrowRight, Database, Globe2 } from "lucide-react";
import { listPopularSkills, listSkills, type PopularSkillSummary } from "@/lib/api";
import { PopularSkillCard } from "@/components/popular-skill-card";

export async function RegistryShowcase() {
  let skills: PopularSkillSummary[] = [];
  try {
    skills = await listPopularSkills(8);
  } catch (e) {
    try {
      const fallback = await listSkills();
      skills = fallback
        .filter((skill) => skill.lifecycle === "active")
        .slice(0, 8)
        .map((skill) => ({
          skill_id: skill.skill_id,
          name: skill.name,
          domain: skill.domain,
          description: skill.description,
          version: skill.version,
          execution_type: skill.execution_type,
          endpoint_count: skill.endpoints.length,
          total_executions: 0,
          successful_executions: 0,
          avg_reliability_score: skill.endpoints.length > 0
            ? skill.endpoints.reduce((sum, endpoint) => sum + endpoint.reliability_score, 0) / skill.endpoints.length
            : 0,
          updated_at: skill.updated_at,
        }));
    } catch {
      // Ignore and show empty state.
    }
  }

  return (
      <section id="registry" className="relative py-16 sm:py-24 border-t border-border bg-surface-sunken">
       <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-xs font-mono font-medium uppercase tracking-widest mb-6">
              <Database className="w-3.5 h-3.5" />
              Global Registry
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 text-balance text-text-primary mb-6">
              Reuse what other agents already learned.<br className="hidden sm:block" /> <span className="text-orange-500">Don&apos;t remap the same site twice.</span>
            </h2>
            <p className="text-text-secondary text-lg max-w-2xl mx-auto leading-relaxed text-balance">
              When one agent captures a useful request flow, Unbrowse publishes the reusable skill to the registry.
              The next agent can start from that learned path instead of rediscovering the website from scratch.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Globe2 className="w-5 h-5 text-orange-500 shrink-0" />
              Most Popular Skills
            </h3>
            <Link href="/search" className="text-sm font-medium text-orange-600 hover:text-orange-500 transition-colors flex items-center gap-1 group whitespace-nowrap">
              View full registry <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>

        {skills.length > 0 ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {skills.map((skill, index) => (
              <PopularSkillCard key={skill.skill_id} rank={index + 1} skill={skill} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-surface border border-border rounded-xl">
            <p className="text-text-muted">Popular skills unavailable right now.</p>
          </div>
        )}
      </div>
    </section>
  );
}
