import { searchSkills, listSkills, type SkillManifest } from "@/lib/api";
import { getConfiguredApiOrigin } from "@/lib/api-base";
import { getRegistrySkillHref, parseSearchMetadata } from "@/lib/registry-search";
import { SearchBar } from "@/components/search-bar";
import { SkillCard } from "@/components/skill-card";
import Link from "next/link";
import { Database, Globe2 } from "lucide-react";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; domain?: string }>;
}) {
  const { q, domain } = await searchParams;
  let results: Awaited<ReturnType<typeof searchSkills>> = [];
  let allSkills: SkillManifest[] = [];
  let error = "";

  try {
    allSkills = await listSkills();
  } catch {
    // Ignore, we will just handle empty gracefully
  }

  if (q) {
    try {
      const rawResults = await searchSkills(q, domain);
      
      // Helper to map a search result to its full SkillManifest
      const getFullSkill = (metadata: Record<string, unknown>): SkillManifest | undefined => {
        const meta = parseSearchMetadata(metadata);
        const id = meta.skill_id;
        return allSkills.find((s) => s.skill_id === id);
      };

        // Filter out deprecated skills
        results = rawResults.filter(r => {
          if (!r.metadata) return false;
          const fullSkill = getFullSkill(r.metadata);
          if (fullSkill) {
            return fullSkill.lifecycle !== "deprecated";
          }
          return true; // Keep if not found in live registry
        });

        // Fallback/Enhancement: Add local text search matches that vector search might have missed
          if (allSkills.length > 0) {
            const lowerQ = q.toLowerCase();
            const localMatches = allSkills.filter(s => 
              s.lifecycle !== "deprecated" && 
              (s.name.toLowerCase().includes(lowerQ) || 
               s.domain.toLowerCase().includes(lowerQ) ||
               s.intent_signature.toLowerCase().includes(lowerQ) ||
               (s.description && s.description.toLowerCase().includes(lowerQ)))
            );
          
          // Add local matches that aren't already in `results`
          let localMatchIdOffset = 100000;
          for (const match of localMatches) {
            const alreadyExists = results.some(r => {
              const meta = parseSearchMetadata(r.metadata);
              return meta.skill_id === match.skill_id || (getFullSkill(r.metadata)?.skill_id === match.skill_id);
            });
            if (!alreadyExists) {
              results.push({
                id: localMatchIdOffset++, // Use a deterministic deterministic id to avoid hydration issues
                score: 1.0, // perfect local match
                metadata: {
                  content: JSON.stringify({
                    skill_id: match.skill_id,
                    name: match.name,
                    domain: match.domain,
                    intent_signature: match.intent_signature
                  })
                }
              });
            }
          }
        }
        
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
      } catch (e) {
        error = (e as Error).message;
      }
  }

  // Helper to map a search result to its full SkillManifest
  const getFullSkill = (metadata: Record<string, unknown>): SkillManifest | undefined => {
    const meta = parseSearchMetadata(metadata);
    const id = meta.skill_id;
    return allSkills.find((s) => s.skill_id === id);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 pt-28 pb-20">
      {/* Header */}
      <div className="max-w-4xl mx-auto text-center mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-raised border border-border text-text-secondary text-xs font-mono font-medium uppercase tracking-widest mb-6 animate-fade-up">
          <Database className="w-3.5 h-3.5" />
          Skills Registry
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4 animate-fade-up stagger-1 text-balance">
          Find any skill.
        </h1>
          <p className="text-text-secondary text-lg animate-fade-up stagger-2 max-w-2xl mx-auto leading-relaxed">
            Search millions of mapped endpoints by natural language intent.
          </p>
      </div>

      {/* spacer when no search */}
      {!q && <div className="mb-20" />}

      {/* Search bar */}
      <div className="max-w-2xl mx-auto animate-fade-up stagger-4 mb-16 flex justify-center w-full">
        <SearchBar initial={q ?? ""} />
      </div>

      {/* Results */}
      {q && (
        <div className="animate-fade-up stagger-5 max-w-5xl mx-auto">
          {error ? (
            <div className="p-6 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-2xl max-w-2xl mx-auto">
              <p className="text-red-700 dark:text-red-400 text-sm">
                <span className="font-bold">Search failed:</span> {error}
              </p>
              <p className="text-red-600 dark:text-red-500 text-xs mt-1">
                Make sure the backend is reachable at {getConfiguredApiOrigin()}
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 mx-auto mb-4 bg-surface-sunken border border-border rounded-2xl flex items-center justify-center">
                <svg className="w-6 h-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-1 text-text-primary">No results</h2>
              <p className="text-text-secondary text-sm">
                No skills match &ldquo;{q}&rdquo;. Try a different intent or map a new site.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-text-muted mb-8 font-mono border-b border-border pb-4">
                {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;{q}&rdquo;
              </p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {results.filter((r) => r.metadata).map((r, i) => {
                  const fullSkill = getFullSkill(r.metadata);
                  
                  // If we found the full skill in our registry, render the standard SkillCard
                  if (fullSkill) {
                    return (
                      <div key={r.id} className="animate-fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
                        <SkillCard skill={fullSkill} />
                      </div>
                    );
                  }

                  // Fallback for vector search results not found in the live registry.
                  const meta = parseSearchMetadata(r.metadata);
                  const href = getRegistrySkillHref(r.metadata, allSkills);
                  const cardClassName = "group block p-6 bg-surface border border-border rounded-2xl hover:border-border-strong hover:bg-surface-raised transition-all duration-200 animate-fade-up flex flex-col h-full";
                  const card = (
                    <>
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div className="min-w-0">
                          <h3 className="font-bold text-base text-text-primary truncate">
                            {(r.metadata?.title as string) ?? meta.name ?? "Untitled"}
                          </h3>
                        </div>
                        <div className="flex-shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-surface-sunken text-text-muted border border-border">
                          {href ? "LIVE" : "INDEX ONLY"}
                        </div>
                      </div>
                      <p className="text-sm text-text-secondary leading-relaxed mb-5 line-clamp-2 flex-grow">
                        {meta.intent_signature ?? "No intent signature provided."}
                      </p>
                      {!href ? (
                        <p className="mb-5 text-xs text-text-muted">
                          Search hit only. No live registry detail page yet.
                        </p>
                      ) : null}
                      
                      <div className="flex items-center justify-between pt-4 border-t border-border mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 bg-surface-sunken rounded-full overflow-hidden border border-border">
                            <div
                              className="h-full rounded-full bg-text-primary"
                              style={{ width: `${Math.round(r.score * 100)}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-mono text-text-muted">
                            {Math.round(r.score * 100)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-text-muted font-mono">
                          {meta.domain && <span>{meta.domain}</span>}
                        </div>
                      </div>
                    </>
                  );
                  return href ? (
                    <Link
                      key={r.id}
                      href={href}
                      className={cardClassName}
                      style={{ animationDelay: `${i * 0.05}s` }}
                    >
                      {card}
                    </Link>
                  ) : (
                    <div
                      key={r.id}
                      className={`${cardClassName} cursor-default`}
                      style={{ animationDelay: `${i * 0.05}s` }}
                    >
                      {card}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Empty state & Recent Skills when no query */}
      {!q && (
        <div className="animate-fade-up stagger-4 max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-white/60 text-sm mb-6">
              Try searching for an intent to find matching APIs:
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {["get trending topics", "fetch user profile", "get newly launched token pairs"].map((example) => (
                <Link
                  key={example}
                  href={`/search?q=${encodeURIComponent(example)}`}
                  className="px-4 py-2 bg-surface border border-border rounded-xl
                             text-sm text-text-secondary hover:border-text-primary
                             hover:text-text-primary transition-all shadow-sm"
                >
                  {example}
                </Link>
              ))}
            </div>
          </div>

          <div className="pt-12 border-t border-border">
            <h3 className="text-xl font-bold flex items-center gap-2 mb-8 text-text-primary">
              <Globe2 className="w-5 h-5 text-text-muted" />
              Recently Indexed Skills
            </h3>
            
            {allSkills.filter(s => s.lifecycle !== "deprecated").length > 0 ? (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {allSkills.filter(s => s.lifecycle !== "deprecated").slice(0, 9).map((skill, i) => (
                  <div key={skill.skill_id} className="animate-fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
                    <SkillCard skill={skill} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 bg-surface-sunken border border-border rounded-2xl">
                <p className="text-text-muted">No skills found in the registry.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
