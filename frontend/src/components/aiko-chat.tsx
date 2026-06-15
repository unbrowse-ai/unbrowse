"use client";

/*
 * AikoChat — chat backed by the Aiko endpoint, grounded via unbrowse.
 *
 * Posts to /api/aiko-chat (server proxy → the Aiko OpenAI-compatible endpoint with
 * retriever:"unbrowse"). Aiko grounds external facts through the unbrowse route graph
 * (free, keyless DDG) and answers; we show the unbrowse source it grounded on under
 * each answer, so the page demonstrates "the same endpoint + unbrowse" end to end.
 */

import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

const SUGGESTIONS = [
  "What is the capital of Australia?",
  "Who is the CEO of Anthropic?",
  "What is unbrowse?",
];

interface Turn {
  role: "user" | "assistant";
  content: string;
  grounding?: string[];
  retriever?: string | null;
}

type Status = "idle" | "loading" | "error";

export function AikoChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, status]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || status === "loading") return;
    setError(null);
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setInput("");
    setStatus("loading");
    try {
      const res = await fetch("/api/aiko-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = (await res.json()) as {
        content?: string;
        grounding?: string[];
        retriever?: string | null;
        error?: string;
      };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `request failed (${res.status})`);
      }
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "(no answer)",
          grounding: data.grounding ?? [],
          retriever: data.retriever ?? null,
        },
      ]);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "something went wrong");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl text-left">
      <div
        ref={scrollRef}
        className="max-h-[52vh] min-h-[120px] space-y-4 overflow-y-auto rounded-2xl border border-border bg-surface-raised/40 p-4 sm:p-5"
      >
        {turns.length === 0 && (
          <p className="px-1 py-6 text-center text-[14px] text-text-secondary">
            Ask anything. Aiko grounds the answer through unbrowse&apos;s route graph — for free.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                t.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-orange-500/10 px-4 py-2.5 text-[14px] text-text-primary"
                  : "max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-raised px-4 py-2.5 text-[14px] text-text-primary"
              }
            >
              {t.role === "assistant" ? (
                <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1">
                  <Streamdown>{t.content}</Streamdown>
                </div>
              ) : (
                t.content
              )}
              {t.role === "assistant" && t.grounding && t.grounding.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px] text-text-secondary">
                  <span className="font-medium text-orange-500">grounded via unbrowse:</span>
                  {t.grounding.slice(0, 3).map((s, j) => (
                    <span key={j} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono">
                      {prettySource(s)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {status === "loading" && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-surface-raised px-4 py-2.5 text-[14px] text-text-secondary">
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
                grounding through unbrowse…
              </span>
            </div>
          </div>
        )}
      </div>

      {error && <p className="mt-2 px-1 text-[12px] text-red-400">{error}</p>}

      {turns.length === 0 && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="rounded-full border border-border px-3 py-1.5 text-[13px] text-text-secondary transition hover:border-orange-500/50 hover:text-text-primary"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Aiko anything…"
          className="flex-1 rounded-xl border border-border bg-surface-raised px-4 py-3 text-[14px] text-text-primary outline-none placeholder:text-text-secondary focus:border-orange-500/60"
        />
        <button
          type="submit"
          disabled={status === "loading" || !input.trim()}
          className="rounded-xl bg-orange-500 px-4 py-3 text-[14px] font-medium text-white transition hover:bg-orange-600 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

function prettySource(s: string): string {
  try {
    if (s.startsWith("unbrowse:")) return s.slice("unbrowse:".length);
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return s.slice(0, 40);
  }
}
