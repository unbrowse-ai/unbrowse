"use client";

/* Hallmark · pre-emit critique: P4 H4 E5 S5 R5 V5
 *
 * Console-rhythm chat widget — single composer at the bottom, response stream
 * above. Brand-locked to unbrowse orange-on-near-black; no generic chat-bubble
 * pattern. Autonomous-via-unbrowse-CLI callout is in the widget body so people
 * see that the same answer is reachable from an agent's CLI.
 *
 * Architecture (live):
 *  - Hits chat.unbrowse.ai (CORS open).  10 free queries / IP / day.
 *  - Response carries x_billing_mode + x_queries_remaining + x_trace_id.
 *  - Reasoning layer runs invisibly; user sees prose only.
 *  - On 402 we surface the buy-credits CTA pointing at the hosted page.
 */

import { useEffect, useId, useRef, useState } from "react";
import { AIKO_MODELS, AIKO_METHOD_SYSTEM_PROMPT, aikoChatStream, defaultAikoModel, resolveAikoModel } from "@/lib/aiko-method";

const O = "#FF7A20";
const O_DIM = "rgba(255,122,32,0.40)";
const O_HI = "#FFB060";
const G = "#4ADE80";

const PUBLIC_LABEL = "chat.unbrowse.ai";

const STARTERS = [
  "What's the cheapest way to fly SFO → SIN next month?",
  "Explain Unbrowse like I'm a senior backend engineer.",
  "Compare shadow APIs vs Playwright in one paragraph.",
];

type Status = "idle" | "loading" | "ok" | "error" | "exhausted";

interface Turn {
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  latencyMs?: number;
}

