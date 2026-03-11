import Link from "next/link";
import { ArrowRight, Database, Globe2 } from "lucide-react";
import { listSkills } from "@/lib/api";
import { SkillCard } from "@/components/skill-card";

export async function RegistryShowcase() {
  let skills: any[] = [];
  try {
    skills = await listSkills();
  } catch (e) {
    // silently fail and show empty or ignore
  }

  // Pick top 8 skills to showcase (based on something like highest reliability or just first 8), ignoring deprecated
  const displaySkills = skills.filter((s) => s.lifecycle !== "deprecated").slice(0, 8);

  return (
      <section id="registry" className="relative py-16 sm:py-24 border-t border-border bg-surface-sunken">
       <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50 border border-orange-500/20 text-orange-600 text-xs font-mono font-medium uppercase tracking-widest mb-6">
              <Database className="w-3.5 h-3.5" />
              Global Registry
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mt-3 text-balance text-text-primary mb-6">
              One agent discovers it.<br className="hidden sm:block" /> <span className="text-orange-500">Every agent benefits.</span>
            </h2>
            <p className="text-text-secondary text-lg max-w-2xl mx-auto leading-relaxed text-balance">
              Every time an agent maps a new website, the underlying API endpoints are published to a shared registry. Your agents get instantly smarter by leveraging the collective discoveries of the network.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Globe2 className="w-5 h-5 text-orange-500 shrink-0" />
              Recently Indexed Skills
            </h3>
            <Link href="/search" className="text-sm font-medium text-orange-600 hover:text-orange-500 transition-colors flex items-center gap-1 group whitespace-nowrap">
              View full registry <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>

        {displaySkills.length > 0 ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {displaySkills.map(skill => (
              <SkillCard key={skill.skill_id} skill={skill} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-surface border border-border rounded-xl">
            <p className="text-text-muted">Loading registry skills...</p>
          </div>
        )}
      </div>
    </section>
  );
}

