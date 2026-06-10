"use client";

/*
 * HeroChat — the homepage chat, backed by a CLIENT-DRIVEN agent loop.
 *
 * The loop runs here in the browser so execution happens on the USER'S OWN
 * CLIENT FIRST — their IP, their cookies (credentials: include) — exactly the
 * Unbrowse principle ("your credentials never leave your machine"). Per round:
 *   1. POST /api/hero-chat/step  → one LLM round (worker holds the model key)
 *   2. if tool_calls:
 *        search_routes / get_route → call beta-api directly (CORS-*)
 *        execute_route → try the user's own fetch() FIRST (any method incl. POST);
 *                        on CORS/network failure, fall back to /api/hero-chat/exec
 *   3. loop until the model returns content
 *
 * If the client loop can't run at all (e.g. /step unreachable), we fall back to
 * the server-only loop at /api/hero-chat.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Streamdown } from "streamdown";
import { getConfiguredApiOrigin } from "@/lib/api-base";
import { searchRoutes, getRoute } from "@/lib/hero-marketplace";
import { parseManifest, urlBelongsToSkill, type SkillManifestLite } from "@/lib/recommend-guard";
import { resolveHoledExecute } from "@/lib/holed-execute";

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

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface LoopMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const LOADING_PHASES = [
  "searching captured routes…",
  "picking the best endpoint…",
  "running it on your browser…",
  "composing the answer…",
];
const MAX_ROUNDS = 6;
const CLIENT_FETCH_TIMEOUT = 9000;

/** Execute a route the way the principle demands: the user's own browser first.
 * Returns the tool output + a label that records which path actually served it. */