export function AskAnythingChat() {
  const inputId = useId();
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [billingMode, setBillingMode] = useState<"free" | "paid" | null>(null);
  const [modelId, setModelId] = useState<string>(defaultAikoModel().id);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  useEffect(() => {
    // Autosize textarea up to 5 rows
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 5 * 20 + 18)}px`;
  }, [prompt]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || status === "loading" || status === "exhausted") return;
    const next: Turn[] = [...turns, { role: "user", content: trimmed }];
    setTurns(next);
    setPrompt("");
    setStatus("loading");
    setError(null);
    scrollToBottom();

    const started = performance.now();
    try {
      // Aiko's method is baked in as the system message for every model; the
      // toggle routes local tiers to the Mac's Ollama, cloud to the unbrowse endpoint.
      const model = resolveAikoModel(modelId);

      // Local tier streams tokens live — the chat paints as the model thinks
      // instead of dead air, then one blob. (Cloud keeps the billing-aware path
      // below so 402 / remaining-credits handling is preserved.)
      if (model.tier === "local") {
        setTurns([...next, { role: "assistant", content: "" }]);
        scrollToBottom();
        let acc = "";
        for await (const delta of aikoChatStream({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
          modelId,
          maxTokens: 1500,
        })) {
          acc += delta;
          setTurns((cur) => {
            const copy = cur.slice();
            copy[copy.length - 1] = { role: "assistant", content: acc };
            return copy;
          });
          scrollToBottom();
        }
        const elapsedLocal = Math.round(performance.now() - started);
        setTurns((cur) => {
          const copy = cur.slice();
          copy[copy.length - 1] = {
            role: "assistant",
            content: acc || "(empty response)",
            latencyMs: elapsedLocal,
          };
          return copy;
        });
        setBillingMode("free");
        setStatus("ok");
        scrollToBottom();
        return;
      }

      const messages = [
        { role: "system", content: AIKO_METHOD_SYSTEM_PROMPT },
        ...next.map((t) => ({ role: t.role, content: t.content })),
      ];
      const res = await fetch(`${model.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.model, messages, max_tokens: 1500 }),
      });
      const elapsed = Math.round(performance.now() - started);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      if (res.status === 402) {
        setStatus("exhausted");
        setError(data?.error?.message || "Free tier exhausted for today.");
        scrollToBottom();
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setError(data?.error?.message || `HTTP ${res.status}`);
        scrollToBottom();
        return;
      }
      const content: string = data?.choices?.[0]?.message?.content || "(empty response)";
      const traceId: string | undefined =
        data?.x_trace_id || res.headers.get("x-trace-id") || undefined;
      const mode = data?.x_billing_mode as "free" | "paid" | undefined;
      const rem =
        typeof data?.x_queries_remaining === "number"
          ? data.x_queries_remaining
          : typeof data?.x_credits_remaining === "number"
            ? Math.round(data.x_credits_remaining)
            : null;
      if (mode) setBillingMode(mode);
      if (rem != null) setRemaining(rem);
      setTurns([...next, { role: "assistant", content, traceId, latencyMs: elapsed }]);
      setStatus("ok");
      scrollToBottom();
    } catch (err) {
      setStatus("error");
      setError((err as Error).message || "Request failed.");
    }
  }

  function reset() {
    setTurns([]);
    setStatus("idle");
    setError(null);
    setPrompt("");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(prompt);
    }
  }

  const showStarters = turns.length === 0 && status === "idle";
  // Once tokens are streaming into the last assistant turn, the growing text IS
  // the "it's alive" affordance — don't also show a redundant "thinking" row.
  const last = turns[turns.length - 1];
  const streamingNow = last?.role === "assistant" && last.content.length > 0;

  return (
    <div
      className="relative w-full mx-auto overflow-hidden flex flex-col"
      style={{
        background: "linear-gradient(180deg, rgba(8,5,2,0.96), rgba(6,4,2,0.92))",
        border: `1px solid ${O_DIM}`,
        borderRadius: 4,
        boxShadow:
          "0 0 0 1px rgba(255,122,32,0.06), 0 1px 0 rgba(255,255,255,0.02) inset, 0 30px 80px -30px rgba(255,122,32,0.28)",
        minHeight: 540,
      }}
    >
      {/* Title bar — terminal chrome, brand-locked */}
      <div
        className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-2"
        style={{ borderBottom: `1px solid ${O_DIM}`, background: "rgba(255,122,32,0.045)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1.5">
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "rgba(255,122,32,0.45)" }} />
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "rgba(255,176,96,0.35)" }} />
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "rgba(108,255,175,0.45)" }} />
          </span>
          <span className="text-[11px] font-mono uppercase tracking-[0.2em]" style={{ color: O }}>
            ask anything — live model
          </span>
        </div>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          aria-label="Model"
          className="text-[10px] font-mono bg-transparent outline-none cursor-pointer"
          style={{ color: O_DIM, border: `1px solid ${O_DIM}`, borderRadius: 3, padding: "2px 6px" }}
          title="Model — local runs free on your Mac; cloud is the largest"
        >
          {AIKO_MODELS.map((m) => (
            <option key={m.id} value={m.id} style={{ background: "#0b0805", color: O_HI }}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {/* Stream area — answers appear here, scrolls up as conversation grows */}
      <div
        ref={scrollerRef}
        className="flex-1 px-4 sm:px-6 py-5 overflow-y-auto"
        style={{ maxHeight: 460 }}
      >
        {turns.length === 0 ? (
          <EmptyConsole />
        ) : (
          <ol className="grid gap-4">
            {turns.map((t, idx) => (
              <li key={idx} className="grid gap-1.5">
                {t.role === "user" ? (
                  <div className="flex items-baseline gap-2 font-mono">
                    <span style={{ color: O }} className="text-[12px] select-none">
                      ▸
                    </span>
                    <span className="text-[13px] whitespace-pre-wrap" style={{ color: O_HI }}>
                      {t.content}
                    </span>
                  </div>
                ) : (
                  <div className="grid gap-1.5 pl-4 sm:pl-5">
                    <div
                      className="text-[14px] leading-relaxed whitespace-pre-wrap"
                      style={{ color: "rgba(255,250,242,0.95)" }}
                    >
                      {t.content}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-mono">
                      <span style={{ color: G }}>● {t.latencyMs}ms</span>
                      {t.traceId && (
                        <span style={{ color: O_DIM }}>trace {t.traceId}</span>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
            {status === "loading" && !streamingNow && (
              <li className="flex items-center gap-2 pl-4 sm:pl-5 text-[12px] font-mono" style={{ color: O_DIM }}>
                <span className="inline-block w-1.5 h-3 align-middle" style={{ background: O, animation: "blink 1s steps(2, end) infinite" }} />
                <span>thinking</span>
              </li>
            )}
            {status === "error" && error && <ErrorRow message={error} />}
            {status === "exhausted" && <ExhaustedRow message={error || ""} />}
          </ol>
        )}
      </div>

      {/* Composer + status rail */}
      <div className="px-4 sm:px-5 pt-3 pb-3" style={{ borderTop: `1px solid ${O_DIM}` }}>
        {showStarters && (
          <div className="grid gap-1.5 mb-3">
            <span className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: O_DIM }}>
              try
            </span>
            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setPrompt(s);
                    textareaRef.current?.focus();
                  }}
                  className="text-left text-[11px] font-mono px-2 py-1 rounded-sm transition-colors"
                  style={{
                    background: "rgba(255,122,32,0.05)",
                    border: `1px solid ${O_DIM}`,
                    color: O_HI,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,122,32,0.12)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,122,32,0.05)")}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(prompt);
          }}
          className="flex items-end gap-2"
        >
          <span
            className="font-mono select-none pb-2 hidden sm:inline"
            style={{ color: O, fontSize: 14 }}
            aria-hidden="true"
          >
            ▸
          </span>
          <label htmlFor={inputId} className="sr-only">
            ask anything
          </label>
          <textarea
            id={inputId}
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            placeholder="ask anything"
            rows={1}
            className="flex-1 px-2.5 py-2 text-sm font-mono rounded-sm focus:outline-none resize-none"
            style={{
              background: "transparent",
              border: `1px solid ${O_DIM}`,
              color: O_HI,
              caretColor: O,
              minHeight: 38,
              lineHeight: "20px",
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={status === "loading" || status === "exhausted"}
          />
          <button
            type="submit"
            disabled={status === "loading" || status === "exhausted" || !prompt.trim()}
            className="px-4 py-2 text-xs font-mono uppercase tracking-[0.18em] rounded-sm transition-opacity disabled:opacity-40 whitespace-nowrap"
            style={{
              background: O,
              color: "#0c0500",
              border: `1px solid ${O}`,
              boxShadow: "0 0 12px rgba(255,122,32,0.35)",
              minHeight: 38,
            }}
          >
            {status === "loading" ? "…" : "send"}
          </button>
        </form>

        <div className="mt-2.5 flex items-center justify-between gap-3 text-[10px] font-mono flex-wrap" style={{ color: O_DIM }}>
          <span>
            {turns.length > 0 ? (
              <button type="button" onClick={reset} style={{ color: O_DIM }} className="hover:text-orange-500 transition-colors">
                new chat ↺
              </button>
            ) : (
              <>⏎ to send · ⇧⏎ for newline</>
            )}
          </span>
          <span>
            {remaining != null && billingMode === "free" ? (
              <>
                <span style={{ color: remaining > 2 ? G : remaining > 0 ? O_HI : "#f87171" }}>{remaining}</span>
                <span> / 10 free queries left today</span>
              </>
            ) : remaining != null && billingMode === "paid" ? (
              <>
                <span style={{ color: G }}>{remaining}</span>
                <span> credits remaining</span>
              </>
            ) : (
              <>10 free queries / day · no key required</>
            )}
          </span>
        </div>
      </div>

      {/* Autonomous-via-CLI callout — the "you can do this from your agent too" reminder */}
      <div
        className="px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3 flex-wrap"
        style={{
          borderTop: `1px solid ${O_DIM}`,
          background: "rgba(255,122,32,0.025)",
        }}
      >
        <span className="text-[10.5px] font-mono leading-relaxed" style={{ color: "rgba(255,176,96,0.7)" }}>
          <span style={{ color: O_HI }}>agents do this autonomously</span> — same model, OpenAI-compatible, from the CLI or any MCP host.
        </span>
        <code
          className="text-[11px] font-mono px-2 py-1 rounded-sm whitespace-nowrap"
          style={{
            background: "rgba(255,122,32,0.08)",
            color: O,
            border: `1px solid ${O_DIM}`,
          }}
        >
          npx unbrowse setup --mcp
        </code>
      </div>

      <style jsx>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function EmptyConsole() {
  return (
    <div className="grid gap-3 font-mono text-[12px]" style={{ color: O_DIM }}>
      <div className="flex items-baseline gap-2">
        <span style={{ color: O }}>$</span>
        <span style={{ color: O_HI }}>ask anything</span>
      </div>
      <div style={{ color: "rgba(255,176,96,0.55)" }}>
        Direct prose answers. No scaffolding, no chain-of-thought leak, no JSON dumps.
      </div>
      <div className="text-[11px]" style={{ color: O_DIM }}>
        10 free queries per IP per day · OpenAI-compatible at <span style={{ color: O_HI }}>{PUBLIC_LABEL}/v1/chat/completions</span>
      </div>
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <li
      className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-sm"
      style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5" }}
    >
      <span style={{ color: "#f87171" }}>error:</span> {message}
    </li>
  );
}

function ExhaustedRow({ message }: { message: string }) {
  return (
    <li
      className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-sm grid gap-2"
      style={{ background: "rgba(255,122,32,0.04)", border: `1px solid ${O_DIM}`, color: O_DIM }}
    >
      <p>
        <span style={{ color: "#f87171" }}>quota:</span> {message}
      </p>
      <p>Top up with a credit pack — Hobby $5 (1k credits), Pro $20 (5k), Scale $100 (30k).</p>
      <a
        href="https://chat.unbrowse.ai"
        target="_blank"
        rel="noopener"
        className="inline-block px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] rounded-sm w-fit"
        style={{
          background: O,
          color: "#0c0500",
          border: `1px solid ${O}`,
          boxShadow: "0 0 12px rgba(255,122,32,0.35)",
        }}
      >
        buy credits →
      </a>
    </li>
  );
}
