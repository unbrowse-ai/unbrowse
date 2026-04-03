import { Suspense } from "react";
import { Database } from "lucide-react";
import { SearchBar } from "@/components/search-bar";
import { SearchBarWithParams } from "@/components/search-bar-with-params";
import { SearchResults } from "@/components/search-results";

export const revalidate = 300;

export default function SearchPage() {
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

      <div className="mb-20" />

      <div className="max-w-2xl mx-auto animate-fade-up stagger-4 mb-16 flex justify-center w-full">
        <Suspense fallback={<SearchBar initial="" />}>
          <SearchBarWithParams />
        </Suspense>
      </div>

      <Suspense fallback={<div className="max-w-5xl mx-auto text-center py-20 text-sm font-mono text-text-muted">Loading search…</div>}>
        <SearchResults />
      </Suspense>
    </div>
  );
}
