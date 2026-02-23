import { searchSkills } from "@/lib/api";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; domain?: string }>;
}) {
  const { q, domain } = await searchParams;
  let results: Awaited<ReturnType<typeof searchSkills>> = [];
  let error = "";

  if (q) {
    try {
      results = await searchSkills(q, domain);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-28 pb-20">
      {/* Header */}
      <div className="mb-12">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2 animate-fade-up">
          Search Skills
        </h1>
        <p className="text-text-secondary animate-fade-up stagger-1">
          Find skills by natural language intent. Powered by vector search.
        </p>
      </div>

      {/* Search bar */}
      <div className="animate-fade-up stagger-2 mb-12">
        <SearchBar initial={q ?? ""} />
      </div>

      {/* Results */}
      {q && (
        <div className="animate-fade-up stagger-3">
          {error ? (
            <div className="p-6 bg-red-50 border border-red-200 rounded-2xl">
              <p className="text-red-700 text-sm">
                <span className="font-bold">Search failed:</span> {error}
              </p>
              <p className="text-red-600 text-xs mt-1">
                Make sure the backend is running at {process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 mx-auto mb-4 bg-orange-50 rounded-2xl flex items-center justify-center">
                <svg className="w-6 h-6 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-1">No results</h2>
              <p className="text-text-secondary text-sm">
                No skills match &ldquo;{q}&rdquo;. Try a different intent or capture new endpoints.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-text-muted mb-6 font-mono">
                {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;{q}&rdquo;
              </p>
              <div className="space-y-3">
                {results.filter((r) => r.metadata).map((r, i) => {
                  const meta = parseMetadata(r.metadata);
                  return (
                    <Link
                      key={r.id}
                      href={`/skills/${meta.skill_id ?? r.id}`}
                      className={`group block p-5 bg-surface border border-border rounded-xl
                                 hover:border-orange-300 hover:shadow-lg hover:shadow-glow
                                 transition-all duration-300 animate-fade-up`}
                      style={{ animationDelay: `${i * 0.05}s` }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold group-hover:text-orange-500 transition-colors">
                          {(r.metadata?.title as string) ?? meta.name ?? "Untitled"}
                        </h3>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-12 bg-surface-sunken rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500"
                              style={{ width: `${Math.round(r.score * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-text-muted">
                            {Math.round(r.score * 100)}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted font-mono">
                        {meta.domain && <span>{meta.domain}</span>}
                        {meta.name && <span className="truncate">{meta.name}</span>}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Empty state when no query */}
      {!q && (
        <div className="animate-fade-up stagger-3 text-center py-16">
          <p className="text-text-muted text-sm">
            Type an intent above to find matching skills.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            {["get trending topics", "search for products", "fetch user profile", "list repositories"].map((example) => (
              <Link
                key={example}
                href={`/search?q=${encodeURIComponent(example)}`}
                className="px-4 py-2 bg-surface-raised border border-border rounded-xl
                           text-sm text-text-secondary hover:border-orange-300
                           hover:text-orange-500 transition-all"
              >
                {example}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function parseMetadata(metadata: Record<string, unknown>): Record<string, string> {
  try {
    if (typeof metadata.content === "string") {
      return JSON.parse(metadata.content) as Record<string, string>;
    }
  } catch {}
  return {};
}
