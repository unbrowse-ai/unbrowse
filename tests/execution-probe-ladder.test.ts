import { describe, expect, it } from "bun:test";
import { decideFromProbe, type ProbeResult } from "../src/execution/probe.js";

function probe(p: Partial<ProbeResult>): ProbeResult {
  return { status: 200, ms: 50, method_used: "HEAD", ...p };
}

describe("decideFromProbe", () => {
  it("200 + application/json → server", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "application/json" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("application/json");
  });

  it("200 + application/vnd.api+json → server", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "application/vnd.linkedin.normalized+json+2.1" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
  });

  it("200 + html + 50KB → server (renderedness not asserted from size alone)", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/html; charset=utf-8", byte_length: 50_000 }),
      has_trigger_url: true,
    });
    // Behavior preserved: server-fetch first is the cheap default for
    // large HTML. But the probe (HEAD / GET-1byte) never saw the body,
    // so the reason must not claim "server-rendered" from byte_length
    // alone (truth-telling fix; see probe-decision-honest-renderedness).
    expect(d.strategy).toBe("server");
    expect(d.reason).not.toContain("server-rendered");
    expect(d.reason.toLowerCase()).toMatch(/unverified|renderedness/);
  });

  it("200 + html + 800B + has_trigger_url → trigger-intercept", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/html", byte_length: 800 }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("trigger-intercept");
    expect(d.reason).toContain("SPA shell");
  });

  it("200 + html + 800B + no trigger_url → browser", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/html", byte_length: 800 }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("browser");
    expect(d.reason).toContain("no trigger_url");
  });

  it("200 + html + missing byte_length + has_trigger_url → trigger-intercept", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/html" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("trigger-intercept");
  });

  it("404 → return-error", () => {
    const d = decideFromProbe({
      probe: probe({ status: 404, content_type: "application/json" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("return-error");
    expect(d.reason).toContain("404");
  });

  it("503 → return-error", () => {
    const d = decideFromProbe({
      probe: probe({ status: 503 }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("network error (status:0) → server (libcurl-impersonate first, not browser)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 0, error: "ENOTFOUND", method_used: "GET-1byte" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("libcurl-impersonate");
  });

  it("status:0 + ZlibError → server (bun fetch gzip bug, libcurl handles)", () => {
    const d = decideFromProbe({
      probe: probe({
        status: 0,
        error: "ZlibError fetching \"https://www.ticketmaster.com/discover/concerts\"",
        method_used: "GET-1byte",
      }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("ZlibError");
  });

  it("status:0 + aborted → server (bun fetch TLS abort, libcurl handles)", () => {
    const d = decideFromProbe({
      probe: probe({
        status: 0,
        error: "The operation was aborted.",
        method_used: "GET-1byte",
      }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("aborted");
  });

  it("edge: status:0 + undefined error → server with reason containing 'unknown'", () => {
    const d = decideFromProbe({
      probe: probe({ status: 0, error: undefined, method_used: "GET-1byte" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("unknown");
  });

  it("edge: status:0 + empty-string error → server (?? doesn't coalesce empty)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 0, error: "", method_used: "GET-1byte" }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toMatch(/probe network error/);
  });

  it("adversarial: status:0 + has_dom_extraction=true → server (HTTP broken trumps DOM-recipe)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 0, error: "ENOTFOUND", method_used: "GET-1byte" }),
      has_trigger_url: true,
      has_dom_extraction: true,
      intent_wants_dom: true,
    });
    expect(d.strategy).toBe("server");
  });
  it("intent_wants_dom + non-html non-json → browser", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "image/png" }),
      has_trigger_url: false,
      intent_wants_dom: true,
    });
    expect(d.strategy).toBe("browser");
    expect(d.reason).toContain("intent wants DOM");
  });

  it("unknown content-type, 200 → server (default try)", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "application/octet-stream" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("try server");
  });

  it("200 + html + exactly 5000B is large enough for server", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/html", byte_length: 5000 }),
      has_trigger_url: true,
    });
    expect(d.strategy).toBe("server");
  });

  it("200 + text/csv → server (csv is structured)", () => {
    const d = decideFromProbe({
      probe: probe({ content_type: "text/csv" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
  });
});

// ---------------------------------------------------------------------------
// executeEndpoint integration: stub fetch so the probe sees what we want, then
// verify decision_trace ends up on the trace and the right path runs. Real
// triggerAndIntercept / executeInBrowser are not invoked in these tests
// because we either short-circuit on 4xx or hit the server-fetch branch.
// ---------------------------------------------------------------------------
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;

function mkEndpoint(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.org/api/x",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "test",
    ...over,
  };
}

function mkSkill(endpoint: EndpointDescriptor): SkillManifest {
  return {
    skill_id: "test-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "test",
    intent_signature: "test intent",
    domain: "example.org",
    description: "test",
    owner_type: "agent",
    endpoints: [endpoint],
  };
}

describe("executeEndpoint probe-ladder dispatch", () => {
  it("404 from probe surfaces as decision_trace return_error without invoking server-fetch", async () => {
    let serverFetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = (init.method || "GET").toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // Ignore fetches to other URLs (robots.txt, marketplace pricing, etc.)
      const isEndpointUrl = url.includes("/dead/post.json");
      if (method === "HEAD" && isEndpointUrl) {
        return new Response(null, {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && (init.headers as Record<string, string>)?.range && isEndpointUrl) {
        // probe ranged-GET fallback — shouldn't happen on HEAD success
        return new Response("", { status: 404 });
      }
      if (method === "GET" && isEndpointUrl) {
        // a server-fetch attempt against our endpoint — record. We expect ZERO.
        serverFetchCalls += 1;
        return new Response("", { status: 404 });
      }
      // Anything else — robots.txt, etc. Let the real fetch try (will fail in offline test but harmless).
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const skill = mkSkill(mkEndpoint({
        url_template: "https://example.org/dead/post.json",
      }));
      const out = await executeSkill(skill, {}, { raw: true });
      const trace = out.trace as typeof out.trace & { decision_trace?: Array<Record<string, unknown>> };

      expect(serverFetchCalls).toBe(0);
      expect(trace.status_code).toBe(404);
      expect(Array.isArray(trace.decision_trace)).toBe(true);
      expect(trace.decision_trace!.length).toBeGreaterThanOrEqual(3);

      const steps = trace.decision_trace!.map((s) => s.step);
      expect(steps).toContain("probe");
      expect(steps).toContain("decision");
      expect(steps).toContain("return_error");

      const decisionStep = trace.decision_trace!.find((s) => s.step === "decision");
      expect(decisionStep?.strategy).toBe("return-error");

      const result = out.result as Record<string, unknown>;
      expect(result.error).toBe("http_404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("200 + json from probe dispatches to server-fetch and stamps decision_trace", async () => {
    let serverFetchSeen = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = (init.method || "GET").toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const isEndpointUrl = url.includes("/api/data.json");
      if (method === "HEAD" && isEndpointUrl) {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "64",
          },
        });
      }
      // server-fetch: full GET on our endpoint, no range header
      if (method === "GET" && isEndpointUrl && !(init.headers as Record<string, string>)?.range) {
        serverFetchSeen = true;
        return new Response(JSON.stringify({ ok: true, value: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Anything else (robots.txt, marketplace pricing) — return harmless 404
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const skill = mkSkill(mkEndpoint({
        url_template: "https://example.org/api/data.json",
      }));
      const out = await executeSkill(skill, {}, { raw: true });
      const trace = out.trace as typeof out.trace & { decision_trace?: Array<Record<string, unknown>> };

      expect(serverFetchSeen).toBe(true);
      expect(trace.status_code).toBe(200);
      expect(trace.success).toBe(true);

      const steps = trace.decision_trace!.map((s) => s.step);
      expect(steps).toContain("probe");
      expect(steps).toContain("decision");
      expect(steps).toContain("server_fetch");

      const decisionStep = trace.decision_trace!.find((s) => s.step === "decision");
      expect(decisionStep?.strategy).toBe("server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Phase C — 400 + text/html → server (commit TBD)
  // Footlocker pattern: HEAD probe rejected with 400+html for non-browser UA,
  // GET often succeeds. Same shape as cdiscount HEAD-403 → GET-200 (a9c0ad58).
  it("400 + text/html → server (Phase C unlock)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "text/html; charset=utf-8" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toMatch(/400.*text\/html/);
  });

  it("400 + application/json → return-error (no over-trigger on real API errors)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "application/json" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("400 + empty content-type → return-error (no false-trigger without html signal)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("400 + TEXT/HTML uppercase → server (case-insensitive)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "TEXT/HTML" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
  });

  it("priority preserved: 401 still goes to server even with text/html (vendor-block branch wins over Phase C)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 401, content_type: "text/html" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toMatch(/vendor-block/);
  });

  it("priority preserved: 404 + text/html → return-error (Phase C is 400-specific)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 404, content_type: "text/html" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("priority preserved: 500 + text/html → return-error at probe; executor's Phase D fallback handles 5xx", () => {
    const d = decideFromProbe({
      probe: probe({ status: 500, content_type: "text/html" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  // Step 5 lost-sheep guards: regex is /text\/html\b/i to prevent
  // substring false-positives on impossible-but-theoretical content-types.
  it("Phase C divers: text/htmlembedded → return-error (no substring false-positive)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "text/htmlembedded" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("Phase C divers: text/html5 → return-error (\\b stops at digit boundary in non-word sense)", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "text/html5" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("return-error");
  });

  it("Phase C divers: multi-value text/html, application/xhtml+xml → server", () => {
    const d = decideFromProbe({
      probe: probe({ status: 400, content_type: "text/html, application/xhtml+xml" }),
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
  });
});
