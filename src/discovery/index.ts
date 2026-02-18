import { GoogleGenAI } from "@google/genai";
import { EmergentDB } from "emergentdb";

const NAMESPACE = process.env.EMERGENTDB_NAMESPACE ?? "unbrowse-skills";
const DIMS = 1536;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new EmergentDB(process.env.EMERGENTDB_API_KEY ?? "");

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
  // Normalize for inner product = cosine similarity (required for 1536-dim Gemini embeddings)
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
  await db.insert(
    numericId,
    vector,
    {
      title: intentSignature,
      content: JSON.stringify({ ...meta, skill_id: skillId }),
      tags: [meta.domain, meta.subdomain].filter(Boolean) as string[],
      source_url: String(meta.domain ?? ""),
    },
    NAMESPACE
  );
}

export async function searchIntent(
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const vector = await embedIntent(intent, "query");
  const res = await db.search(vector, { k, includeMetadata: true, namespace: NAMESPACE });
  return (res.results ?? []) as Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
}

export async function removeSkillFromIndex(skillId: string): Promise<void> {
  const numericId = hashToInt(skillId);
  await db.delete(numericId, NAMESPACE);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