async function executeClientFirst(
  args: { url?: string; method?: string; headers?: Record<string, string>; body?: string; skill_id?: string; endpoint_id?: string },
): Promise<{ output: string; label: string; ok: boolean }> {
  const url = String(args.url ?? "");
  const method = (args.method ?? "GET").toUpperCase();
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    return { output: "blocked: invalid url", label: `${method} ${url.slice(0, 60)}`, ok: false };
  }
  if (!url.startsWith("https://")) return { output: "blocked: https only", label: `${method} ${host}`, ok: false };

  const hasBody = method !== "GET" && method !== "HEAD" && args.body != null;
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.5" };
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    const key = k.toLowerCase();
    if (key === "cookie" || key === "host" || key === "content-length") continue;
    headers[k] = String(v);
  }
  if (hasBody && !headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";

  // One client-side attempt with the given credentials mode.
  async function clientAttempt(credentials: RequestCredentials): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLIENT_FETCH_TIMEOUT);
    try {
      return await fetch(url, {
        method,
        headers,
        body: hasBody ? args.body : undefined,
        credentials,
        signal: ctrl.signal,
        redirect: "follow",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // CLIENT-FIRST: try with the user's cookies (logged-in sites that allow
  // credentialed CORS), then without (public CORS APIs reject credentials but
  // serve fine from the user's own IP). Only then fall back to the worker.
  let res: Response | null = null;
  let credentialed = false;
  try {
    res = await clientAttempt("include");
    credentialed = true;
  } catch {
    try {
      res = await clientAttempt("omit");
    } catch {
      res = null;
    }
  }

  if (res) {
    const text = await res.text();
    if (args.skill_id && args.endpoint_id) {
      void fetch("/api/hero-chat/exec/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill_id: args.skill_id, endpoint_id: args.endpoint_id, ok: res.ok, status: res.status }),
      }).catch(() => {});
    }
    const out = text.length > 7000 ? `${text.slice(0, 7000)}\n…[truncated]` : text;
    const tag = credentialed ? "via your browser (with your login)" : "via your browser";
    return { output: `HTTP ${res.status}\n${out}`, label: `${method} ${host} · ${tag}`, ok: res.ok };
  }

  // FALLBACK: the worker proxy (CORS-blocked, mixed-content, etc.).
  try {
    const wres = await fetch("/api/hero-chat/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await wres.json()) as { output?: string; label?: string; ok?: boolean };
    return { output: data.output ?? "execution failed", label: data.label ?? `${method} ${host} · via worker`, ok: !!data.ok };
  } catch (e) {
    return { output: `execution failed: ${e instanceof Error ? e.message : String(e)}`, label: `${method} ${host}`, ok: false };
  }
}

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

  useEffect(() => {
    if (status !== "loading") return;
    setPhase(0);
    const iv = setInterval(() => setPhase((p) => Math.min(p + 1, LOADING_PHASES.length - 1)), 3500);
    return () => clearInterval(iv);
  }, [status]);

  /** Client-driven agent loop. Falls back to the server-only loop on failure. */
  async function runLoop(history: Turn[]): Promise<{ answer: string; steps: HeroStep[]; totalMs: number }> {
    const apiOrigin = getConfiguredApiOrigin();
    const t0 = performance.now();
    const steps: HeroStep[] = [];
    const seenManifests: SkillManifestLite[] = []; // resolved skills, for the execute seal
    const messages: LoopMessage[] = history.map((t) => ({ role: t.role, content: t.content }));

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const stepRes = await fetch("/api/hero-chat/step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (!stepRes.ok) throw new Error(((await stepRes.json().catch(() => ({}))) as { error?: string }).error || `step HTTP ${stepRes.status}`);
      const { message } = (await stepRes.json()) as { message: { content: string | null; tool_calls: ToolCall[] | null } };

      if (message.tool_calls?.length) {
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
        for (const tc of message.tool_calls.slice(0, 3)) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* malformed — tool reports */
          }
          const tStep = performance.now();
          let out: { output: string; label: string; ok: boolean };
          if (tc.function.name === "search_routes") {
            const r = await searchRoutes(apiOrigin, String(parsed.intent ?? ""));
            out = { output: r.output, label: `search · ${String(parsed.intent ?? "").slice(0, 50)}`, ok: r.ok };
          } else if (tc.function.name === "get_route") {
            const r = await getRoute(apiOrigin, String(parsed.skill_id ?? ""));
            // Capture the resolved-skill manifest so execute_route can be sealed
            // to it (path-A brick 3b): the LLM may only execute the skill it resolved.
            const m = r.ok ? parseManifest(r.output) : null;
            if (m) seenManifests.push(m);
            out = { output: r.output, label: `manifest · ${r.domain}`, ok: r.ok };
          } else if (tc.function.name === "execute_route") {
            // verb atom (tool-with-holes): prefer the holed path — the LLM names
            // an endpoint_id of a skill it resolved + supplies hole values, and we
            // BUILD the URL from that manifest's own template. The model can't
            // write an off-skill URL at all. Falls back to the raw-url path
            // (with the seal) for the cold path / older schema. No regression.
            const resolved = resolveHoledExecute(parsed as Parameters<typeof resolveHoledExecute>[0], seenManifests);
            if (resolved.kind === "holed" && !resolved.ok) {
              out = { output: `blocked: ${resolved.reason}. Resolve the skill first, then execute its endpoint_id with the hole values.`, label: `✗ unknown endpoint`, ok: false };
            } else {
              const execUrl = resolved.kind === "holed" ? resolved.url : resolved.url;
              // Seal: if the URL's host belongs to a skill we resolved this loop,
              // it must match one of that skill's endpoints — else the model has
              // wandered off-skill and we refuse (return an error so it re-picks).
              // Holed URLs are template-built so they always pass; the check is
              // defense-in-depth and the real gate for the raw-url cold path.
              const host = (() => { try { return new URL(execUrl).host.toLowerCase(); } catch { return ""; } })();
              const owning = seenManifests.find((mm) =>
                (mm.domain && mm.domain.toLowerCase() === host) ||
                (mm.endpoints ?? []).some((e) => { try { return new URL(e.url ?? e.url_template ?? "").host.toLowerCase() === host; } catch { return false; } }),
              );
              const seal = owning ? urlBelongsToSkill(owning, execUrl) : { ok: true as const };
              if (!seal.ok) {
                out = { output: `blocked: ${seal.reason}. Use only an endpoint from the resolved skill's manifest.`, label: `✗ off-skill url blocked`, ok: false };
              } else {
                const execArgs = resolved.kind === "holed"
                  ? { ...(parsed as Record<string, unknown>), url: resolved.url, method: resolved.method }
                  : parsed;
                out = await executeClientFirst(execArgs as Parameters<typeof executeClientFirst>[0]);
              }
            }
          } else {
            out = { output: `unknown tool: ${tc.function.name}`, label: tc.function.name, ok: false };
          }
          steps.push({ tool: tc.function.name, label: out.label, ms: Math.round(performance.now() - tStep), ok: out.ok });
          messages.push({ role: "tool", tool_call_id: tc.id, content: out.output });
        }
        if (performance.now() - t0 > 20000 || steps.length >= 4) {
          messages.push({ role: "user", content: "(tool budget reached — compose the best final answer NOW from the data you already have; no more tool calls)" });
        }
        continue;
      }

      const answer = (message.content ?? "").trim();
      if (!answer && round < MAX_ROUNDS) {
        messages.push({ role: "user", content: "(your last message was empty — write the final answer now as plain markdown, no tool calls)" });
        continue;
      }
      return { answer, steps, totalMs: Math.round(performance.now() - t0) };
    }
    return { answer: "I ran out of tool budget — try a more specific ask.", steps, totalMs: Math.round(performance.now() - t0) };
  }

  /** Server-only fallback: the whole loop runs on the worker. */
  async function runServerFallback(history: Turn[]): Promise<{ answer: string; steps: HeroStep[]; totalMs: number }> {
    const res = await fetch("/api/hero-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history.map((t) => ({ role: t.role, content: t.content })) }),
    });
    const data = (await res.json()) as { answer?: string; steps?: HeroStep[]; total_ms?: number; error?: string };
    if (!res.ok || !data.answer) throw new Error(data.error || `HTTP ${res.status}`);
    return { answer: data.answer, steps: data.steps ?? [], totalMs: data.total_ms ?? 0 };
  }

  async function ask(text: string) {
    const q = text.trim();
    if (!q || status === "loading") return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setPrompt("");
    setStatus("loading");
    setError(null);

    try {
      let result: { answer: string; steps: HeroStep[]; totalMs: number };
      try {
        result = await runLoop(next);
      } catch {
        // Client loop failed entirely — fall back to the server-only loop.
        result = await runServerFallback(next);
      }
      setTurns([...next, { role: "assistant", content: result.answer, steps: result.steps, totalMs: result.totalMs }]);
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
                        <span className={s.ok ? "text-[rgba(120,220,130,0.8)]" : "text-red-400/80"}>{s.ok ? "✓" : "✗"}</span>{" "}
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
          placeholder="Ask the agent — it runs on your own browser, real website APIs"
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
        Runs on your own browser first ·{" "}
        <Link href="/install" className="underline underline-offset-2 hover:text-[rgba(255,176,96,1)]">
          run it in ElizaOS, Claude, or Cursor →
        </Link>
      </p>
    </div>
  );
}
