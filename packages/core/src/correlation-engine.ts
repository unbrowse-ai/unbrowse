import type { CapturedExchange } from "./types.js";
import { safeParseJson } from "./schema-inferrer.js";
import { createHash } from "node:crypto";

export type CorrelationLocation = "body" | "header" | "cookie" | "url" | "query";

export type CorrelationValueType =
  | "token"
  | "id"
  | "cursor"
  | "timestamp"
  | "hash"
  | "unknown";

export interface CorrelationLinkV1 {
  sourceRequestIndex: number;
  sourcePath: string;
  sourceLocation: CorrelationLocation;
  targetRequestIndex: number;
  targetPath: string;
  targetLocation: CorrelationLocation;
  valueHash?: string;
  valuePreview?: string;
  valueType: CorrelationValueType;
}

export interface CorrelationGraphV1 {
  version: 1;
  generatedAt: string;
  requests: Array<{
    index: number;
    method: string;
    url: string;
    status?: number;
  }>;
  links: CorrelationLinkV1[];
  entryPoints: number[];
  chains: number[][];
}

type ValueNode = {
  requestIndex: number;
  location: CorrelationLocation;
  path: string;
  value: string;
  valueHash?: string;
  valueType: CorrelationValueType;
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function classifyValueType(v: string): CorrelationValueType {
  const s = v.trim();
  if (!s) return "unknown";
  if (s.startsWith("eyJ") && s.split(".").length >= 3) return "token"; // JWT-ish
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "id";
  if (/^[0-9a-f]{32,128}$/i.test(s)) return "hash";
  if (/^\d{10,13}$/.test(s)) return "timestamp";
  if (/cursor|page|next|offset/i.test(s) && s.length >= 8) return "cursor";
  if (/token|csrf|xsrf|bearer/i.test(s) && s.length >= 8) return "token";
  return "unknown";
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function previewFor(value: string, valueType: CorrelationValueType): string {
  const s = value.trim();
  const len = s.length;
  // Never emit raw secrets into references; capture files stay local, but
  // correlations are publishable artifacts.
  if (valueType === "token" || valueType === "hash" || valueType === "id") return `len:${len}`;
  if (len <= 12) return `len:${len}`;
  return `${s.slice(0, 6)}…${s.slice(-4)} (len:${len})`;
}

function shouldConsiderValue(v: string): boolean {
  const s = v.trim();
  // Guardrails:
  // - Keep the general threshold high to reduce noisy links ("en", "1", etc.)
  // - But allow shorter numeric IDs (common in real APIs: 4-7 digits) or correlation will miss most flows.
  if (s.length < 8) {
    if (/^\d{4,}$/.test(s)) return true;
    return false;
  }
  if (s.length > 2048) return false; // likely blobs
  return true;
}

function collectFromJson(value: unknown, prefix: string, out: Array<{ path: string; value: string }>, depth = 0): void {
  if (depth > 5) return;
  if (value === undefined) return;

  if (value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push({ path: prefix || "value", value: String(value) });
    return;
  }

  if (Array.isArray(value)) {
    const sample = value.slice(0, 4);
    for (let i = 0; i < sample.length; i++) {
      // Use numeric indices so paths are extractable with simple dot-walkers.
      // Example: "body.0.id" instead of "body[].id".
      collectFromJson(sample[i], prefix ? `${prefix}.${i}` : String(i), out, depth + 1);
    }
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).slice(0, 80);
    for (const k of keys) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectFromJson(value[k], next, out, depth + 1);
    }
  }
}

function tryParseJsonString(s: string): unknown | null {
  const t = s.trim();
  if (!t) return null;
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  return safeParseJson(t);
}

