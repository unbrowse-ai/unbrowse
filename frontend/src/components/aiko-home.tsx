"use client";

/*
 * Aiko — the chat homepage for Unbrowse. Reconstructed flow (Konmari).
 *
 * ONE continuous surface: the composer centers when empty and docks to the bottom
 * when a conversation exists (a single <Composer/> instance, no hard idle/active
 * swap). ONE responsive <SourcesCard/> renders the live unbrowse route shortlist
 * under the latest answer (no desktop-only rail + mobile-details duplication).
 *
 * Every turn fires two live calls in parallel so search speed is visible:
 *   answer  → chat.unbrowse.ai/v1/chat/completions (the Aiko agent, with latency)
 *   sources → POST /v1/search (the real route shortlist, with its own ms)
 *
 * Kept (sparks joy): greeting, suggestion chips, latency proof, error retry,
 * conversation memory, keyboard-first, screen-reader announcements, in-flow auth.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Streamdown } from "streamdown";
import { useAuth } from "@/lib/auth-context";
import { searchSkills, type SearchResult } from "@/lib/api";
import { GenerativeUI, extractUiSpec, GENUI_SYSTEM_PROMPT } from "@/components/generative-ui";

const CHAT_ENDPOINT = "https://chat.unbrowse.ai/v1/chat/completions";

// One-line product grounding, prepended to the first user turn (the backend
// rejects a client system message). Without it the agent doesn't know its own
// product and hallucinates on "what is unbrowse?". Kept short and factual —
// numbers match the published 94-domain benchmark (arXiv:2604.00694).
const AIKO_PRODUCT_CONTEXT =
  "(Context — answer using this when relevant: Unbrowse turns any website into a reusable API route for AI agents. Capture a site once, replay it as a fast API forever; a peer-reviewed 94-domain benchmark shows 3.6× mean speedup and far fewer tokens than a fresh browser session. It runs as an MCP server, CLI, and SDK.)";

const SUGGESTIONS = [
  "Cheapest SFO → SIN flight next month",
  "Compare memory foam vs hybrid mattresses",
  "Top stories on Hacker News right now",
  "Free local events happening this week",
];

// A real json-render spec — proves the generative-UI pipeline end-to-end (the
// themed catalog rendering through <Renderer>). The live agent will emit specs
// like this once the chat.unbrowse.ai system prompt is taught to (backend change);
// this demo renders one now so the capability is visible.
const DEMO_UI_SPEC = '```json-ui\n' + JSON.stringify({
  root: "row",
  elements: {
    row: { type: "Row", props: {}, children: ["c1", "c2"] },
    c1: { type: "Card", props: { title: "Memory foam" }, children: ["b1", "s1", "t1"] },
    b1: { type: "Badge", props: { text: "contouring" } },
    s1: { type: "Stat", props: { label: "Best for", value: "pressure relief" } },
    t1: { type: "Text", props: { text: "Sinks and cradles the body; sleeps warmer; slower response." } },
    c2: { type: "Card", props: { title: "Hybrid" }, children: ["b2", "s2", "t2"] },
    b2: { type: "Badge", props: { text: "bouncy" } },
    s2: { type: "Stat", props: { label: "Best for", value: "airflow + support" } },
    t2: { type: "Text", props: { text: "Coils plus foam; cooler, more responsive, better edge support." } },
  },
}) + '\n```';

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
  const hasConvo = turns.length > 0;

  // autosize the prompt
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  // US3 — conversation remembered across reloads.
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
      /* non-fatal */
    }
  }, [turns]);

  // US6 — keyboard-first: "/" focuses the prompt, Esc starts a new chat.
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
    setSources([]);
    setSearchMs(null);
    scrollDown();

    // Real unbrowse search in parallel — the "how fast is search" demo.
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
      // NOTE: chat.unbrowse.ai prepends its own system prompt and 400s on a
      // client system message ("System message must be at the beginning"), so we
      // cannot ground the model with a system role. Without grounding it doesn't
      // know its own product and answers "what is unbrowse?" with a hallucinated
      // guess. Workaround (verified against the live endpoint): prepend a one-line
      // product context to the FIRST user turn — accepted, and it produces an
      // accurate self-description. We mutate only the API payload, never the
      // displayed `turns`, so the chat shows the user's clean text.
      // (Same constraint blocks client-side generative UI; the json-ui instruction
      // still needs to live in the BACKEND system prompt.)
      const messages = next.map((t) => ({ role: t.role, content: t.content }));
      const firstUser = messages.findIndex((m) => m.role === "user");
      if (firstUser >= 0) {
        messages[firstUser] = {
          ...messages[firstUser],
          content: `${AIKO_PRODUCT_CONTEXT}\n\n${messages[firstUser].content}`,
        };
      }
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The agent model is a reasoning model: its thinking tokens count against
        // max_tokens, so a 1500-cap was spent entirely on reasoning and left
        // `content` null — every answer rendered as "(empty response)". Disable
        // thinking so it emits the answer directly (also far faster: no 15s think).
        // stream:true → the endpoint emits OpenAI-style SSE; we paint tokens live.
        body: JSON.stringify({ messages, max_tokens: 1500, stream: true, chat_template_kwargs: { enable_thinking: false } }),
      });
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try {
          const e = (await res.json()) as { error?: { message?: string } };
          msg = e?.error?.message || msg;
        } catch { /* non-JSON error body */ }
        setStatus("error");
        setError(msg);
        return;
      }

      // Append one assistant turn, then grow its content as SSE chunks arrive.
      // Frame shape (verified live): `event: trace` → {id, credits_reserved,
      // mode}; then `data: {choices:[{delta:{content}}]}` token chunks; `[DONE]`.
      type StreamChunk = {
        id?: string;
        credits_reserved?: number;
        x_queries_remaining?: number;
        choices?: { delta?: { content?: string } }[];
      };
      const assistantIndex = next.length;
      setTurns([...next, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let buffer = "";
      let traceId: string | undefined;
      let painted = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            const m = line.match(/^data:\s?(.*)$/);
            if (!m) continue;
            const payload = m[1].trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk: StreamChunk;
            try { chunk = JSON.parse(payload) as StreamChunk; } catch { continue; }
            // Trace/control frame (no choices): capture id + remaining quota.
            if (!chunk.choices && (chunk.id || chunk.credits_reserved !== undefined)) {
              traceId = traceId ?? chunk.id;
              if (typeof chunk.x_queries_remaining === "number") setRemaining(chunk.x_queries_remaining);
              continue;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) {
              acc += delta;
              if (!painted) { painted = true; setStatus("ok"); }
              setTurns((cur) => {
                const copy = cur.slice();
                const t = copy[assistantIndex];
                if (t && t.role === "assistant") copy[assistantIndex] = { ...t, content: acc };
                return copy;
              });
              scrollDown();
            }
          }
        }
      }
      const elapsed = Math.round(performance.now() - tAns);
      setTurns((cur) => {
        const copy = cur.slice();
        const t = copy[assistantIndex];
        if (t && t.role === "assistant") {
          copy[assistantIndex] = { ...t, content: acc || "(empty response)", traceId, answerMs: elapsed };
        }
        return copy;
      });
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

  // Generative-UI demo: render a real json-render spec through the themed catalog,
  // proving the pipeline without depending on the backend emitting specs yet.
  function showDemo() {
    setSources([]);
    setSearchMs(null);
    setError(null);
    setTurns([
      { role: "user", content: "Show me generative UI" },
      { role: "assistant", content: DEMO_UI_SPEC, answerMs: 0 },
    ]);
    setStatus("ok");
  }

  // US4 — error recovery: re-run the last user turn without a duplicate append.
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

  const lastAssistantIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "assistant") return i;
    return -1;
  })();

  return (
    <main
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: 70, background: "var(--surface, #0a0908)", color: "var(--text-primary, #F5F3EF)" }}
    >
      {/* Top bar — wordmark, the-rest-hidden-but-reachable nav, in-flow auth */}
      <header className="flex items-center justify-between px-5 sm:px-8 h-14 shrink-0">
        <button type="button" onClick={reset} aria-label="New chat" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: "var(--orange-500, #FF5200)", boxShadow: "0 0 12px var(--glow, rgba(255,82,0,0.45))" }} />
          Aiko
          <span className="text-[11px] font-normal px-1.5 py-0.5 rounded-full" style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}>aiko-0.8b</span>
        </button>
        <nav className="flex items-center gap-2 sm:gap-3 text-[13px]">
          <Link href="/classic" className="hidden sm:inline" style={{ color: "var(--text-muted)" }}>About</Link>
          <Link href="/dashboard" className="hidden sm:inline" style={{ color: "var(--text-muted)" }}>Dashboard</Link>
          {isAuthenticated ? (
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px]" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }} title="Signed in">
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: "#4ADE80" }} />
              {agentName || "Account"}
            </span>
          ) : (
            <Link href="/account" aria-label="Sign in or connect wallet" className="px-4 py-1.5 rounded-full text-[13px] font-medium" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
              Sign in · connect wallet
            </Link>
          )}
        </nav>
      </header>

      {/* One continuous body: scroller (only when there's a conversation) + a
          single composer block that centers when empty, docks when active. */}
      <div className="flex-1 flex flex-col min-h-0">
        {hasConvo && (
          <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 sm:px-8 lg:px-16 py-6">
            <ol role="log" aria-live="polite" aria-label="Conversation with Aiko" className="max-w-3xl mx-auto grid gap-7">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <li key={i} className="flex justify-end">
                    <span className="px-4 py-2 rounded-2xl text-[15px]" style={{ background: "var(--surface-raised, rgba(255,82,0,0.08))", border: "1px solid var(--border)", color: "var(--text-primary)" }}>
                      {t.content}
                    </span>
                  </li>
                ) : (
                  <li key={i} className="grid gap-2">
                    {(() => {
                      const spec = extractUiSpec(t.content);
                      return spec ? (
                        <GenerativeUI spec={spec} />
                      ) : (
                        <div className="aiko-md text-[15px] leading-[1.7]" style={{ color: "var(--text-primary)" }}>
                          <Streamdown>{t.content}</Streamdown>
                        </div>
                      );
                    })()}
                    <div className="flex items-center gap-3 text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "#4ADE80" }}>● {t.answerMs}ms</span>
                      {t.traceId && <span>trace {t.traceId}</span>}
                    </div>
                    {i === lastAssistantIdx && <SourcesCard sources={sources} ms={searchMs} />}
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
                  <button type="button" onClick={retryLast} aria-label="Retry the last question" className="px-2.5 py-1 rounded-md text-[12px] shrink-0" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>↻ Retry</button>
                </li>
              )}
            </ol>
          </div>
        )}

        <div className={hasConvo ? "shrink-0 px-5 sm:px-8 lg:px-16 pb-5 pt-2" : "flex-1 flex flex-col items-center justify-center px-5 -mt-8"}>
          {!hasConvo && (
            <h1 className="text-[26px] sm:text-[34px] text-center mb-8 font-medium" style={{ color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
              Hi, {greetName}. <span style={{ color: "var(--text-secondary)" }}>What&apos;s on your mind?</span>
            </h1>
          )}

          <div className={`w-full mx-auto ${hasConvo ? "max-w-3xl" : "max-w-2xl"}`}>
            <Composer prompt={prompt} setPrompt={setPrompt} onKey={onKey} onSubmit={() => ask(prompt)} inputRef={inputRef} />
            {hasConvo && (
              <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                <button type="button" onClick={reset}>↺ new chat</button>
                <span>{remaining != null ? `${remaining}/10 free queries left today` : "⏎ send · ⇧⏎ newline · / focus · Esc new"}</span>
              </div>
            )}
          </div>

          {!hasConvo && (
            <>
              <div className="mt-5 flex flex-wrap gap-2 justify-center max-w-2xl">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => ask(s)} className="flex items-center gap-2 px-3.5 py-2 rounded-full text-[13px]" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)", background: "var(--surface-raised, rgba(16,14,12,0.6))" }}>
                    <span aria-hidden style={{ color: "var(--orange-400, #FF6A00)" }}>↗</span>
                    {s}
                  </button>
                ))}
                <button type="button" onClick={showDemo} className="flex items-center gap-2 px-3.5 py-2 rounded-full text-[13px]" style={{ border: "1px solid var(--border-strong, rgba(255,82,0,0.32))", color: "var(--orange-400, #FF6A00)", background: "var(--surface-raised, rgba(16,14,12,0.6))" }}>
                  ✦ See generative UI
                </button>
              </div>
              <p className="mt-8 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Answers run live through Unbrowse routes · 10 free queries/day · no key required
              </p>
            </>
          )}
        </div>
      </div>

      <style jsx global>{`@keyframes aikoBlink { 0%,50%{opacity:1} 50.01%,100%{opacity:0} }`}</style>
    </main>
  );
}

