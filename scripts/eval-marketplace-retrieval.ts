#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getRegistrableDomain } from "../src/domain.ts";

type SearchResult = {
  id: number;
  score: number;
  metadata?: Record<string, unknown>;
};

type FixtureEndpoint = {
  endpoint_id: string;
  description: string;
  method: string;
  url_template: string;
  reliability_score: number;
  verification_status: string;
  idempotency: string;
};

type FixtureSkill = {
  id: string;
  skill_id: string;
  version: string;
  schema_version: string;
  name: string;
  intent_signature: string;
  domain: string;
  description: string;
  owner_type: string;
  lifecycle: string;
  execution_type: string;
  created_at: string;
  updated_at: string;
  endpoints: FixtureEndpoint[];
};

type DomainMatchMode = "exact" | "registrable";

type RetrievalExpectation = {
  fixture: string;
  endpoint_id: string;
  max_rank?: number;
  domain_match?: DomainMatchMode;
  max_offdomain_results?: number;
  skipped_global?: boolean;
};

type RetrievalCase = {
  id: string;
  route: "search" | "domain" | "resolve";
  lane?: "results" | "domain_results" | "global_results";
  intent: string;
  domain?: string;
  k?: number;
  domain_k?: number;
  global_k?: number;
  expect: RetrievalExpectation;
};

type RetrievalCorpus = {
  meta?: {
    name?: string;
    description?: string;
  };
  fixtures: FixtureSkill[];
  cases: RetrievalCase[];
};

type ResolvePayload = {
  domain_results?: SearchResult[];
  global_results?: SearchResult[];
  skipped_global?: boolean;
};

type SearchPayload = {
  results?: SearchResult[];
};

type ParsedMetadata = {
  skill_id: string | null;
  endpoint_id: string | null;
  domain: string | null;
};

type RetrievalFailure = {
  code: string;
  detail: string;
};

export type RetrievalEvaluation = {
  id: string;
  ok: boolean;
  route: RetrievalCase["route"];
  lane: "results" | "domain_results" | "global_results";
  domain_filter_checked: boolean;
  metadata_available: boolean;
  expected_rank: number | null;
  max_rank: number;
  total_results: number;
  offdomain_results: number;
  top_result: ParsedMetadata | null;
  skipped_global?: boolean;
  failures: RetrievalFailure[];
};

type RetrievalSummary = {
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  top1_hits: number;
  within_rank_hits: number;
  domain_filter_cases: number;
  domain_filter_passes: number;
  cases_with_offdomain_results: number;
};

type RetrievalArtifact = {
  generated_at: string;
  api_url: string;
  cases_path: string;
  summary: RetrievalSummary;
  results: RetrievalEvaluation[];
};

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_CASES = resolve(ROOT, "evals", "marketplace-retrieval-cases.json");
const DEFAULT_OUT = resolve(ROOT, "evals", "marketplace-retrieval-last-run.json");
const DEFAULT_API_URL = process.env.MARKETPLACE_RETRIEVAL_API_URL
  ?? process.env.GRAPH_TEST_API_URL
  ?? "https://beta-api.unbrowse.ai";
const DEFAULT_API_KEY = process.env.MARKETPLACE_RETRIEVAL_API_KEY
  ?? process.env.GRAPH_TEST_API_KEY
  ?? process.env.UNBROWSE_API_KEY
  ?? "";

const argv = process.argv.slice(2);

function getArg(flag: string): string {
  const normalized = flag.startsWith("--") ? flag : `--${flag}`;
  const index = argv.findIndex((value) => value === normalized);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

function hasFlag(flag: string): boolean {
  const normalized = flag.startsWith("--") ? flag : `--${flag}`;
  return argv.includes(normalized);
}

const casesPath = resolve(getArg("cases") || DEFAULT_CASES);
const outPath = resolve(getArg("out") || DEFAULT_OUT);
const apiUrl = getArg("api-url") || DEFAULT_API_URL;
const apiKey = getArg("api-key") || DEFAULT_API_KEY;
const skipPublish = hasFlag("skip-publish");
const REQUEST_RETRIES = Math.max(0, Number(process.env.UNBROWSE_RETRIEVAL_RETRIES ?? "4"));
const READINESS_TIMEOUT_MS = Math.max(15_000, Number(process.env.UNBROWSE_RETRIEVAL_READY_TIMEOUT_MS ?? "60000"));
const READINESS_POLL_MS = Math.max(250, Number(process.env.UNBROWSE_RETRIEVAL_READY_POLL_MS ?? "1000"));

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = withoutProtocol.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  return host.replace(/^www\./, "");
}

