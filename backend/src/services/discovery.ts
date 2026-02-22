import type { Env } from "../types.js";

const DIMS = 1536;
const EMERGENTDB_BASE = "https://api.emergentdb.com";

function domainNamespace(domain: string): string {
  return `unbrowse--${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}
const GLOBAL_NS = "unbrowse-skill";

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
  // Try vector search first
  try {
    const vector = await embedIntent(env, intent, "query");
    const ns = domainNamespace(domain);
    const data = (await edbRequest(env, "POST", "/vectors/search", {
      vector, k, include_metadata: true, namespace: ns,
    })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
    if (data.results && data.results.length > 0) return data.results;
  } catch (e) {
    console.log(`[search] vector domain search failed: ${e}`);
  }

  // Fallback: keyword search over KV skills filtered by domain
  return kvFallbackSearch(env, intent, k, domain);
}

export async function searchIntent(
  env: Env,
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  // Try vector search first
  try {
    const vector = await embedIntent(env, intent, "query");
    const data = (await edbRequest(env, "POST", "/vectors/search", {
      vector, k, include_metadata: true, namespace: GLOBAL_NS,
    })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
    if (data.results && data.results.length > 0) return data.results;
  } catch (e) {
    console.log(`[search] vector search failed: ${e}`);
  }

  // Fallback: keyword search over KV skills
  return kvFallbackSearch(env, intent, k);
}

export async function removeSkillFromIndex(env: Env, skillId: string, domain: string): Promise<void> {
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(domain);
  await Promise.all([
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: ns }),
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: GLOBAL_NS }),
  ]);
}

async function kvFallbackSearch(
  env: Env,
  intent: string,
  k: number,
  domain?: string
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const keys = await env.SKILLS_KV.list({ prefix: "skill:", limit: 200 });
  const terms = intent.toLowerCase().split(/\s+/);
  const results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> = [];

  for (const key of keys.keys) {
    const raw = await env.SKILLS_KV.get(key.name);
    if (!raw) continue;
    const skill = JSON.parse(raw) as {
      skill_id: string; name: string; domain: string; description?: string;
      intent_signature: string; lifecycle?: string;
    };
    if (skill.lifecycle && skill.lifecycle !== "active") continue;
    if (domain && skill.domain !== domain) continue;

    const haystack = `${skill.name} ${skill.intent_signature} ${skill.description ?? ""} ${skill.domain}`.toLowerCase();
    const matched = terms.filter((t) => haystack.includes(t)).length;
    if (matched === 0) continue;

    const score = matched / terms.length;
    results.push({
      id: hashToInt(skill.skill_id),
      score,
      metadata: {
        title: skill.intent_signature,
        content: JSON.stringify({ skill_id: skill.skill_id, domain: skill.domain, name: skill.name }),
      },
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
