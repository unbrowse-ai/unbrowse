import Link from "next/link";
import { ArrowRight, Database, Globe2 } from "lucide-react";
import { listSkillCards } from "@/lib/api";
import { AthensParallax } from "@/components/athens-parallax";

export async function RegistryShowcase() {
  let skills: any[] = [];
  try {
    skills = await listSkillCards({ limit: 30 });
  } catch (e) {
    console.error("[RegistryShowcase] listSkillCards failed:", e);
  }

  const displaySkills = skills.filter((s) => s.lifecycle !== "deprecated").slice(0, 30);

  return (
    <section id="registry" className="relative max-sm:h-auto max-sm:min-h-0 max-sm:pb-8 min-h-[100dvh] flex flex-col py-10 sm:py-14 pb-14">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 w-full flex flex-col flex-1 min-h-0">

        {/* Header */}
        <div className="text-center mb-6 shrink-0">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[rgba(255,122,32,0.08)] border border-[rgba(255,122,32,0.35)] text-[rgba(255,176,96,0.9)] text-xs font-mono font-medium uppercase tracking-widest mb-4" style={{ textShadow: '0 0 6px rgba(255,176,96,0.4)' }}>
            <Database className="w-3.5 h-3.5" />
            Global Registry
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
            One agent discovers it.<br className="hidden sm:block" />{" "}
            <span className="text-orange-500">Every agent benefits.</span>
          </h2>
        </div>

        {/* Scrollable terminal container */}
        <div className="flex flex-col flex-1 min-h-0 bg-[#060402] border border-[rgba(255,122,32,0.38)] rounded-sm overflow-hidden" style={{ boxShadow: '0 0 40px rgba(255,82,0,0.08)' }}>

          {/* Column header */}
          <div className="flex items-center justify-between px-5 py-3.5 shrink-0 bg-[rgba(0,0,0,0.35)]" style={{ borderBottom: '1px solid rgba(255,122,32,0.18)' }}>
            <h3 className="text-sm font-mono flex items-center gap-2 text-[rgba(255,122,32,0.8)]">
              <Globe2 className="w-4 h-4 text-orange-500" />
              Recently Indexed Skills
            </h3>
            <Link
              href="/search"
              className="text-xs font-mono text-[rgba(255,122,32,0.6)] hover:text-[rgba(255,176,96,0.9)] transition-colors flex items-center gap-1 group"
            >
              View all <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            {displaySkills.length > 0 ? (
              <div>
                {displaySkills.map((skill, i) => {
                  const avgScore = skill.avg_reliability_score ?? 0;
                  const endpointCount = skill.endpoint_count ?? skill.endpoints?.length ?? 0;
                  return (
                    <Link
                      key={skill.skill_id}
                      href={`/skills/${skill.skill_id}`}
                      className="flex items-center gap-4 px-5 py-3.5 hover:bg-[rgba(255,122,32,0.05)] transition-colors group"
                      style={i > 0 ? { borderTop: '1px solid rgba(255,122,32,0.1)' } : undefined}
                    >
                      {/* Domain initial */}
                      <div className="w-9 h-9 rounded-sm bg-[#0a0806] border border-[rgba(255,122,32,0.25)] flex items-center justify-center text-sm font-bold font-mono text-[rgba(255,122,32,0.7)] shrink-0 group-hover:border-[rgba(255,122,32,0.45)] transition-colors uppercase">
                        {skill.domain.charAt(0)}
                      </div>

                      {/* Name + domain */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-sm text-[rgba(255,122,32,0.85)] truncate">{skill.name}</span>
                          {skill.lifecycle === 'active' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          )}
                        </div>
                        <span className="text-xs text-[rgba(255,122,32,0.4)] font-mono">{skill.domain}</span>
                      </div>

                      {/* Stats */}
                      <div className="text-right shrink-0 hidden sm:block">
                        <div className="text-xs font-mono text-[rgba(255,122,32,0.45)]">{endpointCount} endpoints</div>
                        <div className="text-xs font-mono text-orange-500">{Math.round(avgScore * 100)}% reliable</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-32">
                <p className="text-[rgba(255,122,32,0.4)] text-sm font-mono">Loading registry skills...</p>
              </div>
            )}
          </div>
        </div>

      </div>

      <AthensParallax />
    </section>
  );
}
