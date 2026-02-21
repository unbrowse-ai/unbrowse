import type { Env } from "../types.js";

const DIMS = 1536;
const EMERGENTDB_BASE = "https://api.emergentdb.com";

function domainNamespace(domain: string): string {
  return `unbrowse--${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}
const GLOBAL_NS = "unbrowse--global";

async function edbRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${EMERGENTDB_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "unbrowse/0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `EmergentDB HTTP ${res.status}`);
  return data;
}

async function embedIntent(
  env: Env,
  text: string,
  task: "query" | "document" = "query"
): Promise<number[]> {
  const taskType = task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: DIMS,
      }),
    }
  );
  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };
  const raw = data.embedding?.values ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

export async function indexSkill(
  env: Env,
  skillId: string,
  intentSignature: string,
  meta: Record<string, unknown>
): Promise<void> {
  const vector = await embedIntent(env, intentSignature, "document");
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(String(meta.domain ?? "global"));
  const payload = {
    id: numericId,
    vector,
    metadata: {
      title: intentSignature,
      content: JSON.stringify({ ...meta, skill_id: skillId }),
      tags: [meta.domain, meta.subdomain].filter(Boolean),
      source_url: String(meta.domain ?? ""),
    },
  };
  await Promise.all([
    edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: ns }),
    edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: GLOBAL_NS }),
  ]);
}

export async function searchIntentInDomain(
  env: Env,
  intent: string,
  domain: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const vector = await embedIntent(env, intent, "query");
  const ns = domainNamespace(domain);
  const data = (await edbRequest(env, "POST", "/vectors/search", {
    vector, k, include_metadata: true, namespace: ns,
  })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
  return data.results ?? [];
}

export async function searchIntent(
  env: Env,
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const vector = await embedIntent(env, intent, "query");
  const data = (await edbRequest(env, "POST", "/vectors/search", {
    vector, k, include_metadata: true, namespace: GLOBAL_NS,
  })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
  return data.results ?? [];
}

export async function removeSkillFromIndex(env: Env, skillId: string, domain: string): Promise<void> {
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(domain);
  await Promise.all([
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: ns }),
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: GLOBAL_NS }),
  ]);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
