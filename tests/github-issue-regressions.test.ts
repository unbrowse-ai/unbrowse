import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { executeSkill } from "../src/execution/index.js";
import { extractAuthHeaders, extractEndpoints } from "../src/reverse-engineer/index.js";
import { deleteCredential, storeCredential } from "../src/vault/index.js";
import { annotateEndpointPolicy, detectSessionBoundParams } from "../src/site-policy.js";
import { hasUsableEndpoints } from "../src/orchestrator/index.js";
import { isSameBrandDomain } from "../src/domain.js";
import type { RawRequest } from "../src/capture/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const servers = new Set<ReturnType<typeof createServer>>();
const cleanupVaultKeys = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) =>
      new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
    ),
  );
  servers.clear();

  for (const key of cleanupVaultKeys) {
    await deleteCredential(key).catch(() => {});
  }
  cleanupVaultKeys.clear();
});

function makeRequest(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.abc",
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ data: { elements: [{ id: "post-1" }] } }),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function startHeaderEchoServer(): Promise<{
  baseUrl: string;
  lastHeaders: () => Record<string, string | string[] | undefined> | null;
}> {
  let lastHeaders: Record<string, string | string[] | undefined> | null = null;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    lastHeaders = _req.headers;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lastHeaders: () => lastHeaders,
  };
}

