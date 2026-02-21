"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export function SearchBar({ initial = "" }: { initial?: string }) {
  const [query, setQuery] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative w-full max-w-2xl">
      <div className="relative group">
        <svg
          className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted
                     group-focus-within:text-orange-500 transition-colors"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by intent... e.g. get trending topics"
          className="w-full pl-14 pr-32 py-4 bg-surface border border-border rounded-2xl
                     text-base placeholder:text-text-muted
                     focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-500/10
                     transition-all"
        />
        <button
          type="submit"
          className="absolute right-3 top-1/2 -translate-y-1/2 px-5 py-2
                     bg-orange-500 text-white text-sm font-semibold rounded-xl
                     hover:bg-orange-600 active:scale-[0.97]
                     transition-all"
        >
          Search
        </button>
      </div>
    </form>
  );
}
