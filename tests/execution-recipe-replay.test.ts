import { describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { EndpointDescriptor, ProvenRecipe, SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;

function mkRecipe(over: Partial<ProvenRecipe> = {}): ProvenRecipe {
  return {
    method: "GET",
    url_template: "https://example.org/api/data.json",
    // Unique marker header — lets the stub identify a recipe-replay fetch
    headers: { "x-test-marker": "recipe-replay" },
    response_signal: {
      status: 200,
      content_type: "application/json",
      byte_length_min: 50,
      byte_length_max: 500,
      json_top_keys: ["data", "ok"],
    },
    captured_at: "2026-04-01T00:00:00Z",
    ...over,
  };
}

function mkEndpoint(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.org/api/data.json",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "test endpoint",
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

interface StubOpts {
  recipeStatus?: number;
  recipeBody?: string;
  recipeContentType?: string;
  probeStatus?: number;
  probeContentType?: string;
  probeContentLength?: string;
  serverStatus?: number;
  serverBody?: string;
  /** Optional URL substring filter — only stub matching URLs (default: example.org) */
  endpointHostMatch?: string;
}

function makeStubFetch(opts: StubOpts = {}) {
  const counters = { recipe: 0, probeHead: 0, probeRangedGet: 0, server: 0 };
  const hostMatch = opts.endpointHostMatch ?? "example.org";
  const stub = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    const isEndpoint = url.includes(hostMatch) && !url.includes("/robots.txt");
    if (!isEndpoint) {
      // robots.txt / marketplace / pricing — harmless 404
      return new Response("", { status: 404 });
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const range = headers["range"];
    const isProbeHead = method === "HEAD";
    const isProbeRanged = method === "GET" && !!range;
    const isRecipeReplay = headers["x-test-marker"] === "recipe-replay";

    if (isProbeHead) {
      counters.probeHead += 1;
      return new Response(null, {
        status: opts.probeStatus ?? 200,
        headers: {
          ...(opts.probeContentType ? { "content-type": opts.probeContentType } : {}),
          ...(opts.probeContentLength ? { "content-length": opts.probeContentLength } : {}),
        },
      });
    }
    if (isProbeRanged) {
      counters.probeRangedGet += 1;
      return new Response("", { status: opts.probeStatus ?? 200 });
    }
    if (isRecipeReplay) {
      counters.recipe += 1;
      return new Response(opts.recipeBody ?? JSON.stringify({ data: [], ok: true }), {
        status: opts.recipeStatus ?? 200,
        headers: { "content-type": opts.recipeContentType ?? "application/json" },
      });
    }
    // Anything else hitting our endpoint host = server-fetch / browser-fetch
    counters.server += 1;
    return new Response(opts.serverBody ?? JSON.stringify({ ok: true }), {
      status: opts.serverStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { stub, counters };
}

describe("executeEndpoint recipe replay (Phase 7.2)", () => {
  it("recipe hit → recipe_replay match:true, no probe, no server-fetch", async () => {
    const body = JSON.stringify({ data: Array(8).fill("x"), ok: true });
    expect(body.length).toBeGreaterThanOrEqual(50);
    expect(body.length).toBeLessThanOrEqual(500);

    const { stub, counters } = makeStubFetch({ recipeBody: body });
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint({ proven_recipe: mkRecipe() }));
      const out = await executeSkill(skill, {}, { raw: true });

      expect(counters.recipe).toBe(1);
      expect(counters.probeHead).toBe(0);
      expect(counters.probeRangedGet).toBe(0);
      expect(counters.server).toBe(0);

      expect(Array.isArray(out.decision_trace)).toBe(true);
      const steps = out.decision_trace!.map((s) => s.step);
      expect(steps).toContain("recipe_replay");
      expect(steps).not.toContain("probe");
      expect(steps).not.toContain("server_fetch");

      const recipeStep = out.decision_trace!.find((s) => s.step === "recipe_replay")!;
      expect(recipeStep.match).toBe(true);
      expect(recipeStep.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recipe miss by status (200→403) → match:false reason status_changed, falls through to probe", async () => {
    const { stub, counters } = makeStubFetch({
      recipeStatus: 403,
      recipeBody: JSON.stringify({ error: "forbidden" }),
      probeStatus: 403,
      probeContentType: "application/json",
    });
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint({ proven_recipe: mkRecipe() }));
      const out = await executeSkill(skill, {}, { raw: true });

      expect(counters.recipe).toBe(1);
      expect(counters.probeHead).toBe(1); // probe ran after recipe miss

      const steps = out.decision_trace!.map((s) => s.step);
      expect(steps).toContain("recipe_replay");
      expect(steps).toContain("probe");
      expect(steps).toContain("decision");

      const recipeStep = out.decision_trace!.find((s) => s.step === "recipe_replay")!;
      expect(recipeStep.match).toBe(false);
      expect(String(recipeStep.reason)).toContain("status_changed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recipe miss by byte_length (body shrunk well below min) → match:false reason body_shrunk", async () => {
    const { stub, counters } = makeStubFetch({
      recipeBody: "tiny",
      probeStatus: 200,
      probeContentType: "application/json",
    });
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint({ proven_recipe: mkRecipe() }));
      const out = await executeSkill(skill, {}, { raw: true });

      expect(counters.recipe).toBe(1);
      const recipeStep = out.decision_trace!.find((s) => s.step === "recipe_replay")!;
      expect(recipeStep.match).toBe(false);
      expect(String(recipeStep.reason)).toContain("body_shrunk");
      const steps = out.decision_trace!.map((s) => s.step);
      expect(steps).toContain("probe");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recipe miss by missing top-level keys → match:false reason missing_top_keys", async () => {
    const body = JSON.stringify({ unrelated: "x".repeat(80) });
    const { stub, counters } = makeStubFetch({
      recipeBody: body,
      probeStatus: 200,
      probeContentType: "application/json",
    });
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint({ proven_recipe: mkRecipe() }));
      const out = await executeSkill(skill, {}, { raw: true });

      const recipeStep = out.decision_trace!.find((s) => s.step === "recipe_replay")!;
      expect(recipeStep.match).toBe(false);
      expect(String(recipeStep.reason)).toContain("missing_top_keys");
      expect(counters.probeHead).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recipe with unsubstituted {placeholder} in URL → recipe SKIPPED entirely, probe runs", async () => {
    const { stub, counters } = makeStubFetch({
      probeStatus: 200,
      probeContentType: "application/json",
      probeContentLength: "120",
    });
    globalThis.fetch = stub;
    try {
      const recipe = mkRecipe({ url_template: "https://example.org/api/items/{id}" });
      const ep = mkEndpoint({
        url_template: "https://example.org/api/items/{id}",
        proven_recipe: recipe,
      });
      const skill = mkSkill(ep);
      const out = await executeSkill(skill, {}, { raw: true });

      expect(counters.recipe).toBe(0); // recipe not even attempted
      expect(counters.probeHead).toBe(1);

      const steps = out.decision_trace!.map((s) => s.step);
      expect(steps).not.toContain("recipe_replay");
      expect(steps).toContain("probe");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("endpoint without proven_recipe → no recipe_replay step at all", async () => {
    const { stub, counters } = makeStubFetch({
      probeStatus: 200,
      probeContentType: "application/json",
      probeContentLength: "64",
    });
    globalThis.fetch = stub;
    try {
      const skill = mkSkill(mkEndpoint());
      const out = await executeSkill(skill, {}, { raw: true });

      expect(counters.recipe).toBe(0);
      expect(counters.probeHead).toBe(1);

      const steps = out.decision_trace!.map((s) => s.step);
      expect(steps).not.toContain("recipe_replay");
      expect(steps).toContain("probe");
      expect(steps).toContain("server_fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
