import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import { clearRobotsCache } from "../src/execution/robots.js";
import { deleteCredential, storeCredential } from "../src/vault/index.js";
import type { SkillManifest } from "../src/types/index.js";

const AUTH_KEY = "robots-auth.example-session";

describe("authenticated execution vs robots gate", () => {
  beforeEach(() => {
    clearRobotsCache();
  });

  afterEach(async () => {
    await deleteCredential(AUTH_KEY).catch(() => {});
  });

  it("does not block authenticated execution on robots.txt before replay", async () => {
    await storeCredential(AUTH_KEY, JSON.stringify({
      cookies: [{ name: "li_at", value: "token-1", domain: ".example.com" }],
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private-feed\n", { status: 200 });
      }
      if (url === "https://example.com/private-feed") {
        return new Response(JSON.stringify({ ok: true, posts: [{ id: "post-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const skill: SkillManifest = {
        skill_id: "skill-auth-robots",
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active",
        execution_type: "http",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: "example.com",
        intent_signature: "get private feed",
        domain: "example.com",
        description: "Authenticated feed",
        owner_type: "agent",
        auth_profile_ref: AUTH_KEY,
        endpoints: [
          {
            endpoint_id: "feed",
            method: "GET",
            url_template: "https://example.com/private-feed",
            idempotency: "safe",
            verification_status: "verified",
            reliability_score: 1,
            description: "Private feed",
            semantic: {
              action_kind: "timeline",
              resource_kind: "post",
              auth_required: true,
            },
          },
        ],
      };

      const out = await executeSkill(skill, {}, { raw: true }, {
        intent: "get private feed",
        contextUrl: "https://example.com/private-feed",
      });

      expect(out.trace.success).toBe(true);
      expect(out.result).toEqual({ ok: true, posts: [{ id: "post-1" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
