import { GoogleGenAI } from "@google/genai";

const DIMS = 1536;
const EMERGENTDB_BASE = "https://api.emergentdb.com";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Namespace scheme: unbrowse--{domain} for domain-scoped search,
// unbrowse--global for cross-domain search.
export function domainNamespace(domain: string): string {
  return `unbrowse--${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}
const GLOBAL_NS = "unbrowse--global";


// Raw fetch — bypasses EmergentDB SDK to avoid bun v1.x zstd decompression bug.
async function edbRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${EMERGENTDB_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.EMERGENTDB_API_KEY ?? ""}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "unbrowse/0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `EmergentDB HTTP ${res.status}`);
  return data;
}

export async function embedIntent(
  text: string,
  task: "query" | "document" = "query"
): Promise<number[]> {
  const taskType = task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const res = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: { taskType, outputDimensionality: DIMS },
  });
  const raw = res.embeddings?.[0]?.values ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

export async function indexSkill(
  skillId: string,
  intentSignature: string,
  meta: Record<string, unknown>
): Promise<void> {
  const vector = await embedIntent(intentSignature, "document");
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
  // Insert into domain namespace AND global namespace for cross-domain search
  await Promise.all([
    edbRequest("POST", "/vectors/insert", { ...payload, namespace: ns }),
    edbRequest("POST", "/vectors/insert", { ...payload, namespace: GLOBAL_NS }),
  ]);
}

// Search within a specific domain namespace (precise)
export async function searchIntentInDomain(
  intent: string,
  domain: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const vector = await embedIntent(intent, "query");
  const ns = domainNamespace(domain);
  const data = (await edbRequest("POST", "/vectors/search", {
    vector, k, include_metadata: true, namespace: ns,
  })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
  return data.results ?? [];
}

// Search across all skills globally (broad)
export async function searchIntent(
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const vector = await embedIntent(intent, "query");
  const data = (await edbRequest("POST", "/vectors/search", {
    vector, k, include_metadata: true, namespace: GLOBAL_NS,
  })) as { results?: Array<{ id: number; score: number; metadata: Record<string, unknown> }> };
  return data.results ?? [];
}

export async function removeSkillFromIndex(skillId: string, domain: string): Promise<void> {
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(domain);
  await Promise.all([
    edbRequest("POST", "/vectors/delete", { id: numericId, namespace: ns }),
    edbRequest("POST", "/vectors/delete", { id: numericId, namespace: GLOBAL_NS }),
  ]);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
