import { describe, test, expect } from "bun:test";
import {
  LocalAuthRuntime, authRuntime, resolveAuthPrerequisites, deriveAuthDependencies,
  type AuthDependency,
} from "../src/auth/runtime.js";
import { fetchDagAdvisoryPlan } from "../src/lib/graph-core/planner.js";
import type { SkillManifest } from "../src/types/index.js";

function makeAuthGatedSkill(domain: string): SkillManifest {
  return {
    skill_id: "test-auth-skill", name: "Test", domain,
    description: "Auth skill", version: "0.0.1",
    endpoints: [
      { endpoint_id: "get-profile", url_template: `https://${domain}/api/profile`,
        method: "GET", description: "Profile (auth)", reliability_score: 0.9,
        response_schema: { type: "object", properties: { name: { type: "string" } } },
        semantic: { auth_required: true } },
      { endpoint_id: "get-public", url_template: `https://${domain}/api/public`,
        method: "GET", description: "Public", reliability_score: 0.9,
        response_schema: { type: "object", properties: { items: { type: "array" } } } },
    ],
    auth_profile_ref: `${domain}-session`,
  } as SkillManifest;
}

describe("#230 authRuntime singleton", () => {
  test("importable", () => {
    expect(authRuntime).toBeDefined();
    expect(typeof authRuntime.resolveAuth).toBe("function");
  });
  test("LocalAuthRuntime instantiates", () => {
    expect(new LocalAuthRuntime()).toBeInstanceOf(LocalAuthRuntime);
  });
});

describe("#230 auth dependency resolution", () => {
  test("false without session", async () => {
    const rt = new LocalAuthRuntime();
    expect((await rt.resolveAuth({ domain: "g.com", strategy: "login_if_needed" })).authenticated).toBe(false);
  });
  test("true with session", async () => {
    const rt = new LocalAuthRuntime();
    rt.setSession("g.com", "tok", 60000);
    const r = await rt.resolveAuth({ domain: "g.com", strategy: "login_if_needed" });
    expect(r.authenticated).toBe(true);
    expect(r.session_token).toBe("tok");
  });
  test("refresh_session works", async () => {
    const rt = new LocalAuthRuntime();
    rt.setSession("g.com", "old", -1000);
    expect((await rt.resolveAuth({ domain: "g.com", strategy: "refresh_session" })).authenticated).toBe(true);
  });
  test("ensure_account fails", async () => {
    const rt = new LocalAuthRuntime();
    expect((await rt.resolveAuth({ domain: "g.com", strategy: "ensure_account" })).authenticated).toBe(false);
  });
});

describe("#230 deriveAuthDependencies", () => {
  test("detects auth_required", () => {
    const d = deriveAuthDependencies(makeAuthGatedSkill("g.com"), "get-profile");
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].domain).toBe("g.com");
  });
  test("empty for public", () => {
    const s = { skill_id: "s", name: "s", domain: "p.com", description: "", version: "1",
      endpoints: [{ endpoint_id: "e", url_template: "u", method: "GET", description: "", reliability_score: 1 }]
    } as SkillManifest;
    expect(deriveAuthDependencies(s, "e").length).toBe(0);
  });
  test("detects auth_profile_ref", () => {
    const s = { skill_id: "s", name: "s", domain: "r.com", description: "", version: "1",
      auth_profile_ref: "r.com-session",
      endpoints: [{ endpoint_id: "e", url_template: "u", method: "GET", description: "", reliability_score: 1 }]
    } as SkillManifest;
    expect(deriveAuthDependencies(s, "e").length).toBeGreaterThan(0);
  });
});

describe("#230 DagAdvisoryPlan auth_dependencies", () => {
  test("field exists", () => {
    const p = fetchDagAdvisoryPlan(makeAuthGatedSkill("g.com"), "get-profile", []);
    expect("auth_dependencies" in p).toBe(true);
    expect(Array.isArray(p.auth_dependencies)).toBe(true);
  });
  test("includes domain", () => {
    const p = fetchDagAdvisoryPlan(makeAuthGatedSkill("g.com"), "get-profile", []);
    expect(p.auth_dependencies.length).toBeGreaterThan(0);
    expect(p.auth_dependencies[0].domain).toBe("g.com");
  });
  test("present on auth-gated skill", () => {
    const p = fetchDagAdvisoryPlan(makeAuthGatedSkill("g.com"), "get-public", []);
    expect(p.auth_dependencies).toBeDefined();
  });
});

describe("#230 resolveAuthPrerequisites", () => {
  test("callable", () => { expect(typeof resolveAuthPrerequisites).toBe("function"); });
  test("unauthenticated without session", async () => {
    // Block vault + browser-cookie probes so the test asserts the
    // unauthenticated path regardless of what the dev's Chrome has.
    const prev = process.env.UNBROWSE_DISABLE_AUTH_FALLBACK;
    process.env.UNBROWSE_DISABLE_AUTH_FALLBACK = "1";
    try {
      const r = await resolveAuthPrerequisites([{ domain: "x.com", strategy: "login_if_needed" }]);
      expect(r[0].authenticated).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_DISABLE_AUTH_FALLBACK;
      else process.env.UNBROWSE_DISABLE_AUTH_FALLBACK = prev;
    }
  });
});
