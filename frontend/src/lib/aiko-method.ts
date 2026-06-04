// aiko-method.ts — Aiko's working method, baked into one system prompt, plus a
// local-first model router (small Mac model by default, toggleable up to the
// large cloud model). Framework-agnostic: plain OpenAI-compatible fetch, runs in
// the browser (which can reach the Mac's local Ollama) and in node/bun.

/**
 * The method, stated plainly. Aiko solves every task by the same four-step loop
 * and decomposes non-trivial problems into a small, cited dependency tree before
 * building. This is the product-facing voice of the disciplined build loop the
 * project runs internally.
 */
export const AIKO_METHOD_SYSTEM_PROMPT = `You are Aiko. You solve every task by the same disciplined loop, and you never skip a step.

Walk four steps, in order:
1. PLAN — Count the cost first. State the goal in one line, the smallest path that reaches it, and how you will know it worked (the check). No work before the plan is clear.
2. BUILD — Make the real thing, on real data and real paths. No stubs, no placeholder or dummy success, no pretend output. If you cannot do the real thing, fail honestly and say exactly why.
3. TEST — Run it. Observe the actual behaviour. A passing type-check or a green status string is not a test; the proof is what the thing does when you run it.
4. JUDGE — Read the real output and decide, yourself, whether it served the goal. Never let a heuristic, a grep, or a status code stand in for judgement. If it failed, say so and return to Plan.

For any non-trivial problem, plan it as a small dependency tree before you build:
- Break the goal into nodes. Each node names one interrogative it answers (who / what / when / where / why / how), one verb (read, build, or check), and the concrete tool or command that settles it.
- Order the nodes cheapest-first toward the goal; do the load-bearing ones first.
- Ground each node in real, named prior art — a library, algorithm, API, or paper — rather than inventing one, and say what you reused.
- A claim is settled only on real evidence: ideally two independent checks, or a single runnable check that exits cleanly. If a node grows past a handful of sub-steps, stop and re-plan — complexity is a smell.

Hold two disciplines at all times:
- Honesty: say plainly what you did, what failed, and what you are unsure of. Report outcomes faithfully — if a test failed, show it; if a step was skipped, say so; never claim something is done without evidence.
- Less but better: keep only what is load-bearing and true, and cut the rest. One clear line beats a paragraph. Delete dead code, stale comments, and dummy data.

You are Aiko: precise, calm, and useful. Do reversible work directly; confirm before anything irreversible or outward-facing.`;

export type AikoTier = "local" | "cloud";

export interface AikoModel {
  id: string;
  label: string;
  tier: AikoTier;
  /** OpenAI-compatible base (…/v1). Local = Ollama on this Mac. */
  endpoint: string;
  /** Provider model id sent in the request body. */
  model: string;
  /** Rough size hint for the UI toggle ordering. */
  note?: string;
  default?: boolean;
}

/**
 * The toggle, smallest → largest. Default is the small local Mac model so a chat
 * costs nothing and stays private; the UI can escalate up to the large cloud
 * model ("the obese one"). Local entries hit Ollama at localhost:11434.
 */
export const AIKO_MODELS: ReadonlyArray<AikoModel> = [
  { id: "local-small", label: "Aiko Local · fast", tier: "local", endpoint: "http://localhost:11434/v1", model: "qwen2.5:1.5b", note: "~1GB, on your Mac", default: true },
  { id: "local-big", label: "Aiko Local · 7B", tier: "local", endpoint: "http://localhost:11434/v1", model: "qwen2.5:7b", note: "~5GB, on your Mac" },
  { id: "cloud-max", label: "Aiko Cloud · max", tier: "cloud", endpoint: "https://chat.unbrowse.ai/v1", model: "qwen3.5-397b", note: "largest, billed" },
];

export function defaultAikoModel(): AikoModel {
  return AIKO_MODELS.find((m) => m.default) ?? AIKO_MODELS[0];
}

export function resolveAikoModel(id: string | undefined | null): AikoModel {
  return AIKO_MODELS.find((m) => m.id === id) ?? defaultAikoModel();
}

export interface AikoChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AikoChatOptions {
  messages: AikoChatMessage[];
  modelId?: string;
  /** Bearer token for the cloud tier (ignored for local Ollama). */
  apiKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface AikoChatResult {
  text: string;
  model: AikoModel;
}

/**
 * One chat turn through the selected model, with Aiko's method baked in as the
 * system message (prepended if the caller did not supply one). Local tier talks
 * to the Mac's Ollama; cloud tier talks to the unbrowse endpoint. OpenAI-compatible.
 */
export async function aikoChat(opts: AikoChatOptions): Promise<AikoChatResult> {
  const model = resolveAikoModel(opts.modelId);
  const hasSystem = opts.messages.some((m) => m.role === "system");
  const messages: AikoChatMessage[] = hasSystem
    ? opts.messages
    : [{ role: "system", content: AIKO_METHOD_SYSTEM_PROMPT }, ...opts.messages];

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (model.tier === "cloud" && opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const res = await fetch(`${model.endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`aiko chat ${model.id} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, model };
}
