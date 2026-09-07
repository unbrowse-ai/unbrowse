import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET } from "../src/app/internal/api/route";

const originalFetch = globalThis.fetch;
const originalPassword = process.env.INTERNAL_AUTH_PASSWORD;
const originalApi = process.env.NEXT_PUBLIC_API_URL;

function request(password?: string): Request {
  return new Request("http://frontend.test/internal/api?days=999", {
    headers: password ? { Authorization: `Basic ${btoa(`operator:${password}`)}` } : undefined,
  });
}

beforeEach(() => {
  process.env.INTERNAL_AUTH_PASSWORD = "internal-test";
  process.env.NEXT_PUBLIC_API_URL = "https://api.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPassword === undefined) delete process.env.INTERNAL_AUTH_PASSWORD;
  else process.env.INTERNAL_AUTH_PASSWORD = originalPassword;
  if (originalApi === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalApi;
});

describe("internal analytics same-origin bridge", () => {
  test("fails closed before calling the backend", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("wrong"))).status).toBe(401);
    expect(called).toBe(false);
  });

  test("caps the history window and keeps the backend token server-side", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.test/v1/analytics/internal?days=180");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer internal-test");
      return Response.json({ window_days: 180, activity: { total: 2 } });
    }) as typeof fetch;

    const response = await GET(request("internal-test"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ window_days: 180, activity: { total: 2 } });
  });
});
