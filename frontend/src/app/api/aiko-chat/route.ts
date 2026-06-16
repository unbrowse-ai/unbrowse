/*
 * POST /api/aiko-chat — streaming proxy to the Aiko endpoint, grounded via unbrowse.
 *
 * The browser posts {messages}. We forward to the Aiko OpenAI-compatible endpoint
 * (AIKO_CHAT_URL) with retriever:"unbrowse" + stream:true, so it grounds external facts
 * through the unbrowse route graph (free, keyless DDG) and streams the answer back.
 * STREAMING is required: a grounded answer takes ~30-50s (route resolve + the model's
 * reasoning), which exceeds a blocking function's budget — streaming is I/O-bound and
 * delivers tokens as they arrive. The final SSE chunk carries x_grounding (the unbrowse
 * source), which we pass through untouched for the client to render.
 *
 * Server-side because the endpoint's WAF 403s the openai-SDK User-Agent (we present a
 * normal browser UA) and to avoid a cross-origin call from the page.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const AIKO_CHAT_URL =
  process.env.AIKO_CHAT_URL ?? "https://aiko-cayden.getfoundry.app/v1/chat/completions";
const AIKO_MODEL = process.env.AIKO_MODEL_ID ?? "aiko-local";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function POST(req: Request): Promise<Response> {
  let messages: ChatMessage[];
  try {
    const body = (await req.json()) as { messages?: ChatMessage[] };
    messages = Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }
  const trimmed = messages.slice(-12).map((m) => ({
    role: m.role,
    content: String(m.content ?? "").slice(0, 8000),
  }));

  let upstream: Response;
  try {
    upstream = await fetch(AIKO_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-aiko-web",
        // The endpoint's WAF 403s the openai-SDK UA; present a normal browser UA.
        "user-agent": "Mozilla/5.0 (compatible; unbrowse-web/1.0; +https://unbrowse.ai)",
      },
      // retriever:"unbrowse" → ground external facts via unbrowse (free DDG). stream → tokens as they come.
      body: JSON.stringify({
        model: AIKO_MODEL,
        retriever: "unbrowse",
        stream: true,
        messages: trimmed,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(58_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: /timeout|abort/i.test(msg) ? "aiko endpoint timed out" : "aiko endpoint unreachable" },
      { status: 504 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 200);
    return Response.json({ error: `aiko endpoint ${upstream.status}`, detail }, { status: 502 });
  }

  // Pass the upstream SSE straight through — the client parses delta.content + the
  // final chunk's x_grounding. No buffering, so first tokens reach the user immediately.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