export function parseSearchResultMetadata(result: SearchResult): ParsedMetadata {
  const metadata = result.metadata ?? {};
  const directSkillId = typeof metadata.skill_id === "string" ? metadata.skill_id : null;
  const directEndpointId = typeof metadata.endpoint_id === "string" ? metadata.endpoint_id : null;
  const directDomain = typeof metadata.domain === "string"
    ? metadata.domain
    : typeof metadata.source_url === "string"
      ? metadata.source_url
      : null;

  const content = typeof metadata.content === "string" ? metadata.content : null;
  if (!content) {
    return {
      skill_id: directSkillId,
      endpoint_id: directEndpointId,
      domain: directDomain ? normalizeDomain(directDomain) : null,
    };
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      skill_id: typeof parsed.skill_id === "string" ? parsed.skill_id : directSkillId,
      endpoint_id: typeof parsed.endpoint_id === "string" ? parsed.endpoint_id : directEndpointId,
      domain: typeof parsed.domain === "string"
        ? normalizeDomain(parsed.domain)
        : directDomain
          ? normalizeDomain(directDomain)
          : null,
    };
  } catch {
    return {
      skill_id: directSkillId,
      endpoint_id: directEndpointId,
      domain: directDomain ? normalizeDomain(directDomain) : null,
    };
  }
}

export function domainMatchesRequested(candidate: string | null, requested: string, mode: DomainMatchMode): boolean {
  if (!candidate) return false;
  const normalizedCandidate = normalizeDomain(candidate);
  const normalizedRequested = normalizeDomain(requested);
  if (!normalizedCandidate || !normalizedRequested) return false;
  if (mode === "exact") return normalizedCandidate === normalizedRequested;
  return getRegistrableDomain(normalizedCandidate) === getRegistrableDomain(normalizedRequested);
}

function loadCorpus(path: string): RetrievalCorpus {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as RetrievalCorpus;
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
    throw new Error(`No fixtures found in ${path}`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`No cases found in ${path}`);
  }
  return raw;
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number(retryAfterHeader ?? "");
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return 500 * attempt;
}

