/**
 * Skill Validator — Client-side endpoint validation before publish.
 *
 * Selects a diverse subset of GET endpoints, fires real requests with
 * captured auth, and produces ValidationEvidence that is attached to the
 * publish payload so the marketplace can verify skill quality.
 */

import { createHash } from "node:crypto";
import { platform } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EndpointGroup, ValidationEvidence, ValidationResult } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────

const PER_ENDPOINT_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 60_000;
const CONCURRENCY = 2;

/** Read plugin version from package.json (best-effort). */
function getPluginVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname ?? ".", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Endpoint selection ───────────────────────────────────────────────────

/**
 * Select a diverse subset of endpoints suitable for validation.
 *
 * - GET only (safe, idempotent)
 * - Skip auth endpoints
 * - Skip endpoints with unresolvable template params
 * - Prefer diversity by grouping on first 2 path segments
 */
export function selectValidationEndpoints(
  endpointGroups: EndpointGroup[],
  maxEndpoints = 5,
): EndpointGroup[] {
  const candidates = endpointGroups.filter((ep) => {
    // GET only
    if (ep.method.toUpperCase() !== "GET") return false;

    // Skip auth category
    if (ep.category === "auth") return false;

    // Skip endpoints with template params that have no example value
    const templateParams = ep.normalizedPath.match(/\{([^}]+)\}/g) || [];
    for (const tpl of templateParams) {
      const paramName = tpl.slice(1, -1);
      const hasExample = ep.pathParams.some(
        (p) => p.name === paramName && p.example,
      );
      if (!hasExample) return false;
    }

    return true;
  });

  if (candidates.length === 0) return [];

  // Group by first 2 path segments for diversity
  const groups = new Map<string, EndpointGroup[]>();
  for (const ep of candidates) {
    const segments = ep.normalizedPath.split("/").filter(Boolean);
    const key = segments.slice(0, 2).join("/") || ep.normalizedPath;
    const bucket = groups.get(key) || [];
    bucket.push(ep);
    groups.set(key, bucket);
  }

  // Pick 1 from each group (round-robin) until we reach maxEndpoints
  const selected: EndpointGroup[] = [];
  const iterators = [...groups.values()].map((bucket) => ({
    bucket,
    idx: 0,
  }));

  let round = 0;
  while (selected.length < maxEndpoints) {
    let added = false;
    for (const it of iterators) {
      if (selected.length >= maxEndpoints) break;
      if (it.idx < it.bucket.length) {
        selected.push(it.bucket[it.idx]);
        it.idx++;
        added = true;
      }
    }
    round++;
    if (!added) break; // All buckets exhausted
  }

  return selected;
}

// ── Response shape analysis ──────────────────────────────────────────────

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";

  if (Array.isArray(value)) {
    return `array[${value.length}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    const display = keys.slice(0, 5).join(",");
    return `object{${display}}`;
  }

  return typeof value; // "string", "number", "boolean"
}

// ── Validation execution ─────────────────────────────────────────────────

/**
 * Validate skill endpoints by executing real HTTP requests.
 *
 * Returns evidence of which endpoints respond correctly, including
 * response shapes and latencies.
 */
export async function validateSkillEndpoints(
  baseUrl: string,
  endpointGroups: EndpointGroup[],
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  opts?: { maxEndpoints?: number },
): Promise<ValidationEvidence> {
  const totalEndpoints = endpointGroups.length;
  const selected = selectValidationEndpoints(
    endpointGroups,
    opts?.maxEndpoints ?? 5,
  );
  const endpointsSkipped = totalEndpoints - selected.length;

  // Build cookie header
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const cleanBase = baseUrl.replace(/\/$/, "");
  const results: ValidationResult[] = [];
  const totalStart = Date.now();

  // Process with concurrency limit (sequential pairs)
  let idx = 0;
  while (idx < selected.length) {
    // Bail if total timeout exceeded
    if (Date.now() - totalStart > TOTAL_TIMEOUT_MS) break;

    const batch = selected.slice(idx, idx + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((ep) =>
        validateSingleEndpoint(ep, cleanBase, authHeaders, cookieHeader),
      ),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }

    idx += CONCURRENCY;
  }

  const endpointsTested = results.length;
  const endpointsVerified = results.filter((r) => r.ok && r.hasData).length;
  const endpointsFailed = endpointsTested - endpointsVerified;
  const passed =
    endpointsVerified >= 1 &&
    endpointsTested > 0 &&
    endpointsVerified / endpointsTested >= 0.5;

  return {
    validatedAt: new Date().toISOString(),
    totalEndpoints,
    endpointsTested,
    endpointsVerified,
    endpointsFailed,
    endpointsSkipped,
    results,
    passed,
    platform: platform(),
    pluginVersion: getPluginVersion(),
  };
}

/** Validate a single endpoint — build URL, execute fetch, collect evidence. */
async function validateSingleEndpoint(
  ep: EndpointGroup,
  baseUrl: string,
  authHeaders: Record<string, string>,
  cookieHeader: string,
): Promise<ValidationResult> {
  // Substitute template params with example values
  let urlPath = ep.normalizedPath;
  for (const pp of ep.pathParams) {
    urlPath = urlPath.replace(`{${pp.name}}`, encodeURIComponent(pp.example));
  }

  const fullUrl = baseUrl + urlPath;
  const start = Date.now();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders,
  };
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  let status = 0;
  let responseText = "";

  try {
    const resp = await fetch(fullUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(PER_ENDPOINT_TIMEOUT_MS),
    });
    status = resp.status;
    responseText = await resp.text();
  } catch {
    const latencyMs = Date.now() - start;
    return {
      method: ep.method,
      path: ep.normalizedPath,
      status: 0,
      ok: false,
      hasData: false,
      responseShape: "error",
      responseSize: 0,
      latencyMs,
      responseHash: "",
    };
  }

  const latencyMs = Date.now() - start;
  const ok = status >= 200 && status < 300;

  // Compute SHA-256 of first 1KB
  const hashInput = responseText.slice(0, 1024);
  const responseHash = createHash("sha256").update(hashInput).digest("hex");

  // Analyze response shape
  let responseShape = "unparseable";
  let hasData = false;

  try {
    const parsed = JSON.parse(responseText);
    responseShape = describeShape(parsed);

    if (Array.isArray(parsed)) {
      hasData = parsed.length > 0;
    } else if (typeof parsed === "object" && parsed !== null) {
      hasData = Object.keys(parsed).length > 0;
    } else if (typeof parsed === "string") {
      hasData = parsed.length > 0;
    } else if (typeof parsed === "number") {
      hasData = true;
    }
  } catch {
    // Not JSON — check if there's substantial text
    hasData = responseText.trim().length > 0;
    responseShape = "unparseable";
  }

  return {
    method: ep.method,
    path: ep.normalizedPath,
    status,
    ok,
    hasData,
    responseShape,
    responseSize: responseText.length,
    latencyMs,
    responseHash,
  };
}
