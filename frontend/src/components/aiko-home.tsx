"use client";

/*
 * Aiko — the chat homepage for Unbrowse.
 *
 * Gemini AI-Mode layout (centered greeting + rounded prompt + suggestion chips →
 * conversational answer with a live sources rail), but unbrowse-themed (orange on
 * near-black, Google Sans) and agentic: every turn fires TWO live calls in
 * parallel so you can SEE how fast search is —
 *   1. the answer  → chat.unbrowse.ai/v1/chat/completions (the Aiko agent)
 *   2. the sources → POST /v1/search (the real unbrowse route shortlist)
 * Both report their own latency. Login (wallet via Privy / email) lives top-right
 * and at /account; the long-form marketing site is one click away at /classic.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { searchSkills, type SearchResult } from "@/lib/api";

const CHAT_ENDPOINT = "https://chat.unbrowse.ai/v1/chat/completions";

const SUGGESTIONS = [
  "Cheapest SFO → SIN flight next month",
  "Compare memory foam vs hybrid mattresses",
  "Top stories on Hacker News right now",
  "Free local events happening this week",
];

type Status = "idle" | "loading" | "ok" | "error";

interface Turn {
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  answerMs?: number;
}

export function AikoHome() {
  const { isAuthenticated, agentName } = useAuth();
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<SearchResult[]>([]);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const greetName = isAuthenticated && agentName ? agentName.split(" ")[0] : "there";
  const active = turns.length > 0 || status !== "idle";

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  // US3 — conversation remembered across reloads. Restore on mount, persist on change.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("aiko_turns");
      if (raw) {
        const saved = JSON.parse(raw) as Turn[];
        if (Array.isArray(saved) && saved.length) {
          setTurns(saved);
          setStatus("ok");
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);
  useEffect(() => {
    try {
      if (turns.length) localStorage.setItem("aiko_turns", JSON.stringify(turns.slice(-20)));
      else localStorage.removeItem("aiko_turns");
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [turns]);

  // US6 — keyboard-first. "/" focuses the prompt (when not already typing);
  // Esc starts a new chat. Enter-to-send is handled on the textarea.
  useEffect(() => {
    function onDocKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape" && !typing) {
        reset();
      }
    }
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, []);

  function scrollDown() {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function ask(text: string, base?: Turn[]) {
    const q = text.trim();
    if (!q || status === "loading") return;
    const next: Turn[] = [...(base ?? turns), { role: "user", content: q }];
    setTurns(next);
    setPrompt("");
    setStatus("loading");
    setError(null);
    scrollDown();

    // Fire the real unbrowse search in parallel — this is the "how fast is search"
    // demo: the route shortlist lands independently of the prose answer.
    const tSearch = performance.now();
    searchSkills(q)
      .then((r) => {
        setSearchMs(Math.round(performance.now() - tSearch));
        setSources(Array.isArray(r) ? r.slice(0, 8) : []);
      })
      .catch(() => {
        setSearchMs(Math.round(performance.now() - tSearch));
        setSources([]);
      });

    const tAns = performance.now();
    try {
      const messages = next.map((t) => ({ role: t.role, content: t.content }));
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, max_tokens: 1500 }),
      });
      const elapsed = Math.round(performance.now() - tAns);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        x_trace_id?: string;
        x_queries_remaining?: number;
        error?: { message?: string };
      };
      if (!res.ok) {
        setStatus("error");
        setError(data?.error?.message || `HTTP ${res.status}`);
        return;
      }
      const content = data?.choices?.[0]?.message?.content || "(empty response)";
      if (typeof data?.x_queries_remaining === "number") setRemaining(data.x_queries_remaining);
      setTurns([...next, { role: "assistant", content, traceId: data?.x_trace_id, answerMs: elapsed }]);
      setStatus("ok");
      scrollDown();
    } catch (err) {
      setStatus("error");
      setError((err as Error).message || "Request failed.");
    }
  }

  function reset() {
    setTurns([]);
    setSources([]);
    setSearchMs(null);
    setStatus("idle");
    setError(null);
    setPrompt("");
  }

  // US4 — error recovery: re-run the last user turn (no duplicate append).
  function retryLast() {
    const last = turns[turns.length - 1];
    if (!last || last.role !== "user") return;
    setError(null);
    ask(last.content, turns.slice(0, -1));
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(prompt);
    }
  }

  return (
    <main
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: 70, background: "var(--surface, #0a0908)", color: "var(--text-primary, #F5F3EF)" }}
    >
      {/* Top bar — wordmark left, identity + menu right (the rest hidden but reachable) */}
      <header className="flex items-center justify-between px-5 sm:px-8 h-14 shrink-0">
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-2 text-[15px] font-semibold tracking-tight"
          style={{ color: "var(--text-primary)" }}
        >
          <span
            aria-hidden
            style={{ width: 10, height: 10, borderRadius: 999, background: "var(--orange-500, #FF5200)", boxShadow: "0 0 12px var(--glow, rgba(255,82,0,0.45))" }}
          />
          Aiko
          <span className="text-[11px] font-normal px-1.5 py-0.5 rounded-full" style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}>
            aiko-0.8b
          </span>
        </button>
        <nav className="flex items-center gap-2 sm:gap-3 text-[13px]">
          <Link href="/classic" className="hidden sm:inline transition-opacity hover:opacity-100" style={{ color: "var(--text-muted)", opacity: 0.85 }}>
            About
          </Link>
          <Link href="/dashboard" className="hidden sm:inline transition-opacity hover:opacity-100" style={{ color: "var(--text-muted)", opacity: 0.85 }}>
            Dashboard
          </Link>
          {isAuthenticated ? (
            <span
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px]"
              style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              title="Signed in"
            >
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: "#4ADE80" }} />
              {agentName || "Account"}
            </span>
          ) : (
            <Link
              href="/account"
              className="px-4 py-1.5 rounded-full text-[13px] font-medium transition-transform hover:scale-[1.02]"
              style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}
            >
              Sign in · connect wallet
            </Link>
          )}
        </nav>
      </header>

      {/* Body */}
      {!active ? (
        // ---------- Idle: Gemini-style centered greeting + prompt ----------
        <div className="flex-1 flex flex-col items-center justify-center px-5 -mt-10">
          <h1
            className="text-[26px] sm:text-[34px] text-center mb-8 font-medium"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.01em" }}
          >
            Hi, {greetName}.{" "}
            <span style={{ color: "var(--text-secondary)" }}>What&apos;s on your mind?</span>
          </h1>
          <Composer
            prompt={prompt}
            setPrompt={setPrompt}
            onKey={onKey}
            onSubmit={() => ask(prompt)}
            inputRef={inputRef}
            big
          />
          <div className="mt-5 flex flex-wrap gap-2 justify-center max-w-2xl">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="flex items-center gap-2 px-3.5 py-2 rounded-full text-[13px] transition-colors"
                style={{ border: "1px solid var(--border)", color: "var(--text-secondary)", background: "var(--surface-raised, rgba(16,14,12,0.6))" }}
              >
                <span aria-hidden style={{ color: "var(--orange-400, #FF6A00)" }}>↗</span>
                {s}
              </button>
            ))}
          </div>
          <p className="mt-8 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Answers run live through Unbrowse routes · 10 free queries/day · no key required
          </p>
        </div>
      ) : (
        // ---------- Active: answer (left) + live sources rail (right) ----------
        <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_320px]">
          <div ref={scrollerRef} className="overflow-y-auto px-5 sm:px-8 lg:px-16 py-6">
            <ol role="log" aria-live="polite" aria-label="Conversation with Aiko" className="max-w-3xl mx-auto grid gap-7">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <li key={i} className="flex justify-end">
                    <span
                      className="px-4 py-2 rounded-2xl text-[15px]"
                      style={{ background: "var(--surface-raised, rgba(255,82,0,0.08))", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                    >
                      {t.content}
                    </span>
                  </li>
                ) : (
                  <li key={i} className="grid gap-2">
                    <div className="text-[15px] leading-[1.7] whitespace-pre-wrap" style={{ color: "var(--text-primary)" }}>
                      {t.content}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "#4ADE80" }}>● {t.answerMs}ms</span>
                      {t.traceId && <span>trace {t.traceId}</span>}
                    </div>
                  </li>
                ),
              )}
              {status === "loading" && (
                <li className="flex items-center gap-2 text-[14px]" style={{ color: "var(--text-muted)" }}>
                  <span className="inline-block w-2 h-4" style={{ background: "var(--orange-500)", animation: "aikoBlink 1s steps(2,end) infinite" }} />
                  thinking…
                </li>
              )}
              {status === "error" && error && (
                <li className="text-[13px] px-3 py-2.5 rounded-lg flex items-center justify-between gap-3" style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5" }}>
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={retryLast}
                    aria-label="Retry the last question"
                    className="px-2.5 py-1 rounded-md text-[12px] shrink-0 transition-opacity hover:opacity-80"
                    style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                  >
                    ↻ Retry
                  </button>
                </li>
              )}
            </ol>

            {/* US2 — routes/speed reachable on mobile (desktop uses the right rail) */}
            {searchMs != null && sources.length > 0 && (
              <details
                className="lg:hidden max-w-3xl mx-auto mt-6 rounded-xl p-3"
                style={{ border: "1px solid var(--border)", background: "var(--surface-raised, rgba(16,14,12,0.6))" }}
              >
                <summary className="text-[12px] cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                  {sources.length} routes · <span style={{ color: "#4ADE80" }}>{searchMs}ms</span>
                </summary>
                <ul className="grid gap-2 mt-3">
                  {sources.map((s, i) => {
                    const m = (s.metadata || {}) as { name?: string; domain?: string };
                    return (
                      <li key={s.id || i} className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        <span style={{ color: "var(--text-primary)" }}>{m.name || m.domain || s.id}</span>
                        {m.domain && <span style={{ color: "var(--orange-400, #FF6A00)" }}> · {m.domain}</span>}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </div>

          {/* Sources rail — the live unbrowse route shortlist + its latency */}
          <aside className="hidden lg:block border-l overflow-y-auto px-5 py-6" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[12px] uppercase tracking-[0.16em]" style={{ color: "var(--text-muted)" }}>
                Routes
              </span>
              {searchMs != null && (
                <span className="text-[11px] font-mono" style={{ color: "#4ADE80" }}>
                  {sources.length} · {searchMs}ms
                </span>
              )}
            </div>
            {searchMs == null ? (
              <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>searching unbrowse…</p>
            ) : sources.length === 0 ? (
              <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>No cached routes — Aiko answered from the live web.</p>
            ) : (
              <ul className="grid gap-3">
                {sources.map((s, i) => {
                  const m = (s.metadata || {}) as { name?: string; domain?: string; description?: string };
                  return (
                    <li key={s.id || i} className="rounded-xl p-3" style={{ background: "var(--surface-raised, rgba(16,14,12,0.6))", border: "1px solid var(--border)" }}>
                      <div className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
                        {m.name || m.domain || s.id}
                      </div>
                      {m.domain && (
                        <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--orange-400, #FF6A00)" }}>{m.domain}</div>
                      )}
                      {m.description && (
                        <div className="text-[11px] mt-1 line-clamp-2" style={{ color: "var(--text-muted)" }}>{m.description}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}

      {/* Bottom composer (only in active view; idle has its own centered one) */}
      {active && (
        <div className="shrink-0 px-5 sm:px-8 lg:px-16 pb-5 pt-2">
          <div className="max-w-3xl mx-auto">
            <Composer prompt={prompt} setPrompt={setPrompt} onKey={onKey} onSubmit={() => ask(prompt)} inputRef={inputRef} />
            <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <button type="button" onClick={reset} className="hover:opacity-100" style={{ opacity: 0.8 }}>
                ↺ new chat
              </button>
              <span>
                {remaining != null ? `${remaining}/10 free queries left today` : "⏎ to send · ⇧⏎ newline"}
              </span>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes aikoBlink { 0%,50%{opacity:1} 50.01%,100%{opacity:0} }
      `}</style>
    </main>
  );
}

function Composer({
  prompt,
  setPrompt,
  onKey,
  onSubmit,
  inputRef,
  big,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  big?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className={`w-full ${big ? "max-w-2xl" : ""} mx-auto flex items-end gap-2 rounded-[26px] px-4 py-2.5`}
      style={{ background: "var(--surface-raised, rgba(16,14,12,0.85))", border: "1px solid var(--border-strong, rgba(255,82,0,0.32))", boxShadow: "0 8px 40px -20px var(--glow, rgba(255,82,0,0.45))" }}
    >
      <span aria-hidden className="pb-1.5 text-[18px] select-none" style={{ color: "var(--text-muted)" }}>+</span>
      <textarea
        ref={inputRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        rows={1}
        placeholder="Ask Aiko"
        className="flex-1 bg-transparent resize-none focus:outline-none text-[15px] py-1.5"
        style={{ color: "var(--text-primary)", caretColor: "var(--orange-500)", maxHeight: 160 }}
        autoComplete="off"
      />
      <span className="hidden sm:flex items-center gap-1.5 pb-1 px-2.5 py-1 rounded-full text-[12px]" style={{ color: "var(--orange-400, #FF6A00)", border: "1px solid var(--border)" }}>
        ✦ Aiko mode
      </span>
      <button
        type="submit"
        disabled={!prompt.trim()}
        aria-label="Send"
        className="pb-0.5 w-9 h-9 rounded-full grid place-items-center transition-opacity disabled:opacity-30"
        style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}
      >
        ↑
      </button>
    </form>
  );
}
