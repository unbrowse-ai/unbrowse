import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  issueDomainChallenge,
  loadDomainChallenge,
  probeDomain,
  type DomainChallenge,
} from "../src/services/domain-verifier.js";
import type { Env } from "../src/types.js";

function makeEnv(extra: Partial<Env> = {}): Env {
  // Use local-dev so statsKV() returns the in-process LocalKV (no network).
  return {
    API_KEY: "admin",
    EMERGENTDB_API_KEY: "test",
    NEBIUS_API_KEY: "nebius",
    ENVIRONMENT: "local-dev",
    STATS_KV: {} as unknown as KVNamespace,
    TURBOBOX_URL: "https://stub.local",
    R2_BUCKET: {} as unknown as R2Bucket,
    FAL_KEY: "fal",
    ...extra,
  } as Env;
}

describe("domain-verifier", () => {
  describe("issueDomainChallenge / loadDomainChallenge", () => {
    it("issues a token-bearing challenge bound to the requesting agent", async () => {
      const env = makeEnv();
      const c = await issueDomainChallenge(env, "example.com", "agent-alpha");
      expect(c.token.startsWith("unbrowse-verify-")).toBe(true);
      expect(c.path).toBe(`/.well-known/${c.token}`);
      expect(c.expected_url).toBe(`https://example.com${c.path}`);
      expect(c.body.startsWith("unbrowse-domain-control:example.com:")).toBe(true);
      expect(c.agent_id).toBe("agent-alpha");

      const loaded = await loadDomainChallenge(env, "example.com");
      expect(loaded?.token).toBe(c.token);
    });

    it("returns null when no challenge exists", async () => {
      const env = makeEnv();
      expect(await loadDomainChallenge(env, "never-issued.example")).toBeNull();
    });
  });

  describe("probeDomain", () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    function fakeChallenge(domain: string): DomainChallenge {
      return {
        domain,
        token: "unbrowse-verify-test123",
        body: `unbrowse-domain-control:${domain}:unbrowse-verify-test123`,
        path: "/.well-known/unbrowse-verify-test123",
        expected_url: `https://${domain}/.well-known/unbrowse-verify-test123`,
        agent_id: "agent-alpha",
        created_at: "2026-05-09T00:00:00.000Z",
        expires_at: "2026-05-09T00:30:00.000Z",
      };
    }

    it("succeeds when the served body matches", async () => {
      const env = makeEnv();
      const challenge = fakeChallenge("example.com");
      globalThis.fetch = (async () => new Response(challenge.body, { status: 200 })) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    });

    it("fails on body mismatch", async () => {
      const env = makeEnv();
      const challenge = fakeChallenge("example.com");
      globalThis.fetch = (async () => new Response("nope-different", { status: 200 })) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("body_mismatch");
    });

    it("rejects 3xx redirects (no following)", async () => {
      const env = makeEnv();
      const challenge = fakeChallenge("example.com");
      globalThis.fetch = (async () => new Response("", {
        status: 302,
        headers: { Location: "https://attacker.com/.well-known/unbrowse-verify-test123" },
      })) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("redirect_not_allowed");
    });

    it("blocks loopback domains so a publisher can't pass via 127.0.0.1", async () => {
      const env = makeEnv();
      const challenge: DomainChallenge = {
        ...fakeChallenge("localhost"),
        expected_url: "https://localhost/.well-known/unbrowse-verify-test123",
      };
      globalThis.fetch = (async () => {
        throw new Error("should not have been called");
      }) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("host_blocked");
    });

    it("blocks RFC1918 ranges", async () => {
      const env = makeEnv();
      const challenge: DomainChallenge = {
        ...fakeChallenge("10.0.0.5"),
        expected_url: "https://10.0.0.5/.well-known/unbrowse-verify-test123",
      };
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("host_blocked");
    });

    it("blocks numeric-encoded loopback (http://2130706433/)", async () => {
      const env = makeEnv();
      const challenge: DomainChallenge = {
        ...fakeChallenge("2130706433"),
        expected_url: "https://2130706433/.well-known/unbrowse-verify-test123",
      };
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("host_blocked");
    });

    it("rejects http:// (https-only)", async () => {
      const env = makeEnv();
      const challenge: DomainChallenge = {
        ...fakeChallenge("example.com"),
        expected_url: "http://example.com/.well-known/unbrowse-verify-test123",
      };
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("https_only");
    });

    it("fails on non-200 responses", async () => {
      const env = makeEnv();
      const challenge = fakeChallenge("example.com");
      globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("non_200");
      expect(result.status).toBe(404);
    });

    it("respects DOMAIN_VERIFY_SKIP for test fixtures", async () => {
      // localhost is normally blocked; with skip-list it's allowed (this is the
      // test-fixture path operators use to validate the flow without exposing
      // their probe to the public internet).
      const env = makeEnv({ DOMAIN_VERIFY_SKIP: "localhost" });
      const challenge: DomainChallenge = {
        ...fakeChallenge("localhost"),
        expected_url: "https://localhost/.well-known/unbrowse-verify-test123",
      };
      globalThis.fetch = (async () => new Response(challenge.body, { status: 200 })) as typeof fetch;
      const result = await probeDomain(env, challenge);
      expect(result.ok).toBe(true);
    });
  });
});
