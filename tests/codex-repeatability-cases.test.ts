import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";

const ROOT = join(import.meta.dir, "..");

type RawRepeatabilityCase = {
  id: string;
  url: string;
  expected_fields: string[];
  retention_signal?: string;
  sticky_rationale?: string;
  params?: Record<string, unknown>;
  benchmark_gate?: {
    require_warm_cache_hit?: boolean;
    allowed_warm_sources?: string[];
    disallowed_warm_sources?: string[];
    max_warm_total_ms?: number;
  };
};

describe("codex repeatability cases", () => {
  it("stay public, diverse, and encode repeat-use intent", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.repeatability.json"), "utf-8"),
    ) as {
      meta?: {
        benchmark_gate_defaults?: {
          require_warm_cache_hit?: boolean;
          allowed_warm_sources?: string[];
          disallowed_warm_sources?: string[];
          max_warm_total_ms?: number;
        };
      };
      cases?: RawRepeatabilityCase[];
    };

    const cases = normalizeHarnessCases(raw);
    const rawCases = raw.cases ?? [];
    const defaults = raw.meta?.benchmark_gate_defaults;

    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(rawCases.length).toBe(cases.length);
    expect(defaults?.require_warm_cache_hit).toBe(true);
    expect(defaults?.allowed_warm_sources?.length ?? 0).toBeGreaterThan(0);
    expect(defaults?.disallowed_warm_sources).toContain("live-capture");
    expect(defaults?.max_warm_total_ms ?? 0).toBeGreaterThan(0);

    const ids = new Set<string>();
    const hosts = new Set<string>();
    let seededParams = 0;

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index]!;
      const rawCase = rawCases[index]!;

      expect(testCase.auth).toBeUndefined();
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.url.startsWith("https://")).toBe(true);
      expect(ids.has(testCase.id)).toBe(false);
      expect(rawCase.retention_signal?.length ?? 0).toBeGreaterThan(0);
      expect(rawCase.sticky_rationale?.length ?? 0).toBeGreaterThan(20);
      if (rawCase.benchmark_gate?.allowed_warm_sources) {
        expect(rawCase.benchmark_gate.allowed_warm_sources.length).toBeGreaterThan(0);
      }

      ids.add(testCase.id);
      hosts.add(new URL(testCase.url).hostname);
      if (testCase.params) seededParams += 1;
    }

    expect(hosts.size).toBeGreaterThanOrEqual(8);
    expect(seededParams).toBeGreaterThanOrEqual(1);

    expect(ids.has("github-search-repositories")).toBe(true);
    expect(ids.has("npm-package-info")).toBe(true);
    expect(ids.has("arxiv-search-papers")).toBe(true);
    expect(ids.has("huggingface-search-models")).toBe(true);
    expect(ids.has("mdn-search-docs")).toBe(true);
    expect(ids.has("stack-overflow-tag-questions")).toBe(true);
    expect(ids.has("docker-image-tags")).toBe(true);
    expect(ids.has("hn-search-param-seeded")).toBe(true);
  });
});