function collectNodesForExchange(ex: CapturedExchange): { request: ValueNode[]; response: ValueNode[] } {
  const reqNodes: ValueNode[] = [];
  const respNodes: ValueNode[] = [];
  const idx = ex.index;

  // Request URL: query params (and embedded JSON blobs).
  try {
    const u = new URL(ex.request.url);

    // URL path segments (for correlation into REST-style endpoints).
    // Represent as url.path.<index> where index is 0-based among non-empty segments.
    const segs = u.pathname.split("/").filter(Boolean).slice(0, 20);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!shouldConsiderValue(seg)) continue;
      reqNodes.push({
        requestIndex: idx,
        location: "url",
        path: `url.path.${i}`,
        value: seg,
        valueType: classifyValueType(seg),
      });

      // Common pattern: REST path segments include a file extension (e.g. "<id>.json").
      // Also collect the bare value so exact-match correlation can still infer links.
      const m = seg.match(/^(.+)\.(json|xml|csv|txt|html)$/i);
      if (m) {
        const bare = m[1];
        if (shouldConsiderValue(bare)) {
          reqNodes.push({
            requestIndex: idx,
            location: "url",
            path: `url.path.${i}`,
            value: bare,
            valueType: classifyValueType(bare),
          });
        }
      }
    }

    for (const [k, v] of u.searchParams.entries()) {
      if (shouldConsiderValue(v)) {
        reqNodes.push({
          requestIndex: idx,
          location: "query",
          path: `query.${k}`,
          value: v,
          valueType: classifyValueType(v),
        });
      }
      const maybeJson = tryParseJsonString(v);
      if (maybeJson !== null) {
        const pairs: Array<{ path: string; value: string }> = [];
        collectFromJson(maybeJson, `query.${k}`, pairs);
        for (const p of pairs) {
          if (!shouldConsiderValue(p.value)) continue;
          reqNodes.push({
            requestIndex: idx,
            location: "query",
            path: p.path,
            value: p.value,
            valueType: classifyValueType(p.value),
          });
        }
      }
    }
  } catch {
    // ignore invalid URLs
  }

  // Request headers
  for (const [k, v] of Object.entries(ex.request.headers ?? {})) {
    if (!v) continue;
    const name = String(k);
    if (name.toLowerCase() === "cookie") continue;
    // Special-case: Authorization often uses "Bearer <token>" while the token appears raw elsewhere.
    // Collect a normalized token-only variant so correlation can still be inferred.
    const lowerName = name.toLowerCase();
    if (lowerName === "authorization") {
      const m = String(v).match(/^\s*bearer\s+(.+)\s*$/i);
      if (m && shouldConsiderValue(m[1])) {
        reqNodes.push({
          requestIndex: idx,
          location: "header",
          path: `header.${name}`,
          value: m[1],
          valueType: "token",
        });
      }
    }

    if (!shouldConsiderValue(v)) continue;
    reqNodes.push({
      requestIndex: idx,
      location: "header",
      path: `header.${name}`,
      value: v,
      valueType: classifyValueType(v),
    });
  }

  // Request cookies
  for (const [k, v] of Object.entries(ex.request.cookies ?? {})) {
    if (!v) continue;
    if (!shouldConsiderValue(v)) continue;
    reqNodes.push({
      requestIndex: idx,
      location: "cookie",
      path: `cookie.${k}`,
      value: v,
      valueType: classifyValueType(v),
    });
  }

  // Request body (and embedded JSON strings)
  if (ex.request.body !== undefined) {
    const pairs: Array<{ path: string; value: string }> = [];
    collectFromJson(ex.request.body, "body", pairs);
    for (const p of pairs) {
      if (!shouldConsiderValue(p.value)) continue;
      reqNodes.push({
        requestIndex: idx,
        location: "body",
        path: p.path,
        value: p.value,
        valueType: classifyValueType(p.value),
      });
    }
  } else if (typeof ex.request.bodyRaw === "string") {
    const maybeJson = tryParseJsonString(ex.request.bodyRaw);
    if (maybeJson !== null) {
      const pairs: Array<{ path: string; value: string }> = [];
      collectFromJson(maybeJson, "body", pairs);
      for (const p of pairs) {
        if (!shouldConsiderValue(p.value)) continue;
        reqNodes.push({
          requestIndex: idx,
          location: "body",
          path: p.path,
          value: p.value,
          valueType: classifyValueType(p.value),
        });
      }
    }
  }

  // Response headers (including Set-Cookie)
  for (const [k, v] of Object.entries(ex.response.headers ?? {})) {
    if (!v) continue;
    const name = String(k);
    if (!shouldConsiderValue(v)) continue;
    respNodes.push({
      requestIndex: idx,
      location: "header",
      path: `header.${name}`,
      value: v,
      valueType: classifyValueType(v),
    });
  }

  // Response body
  if (ex.response.body !== undefined) {
    const pairs: Array<{ path: string; value: string }> = [];
    collectFromJson(ex.response.body, "body", pairs);
    for (const p of pairs) {
      if (!shouldConsiderValue(p.value)) continue;
      respNodes.push({
        requestIndex: idx,
        location: "body",
        path: p.path,
        value: p.value,
        valueType: classifyValueType(p.value),
      });
    }
  } else if (typeof ex.response.bodyRaw === "string") {
    const maybeJson = tryParseJsonString(ex.response.bodyRaw);
    if (maybeJson !== null) {
      const pairs: Array<{ path: string; value: string }> = [];
      collectFromJson(maybeJson, "body", pairs);
      for (const p of pairs) {
        if (!shouldConsiderValue(p.value)) continue;
        respNodes.push({
          requestIndex: idx,
          location: "body",
          path: p.path,
          value: p.value,
          valueType: classifyValueType(p.value),
        });
      }
    }
  }

  return { request: reqNodes, response: respNodes };
}

