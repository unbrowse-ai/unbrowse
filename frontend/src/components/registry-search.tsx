"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const EXAMPLES = ["book a restaurant", "search flights", "track a package", "get crypto prices"];

/** Hero search — Smithery's search-over-grid front door. Routes intent into the
 * registry (/search?q=). Aiko chat is one click further for conversational use. */
export function RegistrySearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  function go(intent: string) {
    const v = intent.trim();
    if (v) router.push(`/search?q=${encodeURIComponent(v)}`);
  }
  return (
    <div className="w-full max-w-2xl mx-auto">
      <form
        onSubmit={(e) => { e.preventDefault(); go(q); }}
        className="flex items-center gap-2 rounded-2xl px-4 py-3"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--border-strong, rgba(255,82,0,0.32))", boxShadow: "0 8px 40px -20px var(--glow, rgba(255,82,0,0.45))" }}
      >
        <span aria-hidden style={{ color: "var(--text-muted)" }}>⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search skills by intent — “book a table on any site”"
          aria-label="Search the unbrowse skill registry"
          className="flex-1 bg-transparent focus:outline-none text-[15px]"
          style={{ color: "var(--text-primary)", caretColor: "var(--orange-500)" }}
        />
        <button type="submit" className="px-4 py-1.5 rounded-xl text-[13px] font-medium" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
          Search
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2 justify-center">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => go(e)} className="px-3 py-1.5 rounded-full text-[12px]" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
            {e}
          </button>
        ))}
        <a href="/aiko" className="px-3 py-1.5 rounded-full text-[12px]" style={{ border: "1px solid var(--border)", color: "var(--orange-400, #FF6A00)" }}>
          ✦ or ask Aiko →
        </a>
      </div>
    </div>
  );
}