describe("GitHub issue regressions", () => {
  it("#69 keeps the checked-in Kuri HAR ownership fix in the submodule", () => {
    const bridgePath = `${process.cwd()}/submodules/kuri/src/bridge/bridge.zig`;
    const launcherPath = `${process.cwd()}/submodules/kuri/src/chrome/launcher.zig`;

    expect(existsSync(bridgePath)).toBe(true);
    expect(existsSync(launcherPath)).toBe(true);

    const bridge = readFileSync(bridgePath, "utf-8");
    const launcher = readFileSync(launcherPath, "utf-8");

    expect(bridge).toContain("const owned_key = self.allocator.dupe(u8, tab_id)");
    expect(bridge).toContain("self.har_recorders.put(owned_key, rec)");
    expect(launcher).toContain("--remote-allow-origins=*");
  });

  it("#70 infers LinkedIn csrf replay and captures replay-critical headers", () => {
    const requests = [
      makeRequest({
        request_headers: {
          accept: "application/vnd.linkedin.normalized+json+2.1",
          cookie: 'li_at=token-1; JSESSIONID="ajax:123"',
          "csrf-token": "ajax:123",
          "x-li-track": "{\"clientVersion\":\"1.0.0\"}",
          "x-restli-protocol-version": "2.0.0",
        },
      }),
    ];

    const endpoints = extractEndpoints(requests, undefined, {
      pageUrl: "https://www.linkedin.com/feed/",
      intent: "get feed posts",
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.csrf_plan).toEqual({
      source: "cookie",
      param_name: "csrf-token",
      refresh_on_401: true,
      extractor_sequence: ["JSESSIONID"],
    });

    expect(extractAuthHeaders(requests)).toEqual({
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "csrf-token": "ajax:123",
      "x-li-track": "{\"clientVersion\":\"1.0.0\"}",
      "x-restli-protocol-version": "2.0.0",
    });
  });

  it("#70 replays stored LinkedIn session headers even after publish strips header values", async () => {
    const { baseUrl, lastHeaders } = await startHeaderEchoServer();
    const authKey = "linkedin.com-session";
    cleanupVaultKeys.add(authKey);

    await storeCredential(authKey, JSON.stringify({
      headers: {
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "csrf-token": "stale-token",
        "x-li-track": "{\"clientVersion\":\"1.0.0\"}",
        "x-restli-protocol-version": "2.0.0",
      },
      cookies: [
        { name: "JSESSIONID", value: '"ajax:fresh"', domain: ".linkedin.com" },
        { name: "li_at", value: "token-1", domain: ".linkedin.com" },
      ],
    }));

    const endpoint: EndpointDescriptor = {
      endpoint_id: "linkedin-feed",
      method: "GET",
      url_template: `${baseUrl}/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.abc`,
      headers_template: {
        accept: "",
        "csrf-token": "",
        "x-li-track": "",
        "x-restli-protocol-version": "",
      },
      csrf_plan: {
        source: "cookie",
        param_name: "csrf-token",
        refresh_on_401: true,
        extractor_sequence: ["JSESSIONID"],
      },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 1,
      description: "LinkedIn feed",
    };
    const skill: SkillManifest = {
      skill_id: "skill-linkedin-feed",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: "linkedin.com",
      intent_signature: "get feed posts",
      domain: "www.linkedin.com",
      description: "LinkedIn feed skill",
      owner_type: "agent",
      auth_profile_ref: authKey,
      endpoints: [endpoint],
    };

    const out = await executeSkill(skill, {}, { raw: true }, {
      intent: "get feed posts",
      contextUrl: "https://www.linkedin.com/feed/",
    });

    expect(out.trace.success).toBe(true);
    expect(lastHeaders()?.accept).toBe("application/vnd.linkedin.normalized+json+2.1");
    expect(lastHeaders()?.["csrf-token"]).toBe("ajax:fresh");
    expect(lastHeaders()?.["x-li-track"]).toBe("{\"clientVersion\":\"1.0.0\"}");
    expect(lastHeaders()?.["x-restli-protocol-version"]).toBe("2.0.0");
    expect(lastHeaders()?.cookie).toBe("JSESSIONID=ajax:fresh; li_at=token-1");
  });

  it("#71 guards HAR entries with missing header arrays", () => {
    const source = readFileSync(`${process.cwd()}/src/capture/index.ts`, "utf-8");
    expect(source.match(/for\s*\(\s*const\s+\w+\s+of\s+entry\.request\.headers\s*\)/g)).toBeNull();
    expect(source.match(/for\s*\(\s*const\s+\w+\s+of\s+entry\.response\.headers\s*\)/g)).toBeNull();
  });

  it("#402 detects TikTok session-bound fingerprint params and marks endpoint as requires_live_session", () => {
    const tiktokEndpoint: EndpointDescriptor = {
      endpoint_id: "tiktok-item-list",
      method: "GET",
      url_template: "https://www.tiktok.com/api/post/item_list/",
      query: {
        // TikTok fingerprint/session-bound params
        device_id: "7123456789012345678",
        WebIdLastTime: "1712345678",
        browser_version: "133.0.0.0",
        // Normal params
        secUid: "MS4wLjABAAAA",
        count: "35",
        cursor: "0",
      },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    };

    // detectSessionBoundParams should identify the fingerprint params
    const sessionBound = detectSessionBoundParams(tiktokEndpoint);
    expect(sessionBound.length).toBeGreaterThan(0);
    expect(sessionBound).toContain("device_id");
    expect(sessionBound).toContain("WebIdLastTime");
    expect(sessionBound).toContain("browser_version");
    // Normal query params should NOT be flagged
    expect(sessionBound).not.toContain("secUid");
    expect(sessionBound).not.toContain("count");
    expect(sessionBound).not.toContain("cursor");

    // annotateEndpointPolicy should set requires_live_session on the endpoint
    const annotated = annotateEndpointPolicy(tiktokEndpoint);
    expect(annotated.policy?.requires_live_session).toBe(true);
    expect(annotated.policy?.session_bound_params).toEqual(expect.arrayContaining(["device_id", "WebIdLastTime", "browser_version"]));
  });

  it("#402 execute returns browser_replay_only error with next_step when TikTok session-bound params cause empty response", async () => {
    // Simulate TikTok's behavior: HTTP 200 but empty itemList array because fingerprint params are stale
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("content-type", "application/json");
      // TikTok returns 200 with empty itemList when fingerprint params are stale
      res.end(JSON.stringify({ itemList: [], statusCode: 0, hasMore: false }));
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const endpoint: EndpointDescriptor = {
      endpoint_id: "tiktok-item-list",
      method: "GET",
      url_template: `http://127.0.0.1:${port}/api/post/item_list/`,
      query: {
        device_id: "7123456789012345678",
        WebIdLastTime: "1712345678",
        browser_version: "133.0.0.0",
        secUid: "MS4wLjABAAAA",
        count: "35",
        cursor: "0",
      },
      policy: {
        requires_third_party_terms_confirmation: false,
        policy_domain: "tiktok.com",
        reason: "TikTok API requires a live browser session for session-bound fingerprint parameters.",
        requires_live_session: true,
        session_bound_params: ["device_id", "WebIdLastTime", "browser_version"],
      },
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    };

    const skill: SkillManifest = {
      skill_id: "skill-tiktok-profile",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: "tiktok.com",
      intent_signature: "get profile videos",
      domain: "www.tiktok.com",
      description: "TikTok profile videos",
      owner_type: "agent",
      endpoints: [endpoint],
    };

    const out = await executeSkill(skill, {}, undefined, { intent: "get profile videos" });

    // Should NOT succeed — empty result is detected as session-bound failure
    expect(out.trace.success).toBe(false);
    // Error must indicate browser_replay_only, not generic intent_mismatch
    expect(out.trace.error).toBe("browser_replay_only");
    // Result must tell the agent how to proceed
    const result = out.result as Record<string, unknown>;
    expect(result.error).toBe("browser_replay_only");
    expect(typeof result.next_step).toBe("string");
    expect(result.next_step as string).toContain("go");
  });

  it("#410 hasUsableEndpoints accepts geo-redirect endpoints (airbnb.com.sg for airbnb.com skill)", () => {
    // Skill captured under airbnb.com domain, but endpoints redirected to airbnb.com.sg
    const geoEndpoint: EndpointDescriptor = {
      endpoint_id: "airbnb-search",
      method: "POST",
      url_template: "https://www.airbnb.com.sg/api/v3/ExploreSearch",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    };
    const skill: SkillManifest = {
      skill_id: "skill-airbnb",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: "airbnb.com",
      intent_signature: "search homes",
      domain: "www.airbnb.com",
      description: "Airbnb search",
      owner_type: "agent",
      endpoints: [geoEndpoint],
    };
    // Before fix: hasUsableEndpoints returns false because airbnb.com.sg != airbnb.com
    // After fix: should return true — same brand, geo-variant TLD
    expect(hasUsableEndpoints(skill)).toBe(true);
  });

  it("#410 isSameBrandDomain handles geo-variant TLDs", () => {
    // Same brand, different geo TLDs
    expect(isSameBrandDomain("www.airbnb.com.sg", "www.airbnb.com")).toBe(true);
    expect(isSameBrandDomain("www.airbnb.com.au", "airbnb.com")).toBe(true);
    expect(isSameBrandDomain("agoda.com.sg", "agoda.com")).toBe(true);
    expect(isSameBrandDomain("booking.com.sg", "booking.com")).toBe(true);
    // Different brands must not match
    expect(isSameBrandDomain("airbnb.com", "booking.com")).toBe(false);
    expect(isSameBrandDomain("airbnb.com.sg", "booking.com")).toBe(false);
    // Subdomains of the same brand still match
    expect(isSameBrandDomain("api.airbnb.com", "airbnb.com")).toBe(true);
  });
});

// Issue #408: Kuri CDP response buffer too small for large eval results (8KB limit)
describe("issue #408 — Kuri eval buffer size", () => {
  it("Kuri HTTP read buffer is at least 64KB (was 8KB, caused CDP command failed on large evals)", () => {
    const routerPath = path.resolve(
      import.meta.dir,
      "../submodules/kuri/src/server/router.zig",
    );
    if (!existsSync(routerPath)) {
      // Submodule not initialized in this env — skip
      return;
    }
    const source = readFileSync(routerPath, "utf8");
    // The read_buf must be at least 64KB to handle large eval results
    // Before fix: [8192]u8 (8KB) — caused "CDP command failed" on responses > 8KB
    // After fix: [65536]u8 (64KB)
    const match = source.match(/var read_buf:\s*\[(\d+)\]u8/);
    expect(match).not.toBeNull();
    const bufSize = parseInt(match![1], 10);
    expect(bufSize).toBeGreaterThanOrEqual(65536);
  });

  it("/evaluate handler reads expression from POST body (for expressions > URL length limits)", () => {
    const routerPath = path.resolve(
      import.meta.dir,
      "../submodules/kuri/src/server/router.zig",
    );
    if (!existsSync(routerPath)) {
      return;
    }
    const source = readFileSync(routerPath, "utf8");
    // The /evaluate handler must support POST body for large expressions.
    // Before fix: only read from ?expression= query param — failed for ~7.5KB interceptor scripts.
    // After fix: reads POST body first, falls back to query param.
    expect(source).toContain("readRequestBody(request, arena)");
    // handleEvaluate should contain the POST body read path
    const evaluateFnStart = source.indexOf("fn handleEvaluate(");
    const evaluateFnEnd = source.indexOf("\nfn ", evaluateFnStart + 1);
    const evaluateFn = source.slice(evaluateFnStart, evaluateFnEnd);
    expect(evaluateFn).toContain("readRequestBody");
  });
});

// Issue #408: Kuri CDP response buffer too small for large eval results (8KB limit)
describe("issue #408 — Kuri eval buffer size", () => {
  it("Kuri HTTP read buffer is at least 64KB (was 8KB, caused CDP command failed on large evals)", () => {
    const routerPath = path.resolve(
      import.meta.dir,
      "../submodules/kuri/src/server/router.zig",
    );
    if (!existsSync(routerPath)) {
      // Submodule not initialized in this env — skip
      return;
    }
    const source = readFileSync(routerPath, "utf8");
    // The read_buf must be at least 64KB to handle large eval results
    // Before fix: [8192]u8 (8KB) — caused "CDP command failed" on responses > 8KB
    // After fix: [65536]u8 (64KB)
    const match = source.match(/var read_buf:\s*\[(\d+)\]u8/);
    expect(match).not.toBeNull();
    const bufSize = parseInt(match![1], 10);
    expect(bufSize).toBeGreaterThanOrEqual(65536);
  });

  it("/evaluate handler reads expression from POST body (for expressions > URL length limits)", () => {
    const routerPath = path.resolve(
      import.meta.dir,
      "../submodules/kuri/src/server/router.zig",
    );
    if (!existsSync(routerPath)) {
      return;
    }
    const source = readFileSync(routerPath, "utf8");
    // The /evaluate handler must support POST body for large expressions.
    // Before fix: only read from ?expression= query param — failed for ~7.5KB interceptor scripts.
    // After fix: reads POST body first, falls back to query param.
    expect(source).toContain("readRequestBody(request, arena)");
    // handleEvaluate should contain the POST body read path
    const evaluateFnStart = source.indexOf("fn handleEvaluate(");
    const evaluateFnEnd = source.indexOf("\nfn ", evaluateFnStart + 1);
    const evaluateFn = source.slice(evaluateFnStart, evaluateFnEnd);
    expect(evaluateFn).toContain("readRequestBody");
  });
});
