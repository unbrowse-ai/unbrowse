/**
 * Dependency DAG inference from captured request/response traffic.
 *
 * Goal: infer dataflow dependencies between endpoints by matching values produced
 * in earlier responses with values consumed in later requests.
 *
 * Notes:
 * - Values are never emitted directly; we only emit SHA-256 hashes of primitive
 *   values for within-trace matching.
 * - Also emits weak (name-only) links when keys overlap but values are missing.
 */

import { createHash } from "node:crypto";
import type { HarEntry } from "./types.js";
import { EndpointFingerprinter, RouteNormalizer } from "./har-parser.js";
import { safeParseJson } from "./schema-inferrer.js";

export type DependencyDagVersion = 2;

export interface DependencyDagNode {
  /** Stable node key: "METHOD /normalized/path" */
  key: string;
  method: string;
  normalizedPath: string;
  domain: string;
  /**
   * Basic endpoint fingerprint: sha256(METHOD|normalizedPath|||)[:16]
   * Matches server fallback when query/body are unknown.
   */
  fingerprint: string;
  /**
   * Observed variants (query/body shapes). Useful for better matching over time
   * without fragmenting the generalized node key.
   */
  variants: Array<{
    fingerprint: string;
    queryKeys: string[];
    bodySchema: string;
  }>;
}

export interface DependencyDagEdge {
  from: string; // node.key
  to: string;   // node.key
  /** Artifact "names" that connected the nodes (best-effort, privacy-safe). */
  artifacts: string[];
  /** 0-1 confidence score (heuristic). */
  confidence: number;
  /** Evidence count across the trace (matches aggregated). */
  evidenceCount: number;
  /** Whether at least one value-hash match was observed. */
  hasValueMatch: boolean;
}

export interface DependencyDagV2 {
  version: DependencyDagVersion;
  generatedAt: string;
  skillName?: string;
  nodes: DependencyDagNode[];
  edges: DependencyDagEdge[];
  meta: {
    calls: number;
    edges: number;
    inferredBy: "heuristic-v2";
  };
}

type Primitive = string | number | boolean | null;

type Artifact = {
  name: string; // e.g. "body.user.id" or "query.projectId"
  valueHash?: string; // sha256 of primitive stringified
};

type CallSummary = {
  idx: number;
  nodeKey: string;
  method: string;
  normalizedPath: string;
  domain: string;
  nodeFingerprintBasic: string;
  nodeFingerprintFull: string;
  queryKeys: string[];
  bodySchema: string;
  produces: Artifact[];
  consumes: Artifact[];
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function endpointFingerprint(method: string, normalizedPath: string, queryKeys?: string[], bodySchema?: string): string {
  const parts = [
    method.toUpperCase(),
    normalizedPath,
    (queryKeys ?? []).slice().sort().join(","),
    bodySchema ?? "",
  ];
  return sha256Hex(parts.join("|")).slice(0, 16);
}

function hashPrimitive(v: Primitive): string | undefined {
  if (v === null) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    if (s.length <= 1) return undefined; // too common/noisy
    // Skip very long strings (likely blobs/tokens); still allow within-trace matching via prefix+len.
    if (s.length > 512) return sha256Hex(`len:${s.length}:${s.slice(0, 64)}`);
    return sha256Hex(s);
  }
  if (typeof v === "boolean") return undefined; // extremely noisy
  if (typeof v === "number") {
    // Small integers are too common; skip to reduce spurious edges.
    if (Number.isInteger(v) && Math.abs(v) <= 3) return undefined;
    return sha256Hex(String(v));
  }
  return undefined;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function collectArtifactsFromJson(
  value: unknown,
  prefix: string,
  out: Artifact[],
  depth = 0,
): void {
  if (depth > 4) return;
  if (value === undefined) return;

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const h = hashPrimitive(value as Primitive);
    out.push({ name: prefix || "value", valueHash: h });
    return;
  }

  if (Array.isArray(value)) {
    // Sample up to first 3 elements to avoid huge payloads.
    const sample = value.slice(0, 3);
    for (let i = 0; i < sample.length; i++) {
      collectArtifactsFromJson(sample[i], `${prefix}[]`, out, depth + 1);
    }
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).slice(0, 60); // bound
    for (const k of keys) {
      const nextPrefix = prefix ? `${prefix}.${k}` : k;
      collectArtifactsFromJson(value[k], nextPrefix, out, depth + 1);
    }
  }
}

function collectArtifactsFromQuery(url: string): Artifact[] {
  const out: Artifact[] = [];
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      out.push({ name: `query.${k}`, valueHash: hashPrimitive(v) });
    }
  } catch {
    // ignore
  }
  return out;
}

