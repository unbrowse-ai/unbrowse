import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

const originalPassword = process.env.INTERNAL_AUTH_PASSWORD;

beforeEach(() => {
  process.env.INTERNAL_AUTH_PASSWORD = "internal-test";
});

afterEach(() => {
  if (originalPassword === undefined) delete process.env.INTERNAL_AUTH_PASSWORD;
  else process.env.INTERNAL_AUTH_PASSWORD = originalPassword;
});

function run(path: string, password?: string) {
  const headers = password ? { Authorization: `Basic ${btoa(`operator:${password}`)}` } : undefined;
  return middleware(new NextRequest(`https://www.unbrowse.ai${path}`, { headers }));
}

describe("internal dashboard middleware", () => {
  test("fails closed with private response headers", () => {
    const response = run("/internal");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
  });

  test("protects dashboard subpaths and marks authorized responses private", () => {
    expect(run("/internal/api", "wrong").status).toBe(401);
    const response = run("/internal/api", "internal-test");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("does not gate the public internal-APIs article", () => {
    expect(run("/internal-apis-are-all-you-need").status).toBe(200);
  });
});
