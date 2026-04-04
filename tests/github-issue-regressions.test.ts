import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { executeSkill } from "../src/execution/index.js";
import { extractAuthHeaders, extractEndpoints } from "../src/reverse-engineer/index.js";
import { deleteCredential, storeCredential } from "../src/vault/index.js";
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
});
