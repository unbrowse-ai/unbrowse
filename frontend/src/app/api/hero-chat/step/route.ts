/*
 * POST /api/hero-chat/step — ONE LLM round for the client-driven agent loop.
 *
 * The loop runs in the browser (hero-chat.tsx) so execution can happen on the
 * user's own client first. The worker holds the Nebius key, so each LLM round
 * goes through here: send the full message history, get back the assistant
 * message (content + any tool_calls). The browser executes the tools and calls
 * again. The worker never executes a route in this path — that's the point.
 */

import { systemPrompt, TOOLS, NEBIUS_URL, MODEL } from "@/lib/hero-tools";

export const runtime = "nodejs";
export const maxDuration = 30;

interface InMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) return Response.json({ error: "agent backend not configured" }, { status: 503 });

  let body: { messages?: InMessage[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const history = (body.messages ?? []).slice(-24);
  if (!history.length) return Response.json({ error: "messages required" }, { status: 400 });

  const messages = [{ role: "system", content: systemPrompt() }, ...history];

  let res: Response;
  try {
    res = await fetch(NEBIUS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(28000),
    });
  } catch (e) {
    return Response.json({ error: `llm unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    return Response.json({ error: `llm: HTTP ${res.status} ${errText}` }, { status: 502 });
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: unknown } }[] };
  const msg = data.choices?.[0]?.message;
  if (!msg) return Response.json({ error: "llm returned no message" }, { status: 502 });

  return Response.json({ message: { content: msg.content ?? null, tool_calls: msg.tool_calls ?? null } });
}