export function inferCorrelationGraphV1(exchanges: CapturedExchange[]): CorrelationGraphV1 {
  const nodesByRequestIdx = new Map<number, { req: ValueNode[]; resp: ValueNode[] }>();
  for (const ex of exchanges) {
    const nodes = collectNodesForExchange(ex);
    nodesByRequestIdx.set(ex.index, { req: nodes.request, resp: nodes.response });
  }

  // Index all response nodes by raw value for exact matching.
  const sourcesByValue = new Map<string, ValueNode[]>();
  for (const [, nodes] of nodesByRequestIdx) {
    for (const n of nodes.resp) {
      if (!shouldConsiderValue(n.value)) continue;
      const key = n.value.trim();
      const arr = sourcesByValue.get(key) ?? [];
      arr.push(n);
      sourcesByValue.set(key, arr);
    }
  }

  const links: CorrelationLinkV1[] = [];
  const seen = new Set<string>();

  for (const ex of exchanges) {
    const idx = ex.index;
    const nodes = nodesByRequestIdx.get(idx);
    if (!nodes) continue;

    for (const target of nodes.req) {
      const key = target.value.trim();
      const sources = sourcesByValue.get(key);
      if (!sources || sources.length === 0) continue;

      // Only allow sources from *earlier* responses; prefer the most recent.
      const viable = sources
        .filter((s) => s.requestIndex < idx)
        .sort((a, b) => b.requestIndex - a.requestIndex);
      if (viable.length === 0) continue;
      const best = viable[0];

      const dedupeKey = `${best.requestIndex}:${best.location}:${best.path}=>${idx}:${target.location}:${target.path}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const valueType = best.valueType !== "unknown" ? best.valueType : target.valueType;
      links.push({
        sourceRequestIndex: best.requestIndex,
        sourcePath: best.path.replace(/^body\./, ""), // match spec style: "data.foo"
        sourceLocation: best.location,
        targetRequestIndex: idx,
        targetPath: target.path,
        targetLocation: target.location,
        valueHash: sha256Hex(key),
        valuePreview: previewFor(key, valueType),
        valueType,
      });
    }
  }

  // Entry points: requests with no inbound links.
  const inbound = new Map<number, number>();
  for (const l of links) {
    inbound.set(l.targetRequestIndex, (inbound.get(l.targetRequestIndex) ?? 0) + 1);
  }
  const entryPoints = exchanges
    .map((e) => e.index)
    .filter((i) => (inbound.get(i) ?? 0) === 0);

  // Simple chain derivation: follow time-order edges from each entry point.
  const byFrom = new Map<number, number[]>();
  for (const l of links) {
    const arr = byFrom.get(l.sourceRequestIndex) ?? [];
    if (!arr.includes(l.targetRequestIndex)) arr.push(l.targetRequestIndex);
    byFrom.set(l.sourceRequestIndex, arr);
  }
  for (const [, arr] of byFrom) arr.sort((a, b) => a - b);

  const chains: number[][] = [];
  for (const start of entryPoints) {
    const chain: number[] = [];
    const seenIdx = new Set<number>();
    const stack: number[] = [start];
    while (stack.length > 0) {
      const cur = stack.shift()!;
      if (seenIdx.has(cur)) continue;
      seenIdx.add(cur);
      chain.push(cur);
      const next = byFrom.get(cur) ?? [];
      for (const n of next) {
        if (n > cur) stack.push(n);
      }
    }
    chains.push(chain);
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    requests: exchanges.map((e) => ({
      index: e.index,
      method: e.request.method,
      url: e.request.url,
      status: e.response.status,
    })),
    links,
    entryPoints,
    chains,
  };
}

export function planChainForTarget(graph: CorrelationGraphV1, targetIndex: number): number[] {
  // Backward reachability via links, then execute in ascending index order.
  const deps = new Set<number>([targetIndex]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of graph.links) {
      if (deps.has(l.targetRequestIndex) && !deps.has(l.sourceRequestIndex)) {
        deps.add(l.sourceRequestIndex);
        changed = true;
      }
    }
  }
  return [...deps].sort((a, b) => a - b);
}
