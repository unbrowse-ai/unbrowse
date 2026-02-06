/**
 * Test helpers — Utilities for loading HAR fixtures and building test data.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { HarEntry, ParsedRequest, ApiData, EndpointGroup } from "../types.js";

// ── Fixture loading ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");

/** Available fixture names (without .har.json extension). */
export type FixtureName = "todo-api" | "ecommerce-api" | "auth-api-key" | "mixed-traffic";

/**
 * Load a HAR fixture file by name.
 * Returns the parsed HAR object with `log.entries`.
 */
export function loadFixture(name: FixtureName): { log: { entries: HarEntry[] } } {
  const filePath = resolve(FIXTURES_DIR, `${name}.har.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as { log: { entries: HarEntry[] } };
}

/**
 * Load raw HAR entries from a fixture file.
 */
export function loadEntries(name: FixtureName): HarEntry[] {
  return loadFixture(name).log.entries;
}

// ── HarEntry builder ───────────────────────────────────────────────────────

interface HarEntryOptions {
  method?: string;
  url?: string;
  status?: number;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  queryString?: { name: string; value: string }[];
  cookies?: { name: string; value: string }[];
  postData?: { mimeType?: string; text?: string };
  responseBody?: unknown;
  responseMimeType?: string;
  time?: number;
}

/**
 * Build a minimal HarEntry for unit tests.
 * Defaults to a GET 200 JSON request with no body.
 */
export function makeHarEntry(opts: HarEntryOptions = {}): HarEntry {
  const {
    method = "GET",
    url = "https://api.example.com/test",
    status = 200,
    requestHeaders = [],
    responseHeaders = [],
    queryString = [],
    cookies,
    postData,
    responseBody,
    responseMimeType = "application/json",
    time = 100,
  } = opts;

  const responseContent: HarEntry["response"]["content"] = {
    mimeType: responseMimeType,
  };

  if (responseBody !== undefined) {
    const text = typeof responseBody === "string"
      ? responseBody
      : JSON.stringify(responseBody);
    responseContent.text = text;
    responseContent.size = text.length;
  }

  // Ensure response has Content-Type header if a body is present
  const finalResponseHeaders = [...responseHeaders];
  if (responseBody !== undefined && !finalResponseHeaders.some(h => h.name.toLowerCase() === "content-type")) {
    finalResponseHeaders.push({ name: "Content-Type", value: responseMimeType });
  }

  const entry: HarEntry = {
    request: {
      method,
      url,
      headers: requestHeaders,
      queryString,
      ...(cookies ? { cookies } : {}),
      ...(postData ? { postData } : {}),
    },
    response: {
      status,
      headers: finalResponseHeaders,
      content: responseContent,
    },
    time,
  };

  return entry;
}

// ── ParsedRequest builder ──────────────────────────────────────────────────

interface ParsedRequestOptions {
  method?: string;
  url?: string;
  path?: string;
  domain?: string;
  status?: number;
  normalizedPath?: string;
  responseBody?: unknown;
  responseSummary?: string;
  requestBody?: unknown;
  queryParams?: { name: string; value: string }[];
  pathParams?: ParsedRequest["pathParams"];
  verified?: boolean;
  fromSpec?: boolean;
  resourceType?: string;
  responseContentType?: string;
}

/**
 * Build a ParsedRequest for unit tests.
 * Automatically derives `path` and `domain` from `url` if not provided.
 */
export function makeParsedRequest(opts: ParsedRequestOptions = {}): ParsedRequest {
  const {
    method = "GET",
    url = "https://api.example.com/api/v1/items",
    status = 200,
    verified,
    fromSpec,
    resourceType,
    responseContentType = "application/json",
    normalizedPath,
    responseBody,
    responseSummary,
    requestBody,
    queryParams,
    pathParams,
  } = opts;

  let { path, domain } = opts;

  // Derive path and domain from URL if not explicitly provided
  if (!path || !domain) {
    try {
      const parsed = new URL(url);
      path = path || parsed.pathname;
      domain = domain || parsed.host;
    } catch {
      path = path || "/unknown";
      domain = domain || "unknown";
    }
  }

  return {
    method,
    url,
    path,
    domain,
    status,
    ...(verified !== undefined ? { verified } : {}),
    ...(fromSpec !== undefined ? { fromSpec } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(responseContentType ? { responseContentType } : {}),
    ...(normalizedPath ? { normalizedPath } : {}),
    ...(responseBody !== undefined ? { responseBody } : {}),
    ...(responseSummary ? { responseSummary } : {}),
    ...(requestBody !== undefined ? { requestBody } : {}),
    ...(queryParams ? { queryParams } : {}),
    ...(pathParams ? { pathParams } : {}),
  };
}

// ── ApiData builder ────────────────────────────────────────────────────────

interface ApiDataOptions {
  service?: string;
  baseUrl?: string;
  baseUrls?: string[];
  authHeaders?: Record<string, string>;
  authMethod?: string;
  cookies?: Record<string, string>;
  authInfo?: Record<string, string>;
  requests?: ParsedRequest[];
  endpoints?: Record<string, ParsedRequest[]>;
  endpointGroups?: EndpointGroup[];
}

/**
 * Build an ApiData object for unit tests.
 * Automatically builds `endpoints` from `requests` if not provided.
 */
export function makeApiData(opts: ApiDataOptions = {}): ApiData {
  const {
    service = "test-api",
    baseUrl = "https://api.example.com",
    baseUrls,
    authHeaders = {},
    authMethod = "Bearer Token",
    cookies = {},
    authInfo = {},
    requests = [],
    endpointGroups,
  } = opts;

  // Auto-generate endpoints map from requests if not provided
  const endpoints = opts.endpoints ?? groupRequestsByDomainPath(requests);

  return {
    service,
    baseUrls: baseUrls || [baseUrl],
    baseUrl,
    authHeaders,
    authMethod,
    cookies,
    authInfo,
    requests,
    endpoints,
    ...(endpointGroups ? { endpointGroups } : {}),
  };
}

/**
 * Group requests by `domain:path` key (mirrors har-parser groupByDomainAndPath).
 */
function groupRequestsByDomainPath(requests: ParsedRequest[]): Record<string, ParsedRequest[]> {
  const grouped: Record<string, ParsedRequest[]> = {};
  for (const req of requests) {
    const key = `${req.domain}:${req.path}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(req);
  }
  return grouped;
}

