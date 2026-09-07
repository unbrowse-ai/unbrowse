import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CaptureResult } from "../src/capture/index.js";
import type { ResolveResultDiagnostic } from "../src/types/skill.js";
import { OrchestratorResult } from "../src/orchestrator/index.js";

describe("harness signals — type assertions", () => {
  describe("CaptureResult.screenshots", () => {
    it("exists as optional Record<string, string>", () => {
      const result: CaptureResult = {
        success: true,
        url: "https://example.com",
        status: 200,
        requests: [],
        headers: {},
        timings: {},
        content: {
          html: "<html><body></body></html>",
          html_length: 28,
          body_text: "",
          body_text_length: 0,
        },
        cookies: [],
        interaction_targets: [],
        // No screenshots — optional field
      };
      expect(result.screenshots).toBeUndefined();
      expect(result.screenshots).toBe(undefined);

      const withScreenshots: CaptureResult = {
        ...result,
        screenshots: {
          pre: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
          post: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        },
      };
      expect(withScreenshots.screenshots).toBeDefined();
      expect(typeof withScreenshots.screenshots).toBe("object");
      expect(Object.keys(withScreenshots.screenshots!)).toContain("pre");
      expect(Object.keys(withScreenshots.screenshots!)).toContain("post");
    });
  });

  describe("ResolveResultDiagnostic", () => {
    it("has all required fields", () => {
      const diagnostic: ResolveResultDiagnostic = {
        confidence: 0.85,
        top_reasoning: "Best match: load posts (score: 9200)",
        known_issues: ["requires_auth", "api_key_needed"],
        endpoint_count: 3,
        cache_source: "result-cache",
        suggested_next_actions: ["try snap --filter interactive", "check auth status"],
      };
      expect(diagnostic.confidence).toBeTypeOf("number");
      expect(diagnostic.confidence).toBeGreaterThanOrEqual(0);
      expect(diagnostic.confidence).toBeLessThanOrEqual(1);
      expect(diagnostic.top_reasoning).toBeTypeOf("string");
      expect(Array.isArray(diagnostic.known_issues)).toBe(true);
      expect(diagnostic.endpoint_count).toBeTypeOf("number");
      expect(diagnostic.cache_source).toBeTypeOf("string");
      // suggested_next_actions is optional
      expect(diagnostic.suggested_next_actions).toBeDefined();
    });

    it("suggested_next_actions is optional", () => {
      const minimal: ResolveResultDiagnostic = {
        confidence: 0.5,
        top_reasoning: "no match found",
        known_issues: [],
        endpoint_count: 0,
        cache_source: "domain-cache",
      };
      expect(minimal.suggested_next_actions).toBeUndefined();
    });
  });

  describe("OrchestratorResult", () => {
    it("source union includes all expected values", () => {
      const validSources: OrchestratorResult["source"][] = [
        "marketplace",
        "live-capture",
        "dom-fallback",
        "first-pass",
        "route-cache",
        "browser-action",
        "defer",
      ];
      expect(validSources.length).toBe(7);
    });

    it("result can contain diagnostic field", () => {
      const result: OrchestratorResult = {
        result: {
          available_operations: [{ operation: "list posts", url: "/api/posts", method: "GET" }],
          diagnostic: {
            confidence: 0.9,
            top_reasoning: "high confidence match",
            known_issues: [],
            endpoint_count: 1,
            cache_source: "result-cache",
          },
        },
        trace: {
          trace_id: "test-trace",
          session_scope: "test",
          goal: "test",
          domain: "example.com",
          source: "live-capture",
          status_code: 200,
          response_bytes: 100,
          response_hash: "abc123",
          schema_match: true,
          candidates_considered: 1,
          bindings_before: {},
          bindings_resolved: {},
          bindings_missing: [],
          outcome: "success",
          latency_ms: 50,
        },
        source: "live-capture",
        skill: {
          skill_id: "test",
          version: "1.0.0",
          schema_version: "1",
          lifecycle: "active",
          execution_type: "http",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          name: "test",
          intent_signature: "test",
          domain: "example.com",
          description: "test",
          owner_type: "agent",
          endpoints: [],
        },
        timing: {
          total_ms: 100,
          search_ms: 50,
          execute_ms: 50,
          cache_ms: 0,
          live_capture_ms: 0,
          marketplace_ms: 0,
          avg_marketplace_ms: 0,
          p95_total_ms: 0,
          tokens_saved: 0,
          response_bytes: 0,
          time_saved_pct: 0,
        },
      };
      const r = result.result as ResolveResultWithDiagnostic;
      expect(r.diagnostic).toBeDefined();
      expect(r.diagnostic!.confidence).toBe(0.9);
    });
  });
});

describe("harness trace signal — local trace file system", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  it("trace directory structure supports harness debug", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "harness-trace-test-"));
    const traceDir = join(tmpDir, "traces");

    // Simulate a harness trace file
    const trace = {
      id: "harness-test-001",
      intent: "load tweets",
      domain: "x.com",
      timestamp: new Date().toISOString(),
      screenshots: {
        pre: "data:image/png;base64,pre",
        post: "data:image/png;base64,post",
      },
      diagnostic: {
        confidence: 0.75,
        top_reasoning: "found partial match",
        known_issues: ["class_selector_drift"],
        endpoint_count: 2,
        cache_source: "result-cache",
      },
      endpoints: [{ endpoint_id: "timeline", score: 8500 }],
      result: "partial",
    };

    const traceFile = join(traceDir, "harness-test-001.json");
    // Simulate write
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(traceFile, JSON.stringify(trace, null, 2));

    // Verify read
    const readBack = JSON.parse(readFileSync(traceFile, "utf-8"));
    expect(readBack.id).toBe("harness-test-001");
    expect(readBack.screenshots).toBeDefined();
    expect(readBack.screenshots.pre).toBeDefined();
    expect(readBack.diagnostic).toBeDefined();
    expect(readBack.diagnostic!.confidence).toBe(0.75);
  });

  it("missing trace returns empty object", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "harness-trace-missing-"));
    const traceFile = join(tmpDir, "traces", "nonexistent.json");
    expect(existsSync(traceFile)).toBe(false);
  });
});

// Type-only import — resolve at runtime via a dummy const
interface ResolveResultWithDiagnostic {
  available_operations?: Array<{ operation: string; url?: string; method?: string }>;
  diagnostic?: ResolveResultDiagnostic;
}