async function requestJson(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (response.ok) {
      return { status: response.status, data };
    }
    if (response.status === 429 && attempt < REQUEST_RETRIES) {
      await Bun.sleep(retryDelayMs(attempt + 1, response.headers.get("retry-after")));
      continue;
    }
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof data?.error === "string" ? data.error : text.slice(0, 200)}`);
  }
  throw new Error(`${method} ${path} exhausted retries`);
}

async function publishFixtures(fixtures: FixtureSkill[]): Promise<void> {
  for (const fixture of fixtures) {
    await requestJson("POST", "/v1/skills", fixture);
  }
}

function expectedFixtureMap(corpus: RetrievalCorpus): Map<string, FixtureSkill> {
  return new Map(corpus.fixtures.map((fixture) => [fixture.id, fixture]));
}

function laneResults(payload: SearchPayload | ResolvePayload, lane: "results" | "domain_results" | "global_results"): SearchResult[] {
  if (lane === "results") return (payload as SearchPayload).results ?? [];
  if (lane === "domain_results") return (payload as ResolvePayload).domain_results ?? [];
  return (payload as ResolvePayload).global_results ?? [];
}

function buildRequestBody(testCase: RetrievalCase): Record<string, unknown> {
  if (testCase.route === "search") {
    return { intent: testCase.intent, k: testCase.k ?? 5 };
  }
  if (testCase.route === "domain") {
    return { intent: testCase.intent, domain: testCase.domain, k: testCase.k ?? 5 };
  }
  return {
    intent: testCase.intent,
    domain: testCase.domain,
    domain_k: testCase.domain_k ?? 5,
    global_k: testCase.global_k ?? 10,
  };
}

function routePath(testCase: RetrievalCase): string {
  if (testCase.route === "search") return "/v1/search";
  if (testCase.route === "domain") return "/v1/search/domain";
  return "/v1/search/resolve";
}

async function runCaseQuery(testCase: RetrievalCase): Promise<SearchPayload | ResolvePayload> {
  const { data } = await requestJson("POST", routePath(testCase), buildRequestBody(testCase));
  return data;
}

export function evaluateRetrievalCase(
  corpus: RetrievalCorpus,
  testCase: RetrievalCase,
  payload: SearchPayload | ResolvePayload,
): RetrievalEvaluation {
  const fixtures = expectedFixtureMap(corpus);
  const expectedFixture = fixtures.get(testCase.expect.fixture);
  if (!expectedFixture) {
    throw new Error(`Unknown fixture ${testCase.expect.fixture} in case ${testCase.id}`);
  }

  const lane = testCase.lane ?? (testCase.route === "resolve" ? "domain_results" : "results");
  const results = laneResults(payload, lane);
  const parsed = results.map(parseSearchResultMetadata);
  const maxRank = testCase.expect.max_rank ?? 1;
  const domainFilterChecked = Boolean(testCase.domain && testCase.expect.domain_match && (lane === "results" || lane === "domain_results"));
  const metadataAvailable = parsed.some((entry) => entry.skill_id || entry.endpoint_id || entry.domain);
  const expectedRankIndex = parsed.findIndex((entry) => (
    entry.skill_id === expectedFixture.skill_id && entry.endpoint_id === testCase.expect.endpoint_id
  ));
  const expectedRank = expectedRankIndex >= 0 ? expectedRankIndex + 1 : null;
  const failures: RetrievalFailure[] = [];

  if (results.length > 0 && !metadataAvailable) {
    failures.push({
      code: "missing_result_metadata",
      detail: `${lane} returned ids/scores without skill_id/endpoint_id metadata`,
    });
  }

  if (expectedRank == null) {
    failures.push({
      code: "missing_expected_result",
      detail: `missing ${expectedFixture.skill_id}:${testCase.expect.endpoint_id} in ${lane}`,
    });
  } else if (expectedRank > maxRank) {
    failures.push({
      code: "rank_regressed",
      detail: `rank ${expectedRank} > ${maxRank}`,
    });
  }

  let offdomainResults = 0;
  if (domainFilterChecked && metadataAvailable) {
    offdomainResults = parsed.filter((entry) => !domainMatchesRequested(entry.domain, testCase.domain!, testCase.expect.domain_match!)).length;
    const maxOffdomainResults = testCase.expect.max_offdomain_results ?? 0;
    if (offdomainResults > maxOffdomainResults) {
      failures.push({
        code: "domain_filter_leakage",
        detail: `${offdomainResults} off-domain result(s) > ${maxOffdomainResults}`,
      });
    }
  }

  if (testCase.route === "resolve" && typeof testCase.expect.skipped_global === "boolean") {
    const skippedGlobal = Boolean((payload as ResolvePayload).skipped_global);
    if (skippedGlobal !== testCase.expect.skipped_global) {
      failures.push({
        code: "unexpected_skipped_global",
        detail: `skipped_global=${skippedGlobal} expected ${testCase.expect.skipped_global}`,
      });
    }
  }

  return {
    id: testCase.id,
    ok: failures.length === 0,
    route: testCase.route,
    lane,
    domain_filter_checked: domainFilterChecked,
    metadata_available: metadataAvailable,
    expected_rank: expectedRank,
    max_rank: maxRank,
    total_results: results.length,
    offdomain_results: offdomainResults,
    top_result: parsed[0] ?? null,
    skipped_global: testCase.route === "resolve" ? Boolean((payload as ResolvePayload).skipped_global) : undefined,
    failures,
  };
}

export function hasExpectedResult(
  corpus: RetrievalCorpus,
  testCase: RetrievalCase,
  payload: SearchPayload | ResolvePayload,
): boolean {
  const fixtures = expectedFixtureMap(corpus);
  const expectedFixture = fixtures.get(testCase.expect.fixture);
  if (!expectedFixture) {
    throw new Error(`Unknown fixture ${testCase.expect.fixture} in case ${testCase.id}`);
  }

  const lane = testCase.lane ?? (testCase.route === "resolve" ? "domain_results" : "results");
  return laneResults(payload, lane)
    .map(parseSearchResultMetadata)
    .some((entry) => (
      entry.skill_id === expectedFixture.skill_id
      && entry.endpoint_id === testCase.expect.endpoint_id
    ));
}

function summarize(results: RetrievalEvaluation[]): RetrievalSummary {
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.ok).length;
  const top1Hits = results.filter((result) => result.expected_rank === 1).length;
  const withinRankHits = results.filter((result) => result.expected_rank != null && result.expected_rank <= result.max_rank).length;
  const domainFilterCases = results.filter((result) => result.domain_filter_checked).length;
  const domainFilterPasses = results.filter((result) => result.domain_filter_checked && result.total_results > 0 && result.metadata_available && result.offdomain_results === 0).length;
  const casesWithOffdomainResults = results.filter((result) => result.offdomain_results > 0).length;

  return {
    total_cases: totalCases,
    passed_cases: passedCases,
    failed_cases: totalCases - passedCases,
    top1_hits: top1Hits,
    within_rank_hits: withinRankHits,
    domain_filter_cases: domainFilterCases,
    domain_filter_passes: domainFilterPasses,
    cases_with_offdomain_results: casesWithOffdomainResults,
  };
}

async function waitForReadiness(corpus: RetrievalCorpus, timeoutMs = READINESS_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const checks = await Promise.all(corpus.cases.map(async (testCase) => {
      try {
        const payload = await runCaseQuery(testCase);
        return hasExpectedResult(corpus, testCase, payload);
      } catch {
        return false;
      }
    }));
    if (checks.every(Boolean)) return;
    await Bun.sleep(READINESS_POLL_MS);
  }
}

async function main(): Promise<void> {
  const corpus = loadCorpus(casesPath);
  if (!skipPublish) {
    await publishFixtures(corpus.fixtures);
    await waitForReadiness(corpus);
  }

  const results: RetrievalEvaluation[] = [];
  for (const testCase of corpus.cases) {
    const payload = await runCaseQuery(testCase);
    results.push(evaluateRetrievalCase(corpus, testCase, payload));
  }

  const summary = summarize(results);
  const artifact: RetrievalArtifact = {
    generated_at: new Date().toISOString(),
    api_url: apiUrl,
    cases_path: casesPath,
    summary,
    results,
  };
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  for (const result of results) {
    const rankText = result.expected_rank == null ? "rank=miss" : `rank=${result.expected_rank}`;
    const topText = result.top_result
      ? `${result.top_result.skill_id ?? "?"}:${result.top_result.endpoint_id ?? "?"}`
      : "none";
    const offdomainText = result.offdomain_results > 0 ? ` offdomain=${result.offdomain_results}` : "";
    if (result.ok) {
      console.log(`[marketplace-retrieval] PASS ${result.id} ${rankText} top=${topText}${offdomainText}`);
      continue;
    }
    console.log(`[marketplace-retrieval] FAIL ${result.id} ${rankText} top=${topText}${offdomainText}`);
    for (const failure of result.failures) {
      console.log(`  - ${failure.code}: ${failure.detail}`);
    }
  }

  console.log(
    `[marketplace-retrieval] ${summary.passed_cases}/${summary.total_cases} passed`
    + ` top1=${summary.top1_hits}/${summary.total_cases}`
    + ` within-rank=${summary.within_rank_hits}/${summary.total_cases}`
    + ` domain-filter=${summary.domain_filter_passes}/${summary.domain_filter_cases}`,
  );

  if (summary.failed_cases > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
