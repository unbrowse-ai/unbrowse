/**
 * GATE: auth ripped from another browser is written in the ONE shape obscura's
 * cookie loader accepts.
 *
 * This encodes a real, verified lesson: obscura's on-disk jar is camelCase
 * (`httpOnly`, `sameSite`) with SameSite title-cased to {Strict,None,Lax}. A
 * snake_case key is silently dropped by the loader, so the injected cookie never
 * reaches the server — a green-looking no-op. These assertions fail closed if
 * anyone reverts the mapping.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCookie } from "../src/auth/browser-cookies.js";
import {
  normalizeSameSite,
  normalizeExpires,
  toObscuraCookies,
  writeObscuraJar,
} from "../src/auth/obscura-jar.js";

function cookie(over: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: "sid",
    value: "abc",
    domain: "example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
    ...over,
  };
}

describe("normalizeSameSite", () => {
  test("maps every spelling into obscura's set", () => {
    expect(normalizeSameSite("strict")).toBe("Strict");
    expect(normalizeSameSite("Strict")).toBe("Strict");
    expect(normalizeSameSite("none")).toBe("None");
    expect(normalizeSameSite("no_restriction")).toBe("None");
    expect(normalizeSameSite("lax")).toBe("Lax");
    expect(normalizeSameSite("unspecified")).toBe("Lax");
    expect(normalizeSameSite("")).toBe("Lax");
    expect(normalizeSameSite(undefined)).toBe("Lax");
  });
});

describe("normalizeExpires", () => {
  test("non-positive => session cookie (null)", () => {
    expect(normalizeExpires(0)).toBeNull();
    expect(normalizeExpires(-1)).toBeNull();
    expect(normalizeExpires(undefined)).toBeNull();
  });
  test("epoch seconds preserved", () => {
    expect(normalizeExpires(1785854107)).toBe(1785854107);
  });
  test("millisecond expiries are divided down", () => {
    expect(normalizeExpires(1785854107000)).toBe(1785854107);
  });
});

describe("toObscuraCookies", () => {
  test("emits camelCase keys, never snake_case (the silent-drop bug)", () => {
    const [c] = toObscuraCookies([cookie()]);
    expect(Object.keys(c).sort()).toEqual(
      ["domain", "expires", "httpOnly", "name", "path", "sameSite", "secure", "value"],
    );
    // The exact keys obscura's loader ignores must NOT appear.
    expect(c).not.toHaveProperty("http_only");
    expect(c).not.toHaveProperty("same_site");
  });

  test("carries the auth fields through faithfully", () => {
    const [c] = toObscuraCookies([
      cookie({ name: "session", value: "tok9", domain: "app.io", secure: true, httpOnly: true, sameSite: "strict", expires: 1785854107 }),
    ]);
    expect(c).toEqual({
      name: "session",
      value: "tok9",
      domain: "app.io",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      expires: 1785854107,
    });
  });

  test("empty path defaults to /", () => {
    const [c] = toObscuraCookies([cookie({ path: "" })]);
    expect(c.path).toBe("/");
  });
});

describe("writeObscuraJar", () => {
  test("writes a 0600 cookies.json that parses back to camelCase entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "obscura-jar-"));
    const { cookiesFile, count, storageDir } = writeObscuraJar(dir, [
      cookie({ name: "ripped_session", value: "from_chrome", domain: "site.test" }),
    ]);
    expect(storageDir).toBe(dir);
    expect(count).toBe(1);
    const parsed = JSON.parse(readFileSync(cookiesFile, "utf8"));
    expect(parsed[0].name).toBe("ripped_session");
    expect(parsed[0]).toHaveProperty("httpOnly");
    expect(parsed[0]).toHaveProperty("sameSite");
    // 0600 — the jar carries live session tokens.
    const mode = statSync(cookiesFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
