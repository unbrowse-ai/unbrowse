// Summarizes a successful capture into 5–15 lines of LLM-prose markdown
// describing what worked for that domain. The output is stored verbatim by
// writeDomainNote() and re-injected as prompt context into the LLM augment
// pass on the next capture for the same domain.
//
// HARD CONSTRAINTS:
//  - Notes are LLM-prose only. No code-side per-domain switches.
//  - The deterministic ranker NEVER reads these notes.
//  - This module is THIN: build prompt, call same backend agent-augment uses,
//    parse, return string. No retry/queue/scheduling. Caller decides cadence.
//  - Returns null on any failure — caller treats as "skip the write."

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL =
  process.env.UNBROWSE_AGENT_SEMANTIC_MODEL ??
  process.env.UNBROWSE_AGENT_JUDGE_MODEL ??
  "gpt-4.1-mini";
const SUMMARIZE_TIMEOUT_MS = Number(
  process.env.UNBROWSE_DOMAIN_NOTE_TIMEOUT_MS ?? 8000,
);

type Provider = { url: string; key: string; model: string };

function availableProvider(): Provider | null {
  if (process.env.OPENAI_API_KEY) {
    return { url: OPENAI_CHAT_URL, key: process.env.OPENAI_API_KEY, model: DEFAULT_MODEL };
  }
  if (process.env.NEBIUS_API_KEY) {
    return { url: CHAT_URL, key: process.env.NEBIUS_API_KEY, model: DEFAULT_MODEL };
  }
  return null;
}

export interface SummarizeInput {
  domain: string;
  intent: string;
  endpoints: Array<{
    method: string;
    url_template: string;
    description?: string;
  }>;
  notable_patterns: {
    auth_required: boolean;
    spa_framework_detected: string | null;
    extraction_method: string | null;
    sample_field_names: string[];
  };
  prior_note: string | null;
}

const SYSTEM_PROMPT = [
  "You write extraction-notes for a web automation system.",
  "You are extending an existing note (if one was passed). 5–15 lines max.",
  "Cover: what records this page exposes; where they live in the SSR/DOM;",
  "auth state needed; what was tried before that failed; URL parameter semantics.",
  "NO code blocks unless quoting a single short selector.",
  "NO marketing tone. Be terse. Plain markdown only.",
  "Return your note as a JSON object: {\"note\": \"...markdown...\"}.",
].join("\n");

export async function summarizeCaptureToNote(
  input: SummarizeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const provider = availableProvider();
  if (!provider) return null;
  if (!input.endpoints || input.endpoints.length === 0) return null;

  const userPayload = {
    domain: input.domain,
    intent: input.intent,
    endpoints: input.endpoints.slice(0, 12).map((e) => ({
      method: e.method,
      url_template: e.url_template,
      description: e.description ?? null,
    })),
    notable_patterns: input.notable_patterns,
    prior_note: input.prior_note ?? null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return null;
  }
  clearTimeout(timeout);
  if (!res.ok) return null;
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    return null;
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") return null;
  let asJson: { note?: unknown };
  try {
    asJson = JSON.parse(content) as { note?: unknown };
  } catch {
    return null;
  }
  const note = asJson.note;
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
