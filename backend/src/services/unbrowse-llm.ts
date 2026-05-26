import type { Env } from "../types.js";

export interface UnbrowseLlmBinding {
  chatUrl: string;
  headers: Record<string, string>;
}

export interface AikoCompiledContract {
  prompt: string;
  posthook_pointer?: string;
  wallet_identity?: string;
  replicated_from_contract_id?: string;
  network_tunnel_contract_id?: string;
  network_tunnel_kind?: string;
  evaluators: AikoCompiledEvaluator[];
  children: AikoCompiledContract[];
}

export interface AikoCompiledEvaluator {
  prompt: string;
  metric: AikoCompiledMetric;
}

export interface AikoCompiledMetric {
  source: "api" | "ledger" | "external";
  pointer: string;
  assertion: string;
}

export function getUnbrowseLlmBinding(env: Env): UnbrowseLlmBinding | null {
  const chatUrl = env.UNBROWSE_LLM_CHAT_URL?.trim();
  if (!chatUrl) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Unbrowse-LLM-Policy": "server-owned-only",
  };
  const token = env.UNBROWSE_LLM_API_KEY?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return { chatUrl, headers };
}

/**
 * Three-tier model fallback chain for the /contract aiko LLM compiler.
 * Order matters: primary → secondary → tertiary. Each entry pairs the
 * tokenfactory base URL with the model id served there. The chain is
 * tried sequentially; the first non-5xx, non-network-error response with
 * parseable JSON content wins.
 *
 * Pinned by the user's /contract declaration (see contract ledger). Update
 * here when the upstream model lineup changes — do not parameterize via
 * env: "no caller-visible options".
 */
const CONTRACT_LLM_CHAIN: ReadonlyArray<{ url: string; model: string }> = [
  {
    url: "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions",
    model: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    url: "https://api.tokenfactory.nebius.com/v1/chat/completions",
    model: "nvidia/Nemotron-3-Nano-Omni",
  },
  {
    url: "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions",
    model: "Qwen/Qwen3.5-397B-A17B",
  },
];

const COMPILE_SYSTEM_PROMPT =
  "Compile one aiko prompt into a minimal non-contradicting recursive aiko contract tree. Return only JSON: {\"prompt\":string,\"posthook_pointer\":\"optional http(s) or contract: pointer\",\"wallet_identity\":\"optional wallet pointer\",\"replicated_from_contract_id\":\"optional out-of-lineage contract id requiring paid replication\",\"network_tunnel_contract_id\":\"optional tunnel adapter contract pointer\",\"network_tunnel_kind\":\"optional tunnel class\",\"evaluators\":[{\"prompt\":string,\"metric\":{\"source\":\"api|ledger|external\",\"pointer\":string,\"assertion\":string}}],\"children\":[same shape]}. Every node and evaluator is an aiko declaration prompt. A goal is true only when external/self-check metrics resolve true. Posthooks are typed pointers called after promotion with full context and parent wallet identity. Do not add verbs, local paths, PII, secrets, execution payloads, or prose outside JSON.";

