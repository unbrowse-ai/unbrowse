import { describe, expect, it } from "bun:test";
import { isReservedDomain, matchedReservedDomain } from "../src/services/domain-reservations.js";
import type { Env } from "../src/types.js";

const env = {} as Env;

describe("domain-reservations", () => {
  it("flags seeded domains exactly", () => {
    expect(isReservedDomain(env, "stripe.com")).toBe(true);
    expect(isReservedDomain(env, "github.com")).toBe(true);
    expect(isReservedDomain(env, "unbrowse.ai")).toBe(true);
  });

  it("flags subdomains of reserved roots", () => {
    expect(isReservedDomain(env, "api.stripe.com")).toBe(true);
    expect(isReservedDomain(env, "dashboard.stripe.com")).toBe(true);
    expect(isReservedDomain(env, "raw.githubusercontent.com")).toBe(false); // different root
  });

  it("does not flag obvious user-published domains", () => {
    expect(isReservedDomain(env, "example.com")).toBe(false);
    expect(isReservedDomain(env, "shop.acme.io")).toBe(false);
  });

  it("normalizes input — case, www, trailing slash", () => {
    expect(isReservedDomain(env, "STRIPE.COM")).toBe(true);
    expect(isReservedDomain(env, "www.github.com")).toBe(true);
    expect(isReservedDomain(env, "https://stripe.com/")).toBe(true);
  });

  it("returns the matched suffix for telemetry / 403 detail", () => {
    expect(matchedReservedDomain(env, "api.stripe.com")).toBe("stripe.com");
    expect(matchedReservedDomain(env, "checkout.com")).toBe("checkout.com");
    expect(matchedReservedDomain(env, "example.com")).toBeNull();
  });

  it("respects RESERVED_DOMAINS env override", () => {
    const envWithExtra = { RESERVED_DOMAINS: "acme.io, foo.bar" } as unknown as Env;
    expect(isReservedDomain(envWithExtra, "acme.io")).toBe(true);
    expect(isReservedDomain(envWithExtra, "shop.acme.io")).toBe(true);
    expect(isReservedDomain(envWithExtra, "foo.bar")).toBe(true);
    // Seed list still works
    expect(isReservedDomain(envWithExtra, "stripe.com")).toBe(true);
  });

  it("handles empty / undefined input safely", () => {
    expect(isReservedDomain(env, "")).toBe(false);
    expect(isReservedDomain(env, null)).toBe(false);
    expect(isReservedDomain(env, undefined)).toBe(false);
  });
});
