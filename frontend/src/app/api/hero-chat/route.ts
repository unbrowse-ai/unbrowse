/*
 * POST /api/hero-chat — server-only full agent loop.
 *
 * This is the NO-JS / SSR / witness fallback. The primary path is the
 * client-driven loop (hero-chat.tsx → /api/hero-chat/step + client-first
 * execution + /api/hero-chat/exec fallback), which runs execution on the
 * user's own browser first. This endpoint runs the whole loop on the worker
 * for callers that can't run the client loop (curl, no-JS, the witness).
 *
 * All execution shares src/lib/hero-exec.ts — any method, incl. POST.
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";
import { systemPrompt, TOOLS, NEBIUS_URL, MODEL } from "@/lib/hero-tools";
import { executeFetch, truncate } from "@/lib/hero-exec";
import { searchRoutes, getRoute } from "@/lib/hero-marketplace";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_TOOL_ROUNDS = 6;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface HeroStep {
  tool: string;
  label: string;
  ms: number;
  ok: boolean;
}

async function runTool(name: string, args: Record<string, unknown>, apiOrigin: string): Promise<{ output: string; label: string; ok: boolean }> {
  if (name === "search_routes") {
    const intent = String(args.intent ?? "");
    const r = await searchRoutes(apiOrigin, intent);
    return { output: r.output, label: `search · ${intent.slice(0, 60)}`, ok: r.ok };
  }
  if (name === "get_route") {
    const r = await getRoute(apiOrigin, String(args.skill_id ?? ""));
    return { output: r.output, label: `manifest · ${r.domain}`, ok: r.ok };
  }
  if (name === "execute_route") {
    const r = await executeFetch({
      url: String(args.url ?? ""),
      method: args.method ? String(args.method) : "GET",
      headers: (args.headers ?? {}) as Record<string, string>,
      body: args.body != null ? String(args.body) : undefined,
      skill_id: args.skill_id ? String(args.skill_id) : undefined,
      endpoint_id: args.endpoint_id ? String(args.endpoint_id) : undefined,
      apiOrigin,
      via: "worker",
    });
    return { output: r.output, label: r.label, ok: r.ok };
  }
  return { output: `unknown tool: ${name}`, label: name, ok: false };
}

export async function POST(req: Request): Promise<Response> {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) return Response.json({ error: "agent backend not configured" }, { status: 503 });

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const userMessages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 4000) }));
  if (!userMessages.length || userMessages[userMessages.length - 1].role !== "user") {
    return Response.json({ error: "last message must be from user" }, { status: 400 });
  }

  const apiOrigin = getConfiguredApiOrigin();
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }, ...userMessages];
  const steps: HeroStep[] = [];
  const t0 = Date.now();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const llmRes = await fetch(NEBIUS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 2000 }),
      signal: AbortSignal.timeout(25000),
    });
    if (!llmRes.ok) {
      const errText = truncate(await llmRes.text(), 300);
      return Response.json({ error: `llm: HTTP ${llmRes.status} ${errText}`, steps }, { status: 502 });
    }
    const data = (await llmRes.json()) as { choices?: { message?: ChatMessage }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) return Response.json({ error: "llm returned no message", steps }, { status: 502 });

    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls.slice(0, 3)) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* malformed args — tool will report */
        }
        const tStep = Date.now();
        let result: { output: string; label: string; ok: boolean };
        try {
          result = await runTool(tc.function.name, parsed, apiOrigin);
        } catch (e) {
          result = { output: `tool error: ${e instanceof Error ? e.message : String(e)}`, label: tc.function.name, ok: false };
        }
        steps.push({ tool: tc.function.name, label: result.label, ms: Date.now() - tStep, ok: result.ok });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.output });
      }
      if (Date.now() - t0 > 18000 || steps.length >= 4) {
        messages.push({ role: "user", content: "(tool budget reached — compose the best final answer NOW from the data you already have; no more tool calls)" });
      }
      continue;
    }

    const answer = (msg.content ?? "").trim();
    if (!answer && round < MAX_TOOL_ROUNDS) {
      messages.push({ role: "assistant", content: "" });
      messages.push({ role: "user", content: "(your last message was empty — write the final answer now as plain markdown, no tool calls)" });
      continue;
    }
    return Response.json({ answer, steps, total_ms: Date.now() - t0 });
  }

  return Response.json({ answer: "I ran out of tool budget before finishing — try a more specific ask.", steps, total_ms: Date.now() - t0 });
}