export async function compileAikoPromptToTree(
  env: Env,
  prompt: string,
): Promise<AikoCompiledContract | null> {
  const token = env.UNBROWSE_LLM_API_KEY?.trim();
  if (!token) return null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "*/*",
    Authorization: `Bearer ${token}`,
    "X-Unbrowse-LLM-Policy": "server-owned-only",
  };

  const errors: string[] = [];

  for (const tier of CONTRACT_LLM_CHAIN) {
    try {
      const res = await fetch(tier.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: tier.model,
          messages: [
            { role: "system", content: COMPILE_SYSTEM_PROMPT },
            { role: "user", content: [{ type: "text", text: prompt }] },
          ],
        }),
      });
      if (!res.ok) {
        errors.push(`${tier.model}@${hostOf(tier.url)}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as OpenAiChatResponse;
      const content = extractContent(json);
      return normalizeAikoContractTree(parseJsonObject(content), prompt);
    } catch (e) {
      errors.push(`${tier.model}@${hostOf(tier.url)}: ${(e as Error).message}`);
      continue;
    }
  }

  throw new Error(`unbrowse llm compile failed across chain: ${errors.join("; ")}`);
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Wave-2b timeout wrapper. Races `compileAikoPromptToTree` against a
 * `budgetMs` clock; on timeout, throws `CompileTimeoutError` which the
 * route handler catches and turns into a "compile-deferred" path (parent
 * row admitted, children skipped, evidence surfaced honestly).
 *
 * Cloudflare Workers cap a single invocation at 30s wall-time; the
 * route handler reserves ~5s for downstream KV writes + response
 * marshalling, so the budget passed here is typically 20-25s.
 */
export class CompileTimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`unbrowse llm compile exceeded budget of ${budgetMs}ms`);
    this.name = "CompileTimeoutError";
  }
}

export async function compileAikoPromptToTreeWithTimeout(
  env: Env,
  prompt: string,
  budgetMs: number,
): Promise<AikoCompiledContract | null> {
  if (budgetMs <= 0) {
    throw new CompileTimeoutError(budgetMs);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CompileTimeoutError(budgetMs)), budgetMs);
  });
  try {
    return await Promise.race([compileAikoPromptToTree(env, prompt), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

function extractContent(json: OpenAiChatResponse): string {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" || typeof part.text === "string" ? part.text ?? "" : ""))
      .join("");
  }
  throw new Error("unbrowse llm compile response missing content");
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("unbrowse llm compile response was not JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function normalizeAikoContractTree(value: unknown, fallbackPrompt: string): AikoCompiledContract {
  if (!value || typeof value !== "object") {
    return { prompt: fallbackPrompt, evaluators: [], children: [] };
  }
  const record = value as {
    prompt?: unknown;
    plan?: unknown;
    posthook_pointer?: unknown;
    wallet_identity?: unknown;
    replicated_from_contract_id?: unknown;
    network_tunnel_contract_id?: unknown;
    network_tunnel_kind?: unknown;
    evaluators?: unknown;
    children?: unknown;
  };
  const prompt =
    typeof record.prompt === "string" && record.prompt.trim()
      ? record.prompt.trim()
      : typeof record.plan === "string" && record.plan.trim()
        ? record.plan.trim()
        : fallbackPrompt;
  const evaluators = Array.isArray(record.evaluators)
    ? record.evaluators.map(normalizeAikoEvaluator).filter((evalNode) => evalNode.prompt)
    : [];
  const children = Array.isArray(record.children)
    ? record.children.map((child) => normalizeAikoContractTree(child, "")).filter((child) => child.prompt)
    : [];
  const posthook_pointer = normalizePosthookPointer(record.posthook_pointer);
  return removeUndefined({
    prompt,
    posthook_pointer,
    wallet_identity: normalizePointerString(record.wallet_identity),
    replicated_from_contract_id: normalizePointerString(record.replicated_from_contract_id),
    network_tunnel_contract_id: normalizePointerString(record.network_tunnel_contract_id),
    network_tunnel_kind: normalizePointerString(record.network_tunnel_kind),
    evaluators,
    children,
  });
}

function normalizeAikoEvaluator(value: unknown): AikoCompiledEvaluator {
  if (!value || typeof value !== "object") {
    return { prompt: "", metric: { source: "external", pointer: "", assertion: "" } };
  }
  const record = value as { prompt?: unknown; plan?: unknown; metric?: unknown };
  const metricRecord =
    record.metric && typeof record.metric === "object"
      ? (record.metric as { source?: unknown; pointer?: unknown; assertion?: unknown })
      : {};
  const source =
    metricRecord.source === "api" || metricRecord.source === "ledger" || metricRecord.source === "external"
      ? metricRecord.source
      : "external";
  return {
    prompt:
      typeof record.prompt === "string" && record.prompt.trim()
        ? record.prompt.trim()
        : typeof record.plan === "string" && record.plan.trim()
          ? record.plan.trim()
          : "",
    metric: {
      source,
      pointer: typeof metricRecord.pointer === "string" ? metricRecord.pointer.trim() : "",
      assertion: typeof metricRecord.assertion === "string" ? metricRecord.assertion.trim() : "",
    },
  };
}

function normalizePosthookPointer(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const pointer = value.trim();
  if (
    pointer.startsWith("https://") ||
    pointer.startsWith("http://") ||
    pointer.startsWith("contract:")
  ) {
    return pointer;
  }
  return undefined;
}

function normalizePointerString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const pointer = value.trim();
  return pointer ? pointer : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}