// One responsive sources pattern — the live unbrowse route shortlist + its
// latency, collapsible, identical on mobile and desktop (Konmari: replaces the
// old desktop rail + mobile <details> duplication). The speed is visible in the
// summary without expanding.
function SourcesCard({ sources, ms }: { sources: SearchResult[]; ms: number | null }) {
  if (ms == null) {
    return <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>searching unbrowse…</div>;
  }
  if (!sources.length) {
    return <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No cached routes — answered from the live web · {ms}ms</div>;
  }
  return (
    <details className="rounded-xl" style={{ border: "1px solid var(--border)", background: "var(--surface-raised, rgba(16,14,12,0.5))" }}>
      <summary className="px-3 py-2 text-[12px] cursor-pointer flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
        <span aria-hidden style={{ color: "var(--orange-400, #FF6A00)" }}>◆</span>
        {sources.length} unbrowse routes · <span style={{ color: "#4ADE80" }}>{ms}ms</span>
      </summary>
      <ul className="px-3 pb-3 grid gap-2">
        {sources.map((s, i) => {
          const m = (s.metadata || {}) as { name?: string; domain?: string; description?: string };
          return (
            <li key={s.id || i} className="text-[12px]">
              <span style={{ color: "var(--text-primary)" }}>{m.name || m.domain || s.id}</span>
              {m.domain && <span style={{ color: "var(--orange-400, #FF6A00)" }}> · {m.domain}</span>}
              {m.description && <div className="line-clamp-1" style={{ color: "var(--text-muted)" }}>{m.description}</div>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Composer({
  prompt,
  setPrompt,
  onKey,
  onSubmit,
  inputRef,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="w-full flex items-end gap-2 rounded-[26px] px-4 py-2.5"
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
        aria-label="Ask Aiko"
        className="flex-1 bg-transparent resize-none focus:outline-none text-[15px] py-1.5"
        style={{ color: "var(--text-primary)", caretColor: "var(--orange-500)", maxHeight: 160 }}
        autoComplete="off"
      />
      <span className="hidden sm:flex items-center gap-1.5 pb-1 px-2.5 py-1 rounded-full text-[12px]" style={{ color: "var(--orange-400, #FF6A00)", border: "1px solid var(--border)" }}>✦ Aiko mode</span>
      <button type="submit" disabled={!prompt.trim()} aria-label="Send" className="pb-0.5 w-9 h-9 rounded-full grid place-items-center transition-opacity disabled:opacity-30" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>↑</button>
    </form>
  );
}
