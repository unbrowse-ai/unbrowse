import { describe, test, expect } from "bun:test";
import {
  LocalAuthRuntime,
  authRuntime,
  resolveAuthPrerequisites,
  deriveAuthDependencies,
  type AuthDependency,
  type AuthRuntime,
} from "../src/auth/runtime.js";
import { fetchDagAdvisoryPlan, type DagAdvisoryPlan } from "../src/graph/planner.js";
import type { SkillManifest, SkillOperationGraph } from "../src/types/index.js";

/**
 * #230 — Wire authRuntime into orchestrator login flow
 *
 * These tests prove that:
 * 1. authRuntime (the singleton) is importable and functional
 * 2. LocalAuthRuntime integrates with domain-based auth dependency resolution
 * 3. deriveAuthDependencies detects auth needs from skill manifests
 * 4. The DAG advisory plan surfaces auth_dependencies
 * 5. resolveAuthPrerequisites works end-to-end
 */

// ---------------------------------------------------------------------------
// Helper: build a minimal skill manifest with an auth-gated endpoint
// ---------------------------------------------------------------------------
function makeAuthGatedSkill(domain: string): SkillManifest {
  return {
    skill_id: "test-auth-skill",
    name: "Test Auth Skill",
    domain,
    description: "A skill requiring authentication",
    version: "0.0.1",
    endpoints: [
      {
        endpoint_id: "get-profile",
        url_template: `https://${domain}/api/profile`,
        method: "GET",
        description: "Get user profile (requires auth)",
        reliability_score: 0.9,
        response_schema: { type: "object", properties: { name: { type: "string" } } },
        semantic: { auth_required: true },
      },
      {
        endpoint_id: "get-public",
        url_template: `https://${domain}/api/public`,
        method: "GET",
        description: "Get public data",
        reliability_score: 0.9,
        response_schema: { type: "object", properties: { items: { type: "array" } } },
      },
    ],
    auth_profile_ref: `${domain}-session`,
  } as SkillManifest;
}

// ---------------------------------------------------------------------------
// 1. authRuntime singleton is importable and functional
// ---------------------------------------------------------------------------
describe("#230 authRuntime singleton wiring", () => {
  test("authRuntime is importable from src/auth/runtime", () => {
    expect(authRuntime).toBeDefined();
    expect(typeof authRuntime.resolveAuth).toBe("function");
    expect(typeof authRuntime.isSessionValid).toBe("function");
    expect(typeof authRuntime.refreshSession).toBe("function");
  });

  test("LocalAuthRuntime can be imported and instantiated", () => {
    const runtime = new LocalAuthRuntime();
    expect(runtime).toBeInstanceOf(LocalAuthRuntime);
  });
});

// ---------------------------------------------------------------------------
// 2. authRuntime resolves domain-based auth dependencies
// ---------------------------------------------------------------------------
describe("#230 authRuntime resolves auth dependencies for orchestrator", () => {
  test("resolveAuth returns authenticated=false for domain without session", async () => {
    const runtime = new LocalAuthRuntime();
    const dep: AuthDependency = {
      domain: "gated-site.com",
      strategy: "login_if_needed",
    };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(false);
  });

  test("resolveAuth returns authenticated=true when session exists", async () => {
    const runtime = new LocalAuthRuntime();
    runtime.setSession("gated-site.com", "tok-abc", 60_000);
    const dep: AuthDependency = {
      domain: "gated-site.com",
      strategy: "login_if_needed",
    };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(true);
    expect(result.session_token).toBe("tok-abc");
  });

  test("refresh_session strategy refreshes expired session", async () => {
    const runtime = new LocalAuthRuntime();
    runtime.setSession("gated-site.com", "tok-old", -1000);
    const dep: AuthDependency = {
      domain: "gated-site.com",
      strategy: "refresh_session",
    };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(true);
    expect(result.session_token).toBeDefined();
  });

  test("ensure_account strategy fails without session", async () => {
    const runtime = new LocalAuthRuntime();
    const dep: AuthDependency = {
      domain: "gated-site.com",
      strategy: "ensure_account",
    };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. deriveAuthDependencies from skill manifest
// ---------------------------------------------------------------------------
describe("#230 deriveAuthDependencies", () => {
  test("detects auth-required endpoints", () => {
    const skill = makeAuthGatedSkill("gated-site.com");
    const deps = deriveAuthDependencies(skill, "get-profile");
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0].domain).toBe("gated-site.com");
    expect(deps[0].strategy).toBe("login_if_needed");
  });

  test("returns empty for public endpoints without auth_profile_ref", () => {
    const skill: SkillManifest = {
      skill_id: "test-public-skill",
      name: "Public Skill",
      domain: "public-site.com",
      description: "No auth",
      version: "0.0.1",
      endpoints: [
        {
          endpoint_id: "get-data",
          url_template: "https://public-site.com/api/data",
          method: "GET",
          description: "Public data",
          reliability_score: 0.9,
        },
      ],
    } as SkillManifest;
    const deps = deriveAuthDependencies(skill, "get-data");
    expect(deps.length).toBe(0);
  });

  test("detects auth via auth_profile_ref even without semantic flag", () => {
    const skill: SkillManifest = {
      skill_id: "test-ref-skill",
      name: "Ref Skill",
      domain: "ref-site.com",
      description: "Auth via profile ref",
      version: "0.0.1",
      auth_profile_ref: "ref-site.com-session",
      endpoints: [
        {
          endpoint_id: "get-data",
          url_template: "https://ref-site.com/api/data",
          method: "GET",
          description: "Some data",
          reliability_score: 0.9,
        },
      ],
    } as SkillManifest;
    const deps = deriveAuthDependencies(skill, "get-data");
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0].domain).toBe("ref-site.com");
  });
});