// ── Assertion helpers ──────────────────────────────────────────────────────

/**
 * Extract unique normalized paths from an array of endpoint groups.
 */
export function getGroupPaths(groups: EndpointGroup[]): string[] {
  return groups.map(g => `${g.method} ${g.normalizedPath}`);
}

/**
 * Find an endpoint group by method and normalized path (substring match).
 */
export function findGroup(
  groups: EndpointGroup[],
  method: string,
  pathSubstring: string,
): EndpointGroup | undefined {
  return groups.find(
    g => g.method === method && g.normalizedPath.includes(pathSubstring),
  );
}

/**
 * Count entries by domain in a HAR fixture.
 */
export function countEntriesByDomain(entries: HarEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    try {
      const domain = new URL(entry.request.url).host;
      counts[domain] = (counts[domain] || 0) + 1;
    } catch {
      // skip invalid URLs
    }
  }
  return counts;
}

/**
 * Extract all unique HTTP methods from HAR entries.
 */
export function getUniqueMethods(entries: HarEntry[]): string[] {
  return [...new Set(entries.map(e => e.request.method))].sort();
}

/**
 * Get all response status codes from HAR entries.
 */
export function getStatusCodes(entries: HarEntry[]): number[] {
  return entries.map(e => e.response.status);
}

/**
 * Parse the stringified JSON response body from a HAR entry.
 * Returns null if no response body or not parseable.
 */
export function parseResponseBody(entry: HarEntry): unknown | null {
  const text = entry.response?.content?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
