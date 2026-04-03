import { searchSkills, listSkillCards, type SkillListItem } from "@/lib/api";
import { getRegistrySkillHref, parseSearchMetadata } from "@/lib/registry-search";
import { SearchBar } from "@/components/search-bar";
import { SkillCard } from "@/components/skill-card";
import Link from "next/link";
import { Database } from "lucide-react";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; domain?: string }>;
}) {
  const { q, domain } = await searchParams;
  let results: Awaited<ReturnType<typeof searchSkills>> = [];
  let allSkills: SkillListItem[] = [];
  let error = "";
  const getFullSkill = (metadata: Record<string, unknown> | undefined): SkillListItem | undefined => {
    const skillId = parseSearchMetadata(metadata).skill_id;
    return skillId ? allSkills.find((skill) => skill.skill_id === skillId) : undefined;
  };

  if (q) {
    try {
      const [rawResults, compactSkills] = await Promise.all([
        searchSkills(q, domain),
        listSkillCards({ revalidate: 300 }),
      ]);
      allSkills = compactSkills;

      results = rawResults.filter((result) => {
        if (!result.metadata) return false;
        const fullSkill = getFullSkill(result.metadata);
        if (fullSkill) return fullSkill.lifecycle !== "deprecated";
        return true;
      });

      if (allSkills.length > 0) {
        const lowerQ = q.toLowerCase();
        const localMatches = allSkills.filter((skill) =>
          skill.lifecycle !== "deprecated" &&
          (skill.name.toLowerCase().includes(lowerQ) ||
            skill.domain.toLowerCase().includes(lowerQ) ||
            skill.intent_signature.toLowerCase().includes(lowerQ) ||
            skill.description.toLowerCase().includes(lowerQ)),
        );

        let localMatchIdOffset = 100000;
        for (const match of localMatches) {
          const alreadyExists = results.some((result) => {
            const meta = parseSearchMetadata(result.metadata);
            return meta.skill_id === match.skill_id || (getFullSkill(result.metadata)?.skill_id === match.skill_id);
          });
          if (alreadyExists) continue;
          results.push({
            id: localMatchIdOffset++,
            score: 1.0,
            metadata: {
              content: JSON.stringify({
                skill_id: match.skill_id,
                name: match.name,
                domain: match.domain,
                intent_signature: match.intent_signature,
              }),
            },
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6 pt-28 pb-20">
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

      {!q && <div className="mb-20" />}

      <div className="max-w-2xl mx-auto animate-fade-up stagger-4 mb-16 flex justify-center w-full">
        <SearchBar initial={q ?? ""} />
      </div>

      {q && (
        <div className="animate-fade-up stagger-5 max-w-5xl mx-auto">
          {error ? (
            <div className="p-6 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-2xl max-w-2xl mx-auto">
              <p className="text-red-700 dark:text-red-400 text-sm">
                <span className="font-bold">Search failed:</span> {error}
              </p>
              <p className="text-red-600 dark:text-red-500 text-xs mt-1">
                Make sure the backend is running at {process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}
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
                {results.filter((result) => result.metadata).map((result, index) => {
                  const fullSkill = getFullSkill(result.metadata);
                  if (fullSkill) {
                    return (
                      <div key={result.id} className="animate-fade-up" style={{ animationDelay: `${index * 0.05}s` }}>
                        <SkillCard skill={fullSkill} />
                      </div>
                    );
                  }

                  const meta = parseSearchMetadata(result.metadata);
                  const href = getRegistrySkillHref(result.metadata, allSkills);
                  const cardClasses = `group block p-6 bg-surface border border-border rounded-2xl
                                 hover:border-border-strong hover:bg-surface-raised
                                 transition-all duration-200 animate-fade-up flex flex-col h-full`;
                  const content = (
                    <>
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div className="min-w-0">
                          <h3 className="font-bold text-base text-text-primary truncate">
                            {(result.metadata?.title as string) ?? meta.name ?? "Untitled"}
                          </h3>
                        </div>
                        <div className="flex-shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase bg-surface-sunken text-text-muted border border-border">
                          {href ? "LIVE" : "INDEX ONLY"}
                        </div>
                      </div>
                      <p className="text-sm text-text-secondary leading-relaxed mb-5 line-clamp-2 flex-grow">
                        {meta.intent_signature ?? "No intent signature provided."}
                      </p>
                      {!href && (
                        <p className="mb-5 text-xs text-text-muted">
                          Search hit only. No live registry detail page yet.
                        </p>
                      )}
                      <div className="flex items-center justify-between pt-4 border-t border-border mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 bg-surface-sunken rounded-full overflow-hidden border border-border">
                            <div
                              className="h-full rounded-full bg-text-primary"
                              style={{ width: `${Math.round(result.score * 100)}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-mono text-text-muted">
                            {Math.round(result.score * 100)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-text-muted font-mono">
                          {meta.domain && <span>{meta.domain}</span>}
                        </div>
                      </div>
                    </>
                  );

                  if (!href) {
                    return (
                      <div
                        key={result.id}
                        className={`${cardClasses} cursor-default`}
                        style={{ animationDelay: `${index * 0.05}s` }}
                      >
                        {content}
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={result.id}
                      href={href}
                      className={cardClasses}
                      style={{ animationDelay: `${index * 0.05}s` }}
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {!q && (
        <div className="animate-fade-up stagger-4 max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-text-muted text-sm mb-6">
              Try searching for an intent to find matching APIs:
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {["get trending topics", "fetch user profile", "get newly launched token pairs"].map((example) => (
                <Link
                  key={example}
                  href={`/search?q=${encodeURIComponent(example)}`}
                  className="px-4 py-2 bg-surface border border-border rounded-xl
                             text-sm text-text-secondary hover:border-text-primary
                             hover:text-text-primary transition-all"
                >
                  {example}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
