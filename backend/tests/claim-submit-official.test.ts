import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import {
  buildSubmissionIndexKey,
  buildSubmissionKey,
  promoteOfficialSubmission,
  type OfficialSkillSubmission,
} from "../src/services/official-submissions.js";

// End-to-end tests for /v1/claim/submit-official + /v1/claim/submissions +
// promoteOfficialSubmission. Real Hono app, real KV abstraction backed by an
// in-memory Map via the EmergentDB stub. No mocks of business code, no
// regex-asserted plain English.
//
// staging environment makes bearerAuth accept any bearer token (POST tests
// that exercise the gated routes can still send one if needed). The
// submit-official route is intentionally not bearer-gated, so most tests
// here go anonymous.

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/qdkv/list") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string };
        const prefix = body.prefix ?? "";
        const items = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ items });
      }
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function postJson(path: string, body: unknown, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
}

async function getJson(path: string): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`), baseEnv);
}

const VALID_BODY = {
  domain: "example.com",
  contact_email: "owner@example.com",
  contact_name: "Owner Person",
  description: "Canonical example.com API",
  endpoints: [
    {
      method: "GET",
      url_template: "https://api.example.com/v1/users/{id}",
      description: "Fetch a user by id",
      x402_supported: true,
      x402_envelope: { price_usd_micros: 1000, recipient_atom: "atom1" },
    },
  ],
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("POST /v1/claim/submit-official", () => {
  // -------------------------------------------------------------------------
  // 1. Golden path: valid body -> 200, KV row exists with status pending.
  // -------------------------------------------------------------------------
  it("1. valid body returns 200 with submission_id; KV row exists", async () => {
    const res = await postJson("/v1/claim/submit-official", VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      submission_id: string;
      status: string;
      message: string;
    };
    expect(body.status).toBe("pending");
    expect(typeof body.submission_id).toBe("string");
    expect(body.submission_id.length).toBeGreaterThan(0);
    expect(body.message).toContain("owner@example.com");

    // The submission row must be in KV under the submissionId key.
    const rawSubmission = kvStore.get(`skills-v3:${buildSubmissionKey(body.submission_id)}`)
      ?? kvStore.get(`staging-skills-v3:${buildSubmissionKey(body.submission_id)}`)
      ?? kvStore.get(`skills-v2:${buildSubmissionKey(body.submission_id)}`)
      // fallback: scan for any key ending in :official-submission:<id>
      ?? [...kvStore.entries()].find(([k]) => k.endsWith(`:${buildSubmissionKey(body.submission_id)}`))?.[1];
    expect(rawSubmission).toBeDefined();
    const stored = JSON.parse(rawSubmission as string) as OfficialSkillSubmission;
    expect(stored.domain).toBe("example.com");
    expect(stored.contact_email).toBe("owner@example.com");
    expect(stored.endpoints.length).toBe(1);
    expect(stored.endpoints[0].method).toBe("GET");
    expect(stored.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // 2. GET /v1/claim/submissions returns the just-submitted row without leaking
  //    contact_email.
  // -------------------------------------------------------------------------
  it("2. GET /claim/submissions returns submission summary, never leaks contact_email", async () => {
    const postRes = await postJson("/v1/claim/submit-official", VALID_BODY);
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { submission_id: string };

    const listRes = await getJson("/v1/claim/submissions?domain=example.com");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      submissions: Array<{
        submission_id: string;
        status: string;
        submitted_at: string;
        endpoint_count: number;
      }>;
    };
    expect(list.submissions.length).toBe(1);
    expect(list.submissions[0].submission_id).toBe(postBody.submission_id);
    expect(list.submissions[0].status).toBe("pending");
    expect(list.submissions[0].endpoint_count).toBe(1);
    // The serialized JSON must never include contact_email; pin that as a
    // structural assertion against the raw response text, not the parsed
    // object, so a future "leak via top-level key" change fails the test.
    const rawText = JSON.stringify(list);
    expect(rawText).not.toContain("owner@example.com");
    expect(rawText).not.toContain("contact_email");
  });

  // -------------------------------------------------------------------------
  // 3. promoteOfficialSubmission("approve") writes the endpoints into the
  //    marketplace skill with owner_submitted: true + verified.
  // -------------------------------------------------------------------------
  it("3. promoteOfficialSubmission(approve) lands owner_submitted+verified endpoint in skill", async () => {
    const postRes = await postJson("/v1/claim/submit-official", VALID_BODY);
    expect(postRes.status).toBe(200);
    const { submission_id } = (await postRes.json()) as { submission_id: string };

    const result = await promoteOfficialSubmission(baseEnv, submission_id, "approve");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("approved");
    expect(result.promoted_endpoints).toBe(1);
    expect(typeof result.skill_id).toBe("string");

    // The freshly-minted skill must be in the KV store under skill:<id>.
    const skillKvKey = `skill:${result.skill_id}`;
    const skillRaw = [...kvStore.entries()].find(([k]) => k.endsWith(`:${skillKvKey}`))?.[1];
    expect(skillRaw).toBeDefined();
    const skill = JSON.parse(skillRaw as string) as SkillManifest;
    expect(skill.domain).toBe("example.com");
    expect(skill.endpoints.length).toBe(1);
    expect(skill.endpoints[0].owner_submitted).toBe(true);
    expect(skill.endpoints[0].verification_status).toBe("verified");
    expect(skill.endpoints[0].method).toBe("GET");
    expect(skill.endpoints[0].url_template).toBe(
      "https://api.example.com/v1/users/{id}",
    );

    // And the submission record must now be marked approved.
    const submissionRaw = [...kvStore.entries()].find(([k]) =>
      k.endsWith(`:${buildSubmissionKey(submission_id)}`),
    )?.[1];
    expect(submissionRaw).toBeDefined();
    const stored = JSON.parse(submissionRaw as string) as OfficialSkillSubmission;
    expect(stored.status).toBe("approved");
  });

  // -------------------------------------------------------------------------
  // 4. Missing contact_email -> 400 invalid_email.
  // -------------------------------------------------------------------------
  it("4. missing contact_email returns 400 invalid_email", async () => {
    const res = await postJson("/v1/claim/submit-official", {
      ...VALID_BODY,
      contact_email: undefined,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_email");
  });

  // -------------------------------------------------------------------------
  // 5. Empty endpoints array -> 400 endpoints_required.
  // -------------------------------------------------------------------------
  it("5. empty endpoints array returns 400 endpoints_required", async () => {
    const res = await postJson("/v1/claim/submit-official", {
      ...VALID_BODY,
      endpoints: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("endpoints_required");
  });

  // -------------------------------------------------------------------------
  // 6. Adversarial: rate-limit at 5/24h returns 429 on the 6th rapid submission.
  // -------------------------------------------------------------------------
  it("6. 6 rapid submissions for the same domain: 6th returns 429 rate_limited", async () => {
    const responses = [];
    for (let i = 0; i < 6; i++) {
      const res = await postJson("/v1/claim/submit-official", VALID_BODY);
      responses.push(res.status);
    }
    expect(responses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(responses[5]).toBe(429);

    // Confirm the index shows exactly 5 stored submissions for this domain.
    const indexRaw = [...kvStore.entries()].find(([k]) =>
      k.endsWith(`:${buildSubmissionIndexKey("example.com")}`),
    )?.[1];
    expect(indexRaw).toBeDefined();
    const ids = JSON.parse(indexRaw as string) as string[];
    expect(ids.length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 7. Invalid domain -> 400 invalid_domain (mirrors the existing /claim/*
  //    surface; pinned here so the route's first gate is uniform).
  // -------------------------------------------------------------------------
  it("7. subdomain hint returns 400 invalid_domain", async () => {
    const res = await postJson("/v1/claim/submit-official", {
      ...VALID_BODY,
      domain: "www.example.com",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_domain");
  });
});
