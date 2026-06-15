/*
 * POST /api/aiko-chat — proxy to the Aiko endpoint, grounded via unbrowse.
 *
 * The browser posts {messages}. We forward to the Aiko OpenAI-compatible endpoint
 * (AIKO_CHAT_URL) with retriever:"unbrowse" so it grounds external facts through the
 * unbrowse route graph (free, keyless DDG fallback) — the same endpoint + unbrowse the
 * CLI uses. Server-side because (a) the endpoint's WAF blocks the openai-SDK User-Agent
 * (we present a normal browser UA), and (b) it avoids a cross-origin call from the page.
 *
 * Returns { content, grounding } where grounding is the first unbrowse source the
 * endpoint cited (so the UI can show "grounded via unbrowse: <source>").
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const AIKO_CHAT_URL =
  process.env.AIKO_CHAT_URL ?? "https://aiko-cayden.getfoundry.app/v1/chat/completions";
const AIKO_MODEL = process.env.AIKO_MODEL_ID ?? "aiko-local";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
interface GroundingHit {
  source?: string;
  text?: string;
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
  // Keep the payload bounded — last 12 turns is plenty of context for a grounded answer.
  const trimmed = messages.slice(-12).map((m) => ({
    role: m.role,
    content: String(m.content ?? "").slice(0, 8000),
  }));

  try {
    const upstream = await fetch(AIKO_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The endpoint accepts an open key; a real value isn't required.
        authorization: "Bearer sk-aiko-web",
        // Present a normal browser UA — the endpoint's WAF 403s the openai-SDK UA.
        "user-agent": "Mozilla/5.0 (compatible; unbrowse-web/1.0; +https://unbrowse.ai)",
      },
      // retriever:"unbrowse" → the endpoint grounds external facts via unbrowse (free DDG).
      body: JSON.stringify({
        model: AIKO_MODEL,
        retriever: "unbrowse",
        messages: trimmed,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(28_000),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      return Response.json(
        { error: `aiko endpoint ${upstream.status}`, detail },
        { status: 502 },
      );
    }

    const data = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      x_grounding?: GroundingHit[];
      x_control?: { retriever?: string; lane?: string };
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const grounding = (data.x_grounding ?? [])
      .map((g) => g.source)
      .filter((s): s is string => Boolean(s));

    return Response.json({
      content,
      grounding,
      retriever: data.x_control?.retriever ?? null,
      lane: data.x_control?.lane ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|abort/i.test(msg);
    return Response.json(
      { error: timedOut ? "aiko endpoint timed out" : "aiko endpoint unreachable", detail: msg.slice(0, 200) },
      { status: 504 },
    );
  }
}