function extractQueryKeys(url: string): string[] {
  try {
    const u = new URL(url);
    return Array.from(new Set(Array.from(u.searchParams.keys()))).sort();
  } catch {
    return [];
  }
}

function collectArtifactsFromPathParams(url: string, normalizedPath: string): Artifact[] {
  const out: Artifact[] = [];
  try {
    const u = new URL(url);
    const rawSegs = u.pathname.split("/").filter(Boolean);
    const normSegs = normalizedPath.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(rawSegs.length, normSegs.length); i++) {
      const seg = normSegs[i];
      const raw = rawSegs[i];
      const m = seg.match(/^\{([^}]+)\}$/);
      if (!m) continue;
      const name = m[1];
      out.push({ name: `path.${name}`, valueHash: hashPrimitive(raw) });
      out.push({ name, valueHash: hashPrimitive(raw) }); // also allow direct-name match
    }
  } catch {
    // ignore
  }
  return out;
}

function canonicalNodeKey(method: string, normalizedPath: string): string {
  return `${method.toUpperCase()} ${normalizedPath}`;
}

function uniqArtifacts(arts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of arts) {
    const key = `${a.name}::${a.valueHash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function extractArtifactsFromHarEntry(entry: HarEntry, normalizer: RouteNormalizer): CallSummary | null {
  const fingerprinter = new EndpointFingerprinter(normalizer);
  const method = String(entry.request?.method || "GET").toUpperCase();
  const url = String(entry.request?.url || "");
  if (!url) return null;

  let domain = "";
  let normalizedPath = "/";
  try {
    const u = new URL(url);
    domain = u.hostname;
    normalizedPath = normalizer.normalizePath(u.pathname).normalizedPath;
  } catch {
    // ignore
  }

  const nodeKey = canonicalNodeKey(method, normalizedPath);

  const reqJson = safeParseJson(entry.request?.postData?.text ?? undefined);
  const respJson = safeParseJson(entry.response?.content?.text ?? undefined);

  const queryKeys = extractQueryKeys(url);
  const bodySchema = fingerprinter.normalizeBodyStructure(entry.request?.postData?.text ?? undefined);
  const nodeFingerprintBasic = endpointFingerprint(method, normalizedPath, [], "");
  const nodeFingerprintFull = endpointFingerprint(method, normalizedPath, queryKeys, bodySchema);

  const consumes: Artifact[] = [];
  const produces: Artifact[] = [];

  // Inputs: query + path params + request body JSON primitives.
  consumes.push(...collectArtifactsFromQuery(url));
  consumes.push(...collectArtifactsFromPathParams(url, normalizedPath));
  if (reqJson !== null) collectArtifactsFromJson(reqJson, "body", consumes);

  // Outputs: response body JSON primitives.
  if (respJson !== null) collectArtifactsFromJson(respJson, "out", produces);

  return {
    idx: 0,
    nodeKey,
    method,
    normalizedPath,
    domain,
    nodeFingerprintBasic,
    nodeFingerprintFull,
    queryKeys,
    bodySchema,
    produces: uniqArtifacts(produces),
    consumes: uniqArtifacts(consumes),
  };
}

function edgeConfidence(strongMatches: number, weakMatches: number): number {
  if (strongMatches > 0) {
    // Start at 0.65 and ramp; cap at 0.95.
    return Math.min(0.95, 0.65 + 0.08 * Math.min(strongMatches, 4));
  }
  if (weakMatches >= 2) return 0.25;
  if (weakMatches >= 1) return 0.18;
  return 0;
}

/**
 * Infer a dependency DAG from HAR entries.
 *
 * This is "within-trace" inference: it is most reliable when the capture
 * includes request bodies and response bodies (Playwright HAR or unbrowse_browse capture).
 */
export function inferDependencyDagFromHarEntries(
  entries: HarEntry[],
  opts?: { skillName?: string },
): DependencyDagV2 {
  const normalizer = new RouteNormalizer();

  const sorted = [...(entries ?? [])].sort((a, b) => {
    const ta = typeof a.time === "number" ? a.time : 0;
    const tb = typeof b.time === "number" ? b.time : 0;
    return ta - tb;
  });

  const calls: CallSummary[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = extractArtifactsFromHarEntry(sorted[i], normalizer);
    if (!s) continue;
    s.idx = calls.length;
    calls.push(s);
  }

  // Node set.
  const nodeMap = new Map<string, DependencyDagNode>();
  for (const c of calls) {
    if (!nodeMap.has(c.nodeKey)) {
      nodeMap.set(c.nodeKey, {
        key: c.nodeKey,
        method: c.method,
        normalizedPath: c.normalizedPath,
        domain: c.domain,
        fingerprint: c.nodeFingerprintBasic,
        variants: [],
      });
    }

    // Add/merge an observed variant (query/body shape) for this generalized node.
    const node = nodeMap.get(c.nodeKey)!;
    const existing = node.variants.find((v) => v.fingerprint === c.nodeFingerprintFull);
    if (!existing) {
      node.variants.push({
        fingerprint: c.nodeFingerprintFull,
        queryKeys: c.queryKeys,
        bodySchema: c.bodySchema,
      });
    } else {
      // Merge query keys conservatively (union), keep bodySchema as-is.
      const mergedQ = new Set([...(existing.queryKeys ?? []), ...(c.queryKeys ?? [])]);
      existing.queryKeys = [...mergedQ].sort();
      if (!existing.bodySchema && c.bodySchema) existing.bodySchema = c.bodySchema;
    }
  }

  // Edge inference: A -> B if A produces values consumed by B.
  type EdgeAgg = {
    from: string;
    to: string;
    artifacts: Set<string>;
    strong: number;
    weak: number;
    evidenceCount: number;
  };
  const edges = new Map<string, EdgeAgg>();

  const producedByCall = calls.map((c) => {
    const byHash = new Map<string, Set<string>>(); // valueHash -> artifact names
    const byName = new Set<string>(); // artifact names (no value)
    for (const a of c.produces) {
      if (a.valueHash) {
        const s = byHash.get(a.valueHash) ?? new Set<string>();
        s.add(a.name);
        byHash.set(a.valueHash, s);
      }
      byName.add(a.name);
    }
    return { byHash, byName };
  });

  const consumedByCall = calls.map((c) => {
    const byHash = new Map<string, Set<string>>();
    const byName = new Set<string>();
    for (const a of c.consumes) {
      if (a.valueHash) {
        const s = byHash.get(a.valueHash) ?? new Set<string>();
        s.add(a.name);
        byHash.set(a.valueHash, s);
      }
      byName.add(a.name);
    }
    return { byHash, byName };
  });

  for (let i = 0; i < calls.length; i++) {
    for (let j = i + 1; j < calls.length; j++) {
      const from = calls[i].nodeKey;
      const to = calls[j].nodeKey;
      if (from === to) continue;

      let strong = 0;
      let weak = 0;
      const arts = new Set<string>();

      // Strong: intersect value hashes.
      for (const [h, producedNames] of producedByCall[i].byHash.entries()) {
        const consumedNames = consumedByCall[j].byHash.get(h);
        if (!consumedNames) continue;
        strong++;
        // Best-effort artifact labels (avoid values).
        const p = [...producedNames][0] ?? "out";
        const c = [...consumedNames][0] ?? "in";
        arts.add(`${p} -> ${c}`);
      }

      // Weak: intersect key names only, when value match absent.
      if (strong === 0) {
        for (const name of producedByCall[i].byName) {
          if (consumedByCall[j].byName.has(name)) {
            weak++;
            arts.add(name);
            if (weak >= 3) break; // cap noise
          }
        }
      }

      const confidence = edgeConfidence(strong, weak);
      if (confidence <= 0) continue;

      const edgeKey = `${from} -> ${to}`;
      const prev = edges.get(edgeKey);
      if (!prev) {
        edges.set(edgeKey, {
          from,
          to,
          artifacts: arts,
          strong,
          weak,
          evidenceCount: strong > 0 ? strong : weak,
        });
      } else {
        for (const a of arts) prev.artifacts.add(a);
        prev.strong += strong;
        prev.weak += weak;
        prev.evidenceCount += (strong > 0 ? strong : weak);
      }
    }
  }

  const edgeList: DependencyDagEdge[] = [];
  for (const e of edges.values()) {
    edgeList.push({
      from: e.from,
      to: e.to,
      artifacts: [...e.artifacts].slice(0, 12),
      confidence: edgeConfidence(e.strong, e.weak),
      evidenceCount: e.evidenceCount,
      hasValueMatch: e.strong > 0,
    });
  }

  // Deterministic ordering.
  edgeList.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    return b.confidence - a.confidence;
  });

  const nodeList = [...nodeMap.values()]
    .map((n) => ({
      ...n,
      variants: (n.variants ?? []).slice().sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    skillName: opts?.skillName,
    nodes: nodeList,
    edges: edgeList,
    meta: {
      calls: calls.length,
      edges: edgeList.length,
      inferredBy: "heuristic-v2",
    },
  };
}
