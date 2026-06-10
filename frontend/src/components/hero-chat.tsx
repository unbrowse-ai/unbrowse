"use client";

/*
 * HeroChat — the homepage hero is a chat bar backed by a real agent loop.
 * POST /api/hero-chat runs an LLM with live tools (search the marketplace,
 * fetch the skill manifest, execute the captured endpoint with a real HTTP
 * call) and returns the answer plus the tool steps it took. The steps render
 * above the answer — the route the answer travelled is the product demo.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Streamdown } from "streamdown";

const SUGGESTIONS = [
  "Top stories on Hacker News right now",
  "Find me cat-friendly stays on Airbnb",
  "What can Unbrowse do for my agent?",
];

interface HeroStep {
  tool: string;
  label: string;
  ms: number;
  ok: boolean;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: HeroStep[];
  totalMs?: number;
}

type Status = "idle" | "loading" | "ok" | "error";

const LOADING_PHASES = [
  "searching captured routes…",
  "picking the best endpoint…",
  "executing the live API…",
  "composing the answer…",
];

export function HeroChat() {
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hasConvo = turns.length > 0;

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, status]);

  // Cycle the loading line so long agent runs read as progress, not a hang.
  useEffect(() => {
    if (status !== "loading") return;
    setPhase(0);
    const iv = setInterval(() => setPhase((p) => Math.min(p + 1, LOADING_PHASES.length - 1)), 3500);
    return () => clearInterval(iv);
  }, [status]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || status === "loading") return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setPrompt("");
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/hero-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.map((t) => ({ role: t.role, content: t.content })) }),
      });
      const data = (await res.json()) as { answer?: string; steps?: HeroStep[]; total_ms?: number; error?: string };
      if (!res.ok || !data.answer) {
        setStatus("error");
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setTurns([...next, { role: "assistant", content: data.answer, steps: data.steps, totalMs: data.total_ms }]);
      setStatus("ok");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Network error");
    }
  }

  function retry() {
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    if (!lastUser) return;
    setTurns(turns.filter((t) => t.role === "user"));
    void ask(lastUser.content);
  }

  return (
    <div data-hero-chat className="w-full max-w-2xl mx-auto" aria-label="Ask the live agent">
      {/* Conversation panel — appears above the bar once a question exists */}
      {hasConvo && (
        <div
          ref={scrollerRef}
          className="mb-3 max-h-[360px] overflow-y-auto rounded-sm border border-[rgba(255,122,32,0.3)] bg-[#070503]/95 p-4 text-left shadow-2xl shadow-black/50"
          aria-live="polite"
        >
          {turns.map((t, i) =>
            t.role === "user" ? (
              <p key={i} className="mb-2 font-mono text-[13px] text-[rgba(255,176,96,0.95)]">
                <span className="text-[rgba(255,122,32,0.55)] select-none">&gt; </span>
                {t.content}
              </p>
            ) : (
              <div key={i} className="mb-4">
                {t.steps && t.steps.length > 0 && (
                  <div className="mb-2 border-l-2 border-[rgba(255,122,32,0.25)] pl-2.5">
                    {t.steps.map((s, j) => (
                      <p key={j} className="font-mono text-[10.5px] leading-relaxed text-[rgba(255,156,64,0.6)]">
                        <span className={s.ok ? "text-[rgba(120,220,130,0.8)]" : "text-red-400/80"}>
                          {s.ok ? "✓" : "✗"}
                        </span>{" "}
                        {s.label} <span className="text-[rgba(255,122,32,0.4)]">· {s.ms}ms</span>
                      </p>
                    ))}
                  </div>
                )}
                <div className="text-[13.5px] leading-relaxed text-text-secondary [&_a]:text-orange-400 [&_a]:underline [&_p]:mb-2 [&_li]:ml-4 [&_ul]:mb-2">
                  <Streamdown>{t.content}</Streamdown>
                </div>
                {t.totalMs != null && (
                  <p className="mt-1 text-right font-mono text-[10px] uppercase tracking-wider text-[rgba(255,122,32,0.45)]">
                    {t.steps?.length ? `${t.steps.length} live calls · ` : ""}answered in {(t.totalMs / 1000).toFixed(1)}s
                  </p>
                )}
              </div>
            ),
          )}
          {status === "loading" && (
            <p className="inline-flex items-center gap-1.5 font-mono text-xs text-[rgba(255,156,64,0.7)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
              {LOADING_PHASES[phase]}
            </p>
          )}
          {status === "error" && error && (
            <p className="font-mono text-xs text-red-400">
              {error}{" "}
              <button className="underline underline-offset-2 hover:text-red-300 cursor-pointer" onClick={retry}>
                retry
              </button>
            </p>
          )}
        </div>
      )}

      {/* The chat bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(prompt);
        }}
        className="group relative flex items-center gap-2 rounded-sm border border-[rgba(255,122,32,0.45)] bg-[#0c0804]/95 px-4 py-3 shadow-xl shadow-black/40 transition-colors focus-within:border-[rgba(255,122,32,0.8)]"
      >
        <span className="font-mono text-sm text-orange-500 select-none" aria-hidden="true">
          ❯
        </span>
        <input
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask the agent — it answers through real website APIs"
          aria-label="Ask the agent"
          autoComplete="off"
          className="flex-1 bg-transparent font-mono text-sm text-text-primary placeholder:text-[rgba(255,156,64,0.4)] focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === "loading" || !prompt.trim()}
          className="shrink-0 rounded-sm bg-orange-500 px-4 py-1.5 font-mono text-xs font-medium text-white transition-all hover:bg-orange-600 active:translate-y-px disabled:opacity-40 disabled:cursor-default cursor-pointer"
        >
          {status === "loading" ? "…" : "Ask"}
        </button>
      </form>

      {/* Suggestions + provenance line */}
      {!hasConvo && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => void ask(s)}
              className="rounded-full border border-[rgba(255,122,32,0.25)] px-3 py-1 font-mono text-[11px] text-[rgba(255,156,64,0.75)] transition-colors hover:border-[rgba(255,122,32,0.55)] hover:text-[rgba(255,176,96,1)] cursor-pointer"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 font-mono text-[11px] text-[rgba(255,156,64,0.55)]">
        Live agent with Unbrowse installed ·{" "}
        <Link href="/install" className="underline underline-offset-2 hover:text-[rgba(255,176,96,1)]">
          run it in ElizaOS, Claude, or Cursor →
        </Link>
      </p>
    </div>
  );
}
