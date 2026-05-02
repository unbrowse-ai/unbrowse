"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { searchSkills, listPopularSkills, type SearchResult, type SkillListItem, type PopularSkillSummary } from "@/lib/api";
import { getRegistrySkillHref, parseSearchMetadata } from "@/lib/registry-search";
import { SkillCard } from "@/components/skill-card";

function popularToListItem(p: PopularSkillSummary): SkillListItem {
  return {
    skill_id: p.skill_id,
    version: p.version,
    name: p.name,
    intent_signature: `${p.name} ${p.domain}`,
    domain: p.domain,
    description: p.description,
    owner_type: "marketplace",
    execution_type: p.execution_type,
    lifecycle: "active",
    created_at: p.updated_at,
    updated_at: p.updated_at,
    endpoint_count: p.endpoint_count,
    avg_reliability_score: p.avg_reliability_score,
    endpoints: [],
  };
}
function buildLocalMatches(query: string, skills: SkillListItem[]): SkillListItem[] {
  const lowerQuery = query.toLowerCase();
  return skills.filter((skill) =>
    skill.lifecycle !== "deprecated" &&
    (skill.name.toLowerCase().includes(lowerQuery) ||
      skill.domain.toLowerCase().includes(lowerQuery) ||
      skill.intent_signature.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery)),
  );
}

export function SearchResults() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q")?.trim() ?? "";
  const domain = searchParams.get("domain")?.trim() ?? "";
  const [results, setResults] = useState<SearchResult[]>([]);
  const [allSkills, setAllSkills] = useState<SkillListItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const getFullSkill = (metadata: Record<string, unknown> | undefined): SkillListItem | undefined => {
    const skillId = parseSearchMetadata(metadata).skill_id;
    return skillId ? allSkills.find((skill) => skill.skill_id === skillId) : undefined;
  };

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!q) {
        setResults([]);
        setAllSkills([]);
        setError("");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      try {
        const [rawResults, popularSkills] = await Promise.all([
          searchSkills(q, domain || undefined),
          listPopularSkills(50, { revalidate: 300 }),
        ]);
        const compactSkills = popularSkills.map(popularToListItem);
        if (cancelled) return;

        const visibleSkills = compactSkills.filter((skill) => skill.lifecycle !== "deprecated");
        const nextResults = rawResults.filter((result) => {
          if (!result.metadata) return false;
          const fullSkill = visibleSkills.find((skill) => skill.skill_id === parseSearchMetadata(result.metadata).skill_id);
          if (fullSkill) return fullSkill.lifecycle !== "deprecated";
          return true;
        });

        let localMatchIdOffset = 100000;
        for (const match of buildLocalMatches(q, visibleSkills)) {
          const alreadyExists = nextResults.some((result) => {
            const skillId = parseSearchMetadata(result.metadata).skill_id;
            return skillId === match.skill_id;
          });
          if (alreadyExists) continue;
          nextResults.push({
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

        nextResults.sort((a, b) => b.score - a.score);
        setAllSkills(compactSkills);
        setResults(nextResults);
      } catch (nextError) {
        if (!cancelled) {
          setError((nextError as Error).message);
          setResults([]);
          setAllSkills([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [q, domain]);

  const renderedResults = useMemo(
    () => results.filter((result) => result.metadata),
    [results],
  );

  if (!q) {
    return (
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
                className="px-4 py-2 bg-surface border border-border rounded-xl text-sm text-text-secondary hover:border-text-primary hover:text-text-primary transition-all"
              >
                {example}
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up stagger-5 max-w-5xl mx-auto">
      {loading ? (
        <div className="text-center py-20">
          <p className="text-sm font-mono text-text-muted">Searching cached registry and live index…</p>
        </div>
      ) : error ? (
        <div className="p-6 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-2xl max-w-2xl mx-auto">
          <p className="text-red-700 dark:text-red-400 text-sm">
            <span className="font-bold">Search failed:</span> {error}
          </p>
        </div>
      ) : renderedResults.length === 0 ? (
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
            {renderedResults.length} result{renderedResults.length !== 1 ? "s" : ""} for &ldquo;{q}&rdquo;
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {renderedResults.map((result, index) => {
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
              const cardClasses = "group block p-6 bg-surface border border-border rounded-2xl hover:border-border-strong hover:bg-surface-raised transition-all duration-200 animate-fade-up flex flex-col h-full";
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
                  {!href ? (
                    <p className="mb-5 text-xs text-text-muted">
                      Search hit only. No live registry detail page yet.
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between pt-4 border-t border-border mt-auto">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 bg-surface-sunken rounded-full overflow-hidden border border-border">
                        <div className="h-full rounded-full bg-text-primary" style={{ width: `${Math.round(result.score * 100)}%` }} />
                      </div>
                      <span className="text-[11px] font-mono text-text-muted">
                        {Math.round(result.score * 100)}%
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-text-muted font-mono">
                      {meta.domain ? <span>{meta.domain}</span> : null}
                    </div>
                  </div>
                </>
              );

              if (!href) {
                return (
                  <div key={result.id} className={`${cardClasses} cursor-default`} style={{ animationDelay: `${index * 0.05}s` }}>
                    {content}
                  </div>
                );
              }

              return (
                <Link key={result.id} href={href} className={cardClasses} style={{ animationDelay: `${index * 0.05}s` }}>
                  {content}
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