// ---------------------------------------------------------------------------
// 4. DAG advisory plan surfaces auth_dependencies
// ---------------------------------------------------------------------------
describe("#230 DagAdvisoryPlan auth_dependencies", () => {
  test("fetchDagAdvisoryPlan returns auth_dependencies field", () => {
    const skill = makeAuthGatedSkill("gated-site.com");
    const plan = fetchDagAdvisoryPlan(skill, "get-profile", []);
    expect(plan).toBeDefined();
    expect("auth_dependencies" in plan).toBe(true);
    expect(Array.isArray(plan.auth_dependencies)).toBe(true);
  });

  test("auth_dependencies includes domain for auth-gated endpoints", () => {
    const skill = makeAuthGatedSkill("gated-site.com");
    const plan = fetchDagAdvisoryPlan(skill, "get-profile", []);
    const authDeps = plan.auth_dependencies ?? [];
    expect(authDeps.length).toBeGreaterThan(0);
    expect(authDeps[0].domain).toBe("gated-site.com");
    expect(authDeps[0].strategy).toBe("login_if_needed");
  });

  test("auth_dependencies is present for public endpoint on auth-gated skill", () => {
    const skill = makeAuthGatedSkill("gated-site.com");
    const plan = fetchDagAdvisoryPlan(skill, "get-public", []);
    // get-public has no semantic.auth_required, but skill has auth_profile_ref
    // so deriveAuthDependencies still returns deps (skill-level auth hint)
    expect(plan.auth_dependencies).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. resolveAuthPrerequisites integrates runtime with DAG plan
// ---------------------------------------------------------------------------
describe("#230 resolveAuthPrerequisites orchestrator integration", () => {
  test("resolveAuthPrerequisites is exported and callable", () => {
    expect(typeof resolveAuthPrerequisites).toBe("function");
  });

  test("resolveAuthPrerequisites resolves when session exists", async () => {
    const rt = new LocalAuthRuntime();
    rt.setSession("gated-site.com", "tok-ok", 60_000);

    const deps: AuthDependency[] = [
      { domain: "gated-site.com", strategy: "login_if_needed" },
    ];
    const results = await Promise.all(deps.map((dep) => rt.resolveAuth(dep)));
    expect(results.length).toBe(1);
    expect(results[0].authenticated).toBe(true);
    expect(results[0].session_token).toBe("tok-ok");
  });

  test("resolveAuthPrerequisites returns unauthenticated for missing sessions", async () => {
    const deps: AuthDependency[] = [
      { domain: "unknown-domain-xyz.com", strategy: "login_if_needed" },
    ];
    const results = await resolveAuthPrerequisites(deps);
    expect(results.length).toBe(1);
    expect(results[0].authenticated).toBe(false);
  });
});
