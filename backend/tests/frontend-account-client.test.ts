import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchMe,
  fetchKeys,
  fetchSkills,
  fetchPreferences,
  patchPreferences,
  AccountClientError,
} from "../../frontend/src/lib/account-client";
import { getConfiguredApiOrigin } from "../../frontend/src/lib/api-base";

type FetchCall = { url: string; init?: RequestInit };

const ORIGINAL_FETCH = globalThis.fetch;

function installFetchStub(
  responder: () => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  // @ts-expect-error overriding global fetch with a stub
  globalThis.fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : (url as Request).url;
    calls.push({ url: urlStr, init });
    return await responder();
  };
  return { calls };
}

function mockOkJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockErr(status: number, statusText: string, bodyText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  } as unknown as Response;
}

function authHeader(init?: RequestInit): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  return h["Authorization"] ?? h["authorization"];
}

function contentTypeHeader(init?: RequestInit): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  return h["Content-Type"] ?? h["content-type"];
}

describe("frontend account-client", () => {
  let origin: string;

  beforeEach(() => {
    origin = getConfiguredApiOrigin();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("fetchMe: GET /v1/account/me with bearer auth", async () => {
    const { calls } = installFetchStub(() => mockOkJson({ ok: true }));
    await fetchMe("test-key");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${origin}/v1/account/me`);
    const method = calls[0]!.init?.method;
    expect(method === undefined || method === "GET").toBe(true);
    expect(authHeader(calls[0]!.init)).toBe("Bearer test-key");
  });

  test("fetchKeys: GET /v1/account/keys with bearer auth", async () => {
    const { calls } = installFetchStub(() => mockOkJson([]));
    await fetchKeys("test-key");
    expect(calls[0]!.url).toBe(`${origin}/v1/account/keys`);
    const method = calls[0]!.init?.method;
    expect(method === undefined || method === "GET").toBe(true);
    expect(authHeader(calls[0]!.init)).toBe("Bearer test-key");
  });

  test("fetchSkills: GET /v1/account/skills with bearer auth", async () => {
    const { calls } = installFetchStub(() => mockOkJson([]));
    await fetchSkills("test-key");
    expect(calls[0]!.url).toBe(`${origin}/v1/account/skills`);
    const method = calls[0]!.init?.method;
    expect(method === undefined || method === "GET").toBe(true);
    expect(authHeader(calls[0]!.init)).toBe("Bearer test-key");
  });

  test("fetchPreferences: GET /v1/account/preferences with bearer auth", async () => {
    const { calls } = installFetchStub(() =>
      mockOkJson({ share_pointers: false }),
    );
    await fetchPreferences("test-key");
    expect(calls[0]!.url).toBe(`${origin}/v1/account/preferences`);
    const method = calls[0]!.init?.method;
    expect(method === undefined || method === "GET").toBe(true);
    expect(authHeader(calls[0]!.init)).toBe("Bearer test-key");
  });

  test("patchPreferences: PATCH /v1/account/preferences with JSON body", async () => {
    const { calls } = installFetchStub(() =>
      mockOkJson({ share_pointers: true }),
    );
    await patchPreferences("test-key", { share_pointers: true });
    expect(calls[0]!.url).toBe(`${origin}/v1/account/preferences`);
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(contentTypeHeader(calls[0]!.init)).toBe("application/json");
    expect(authHeader(calls[0]!.init)).toBe("Bearer test-key");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ share_pointers: true }));
  });

  test("non-2xx throws Error with status code and body in message", async () => {
    installFetchStub(() =>
      mockErr(403, "Forbidden", '{"error":"account_required"}'),
    );
    let thrown: unknown = null;
    try {
      await fetchMe("k");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain("account_required");
    expect((thrown as AccountClientError).status).toBe(403);
  });

  test("2xx returns parsed JSON exactly", async () => {
    const payload = {
      user_id: "u1",
      email: "a@b.com",
      created_at: "2026-01-01",
      verified_at: null,
      keys_count: 1,
      skills_count: 0,
    };
    installFetchStub(() => mockOkJson(payload));
    const got = await fetchMe("k");
    expect(got).toEqual(payload);
  });

  test("fetchKeys: empty array returns []", async () => {
    installFetchStub(() => mockOkJson({ keys: [] }));
    // The client returns whatever JSON shape the server sends; verify the
    // empty-case doesn't crash and returns the parsed object/array.
    const got = await fetchKeys("k");
    expect(got).toEqual([]);
  });

  test("fetchSkills: empty array returns []", async () => {
    installFetchStub(() => mockOkJson([]));
    const got = await fetchSkills("k");
    expect(got).toEqual([]);
  });

  test("500 server error throws AccountClientError with status=500", async () => {
    installFetchStub(() => mockErr(500, "Internal Server Error", "boom"));
    let thrown: unknown = null;
    try {
      await fetchMe("k");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AccountClientError);
    expect((thrown as AccountClientError).status).toBe(500);
  });

  test("malformed (non-JSON) error body still throws with status=403, does not crash on JSON.parse", async () => {
    // Override mockErr's auto-JSON-parse path by returning a Response whose
    // text() is HTML. The client must read body via text(), not json().
    installFetchStub(
      () =>
        ({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          text: async () => "not-json-just-html-<html>",
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON");
          },
        }) as unknown as Response,
    );
    let thrown: unknown = null;
    try {
      await fetchMe("k");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as AccountClientError).status).toBe(403);
  });

  test("2xx with malformed JSON body throws (does not silently return undefined)", async () => {
    installFetchStub(
      () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "garbage",
          json: async () => {
            throw new SyntaxError("bad json");
          },
        }) as unknown as Response,
    );
    let thrown: unknown = null;
    try {
      await fetchMe("k");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("patchPreferences: round-trip returns parsed body, sends PATCH + JSON body", async () => {
    const { calls } = installFetchStub(() =>
      mockOkJson({ share_pointers: true }),
    );
    const got = await patchPreferences("k", { share_pointers: true });
    expect(got).toEqual({ share_pointers: true });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ share_pointers: true }));
  });
});
