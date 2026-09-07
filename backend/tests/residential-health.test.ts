/**
 * GET /v1/proxy residential_configured must match the runtime gate used by
 * fetchViaIproyal (MINI_EGRESS_URL + EGRESS_SECRET). IPROYAL_USER alone is a
 * false positive — residential mode throws without mini-egress.
 */
import { describe, expect, it } from "bun:test";
import { isResidentialConfigured } from "../src/routes/proxy.js";

describe("isResidentialConfigured — residential health truth", () => {
  it("false when nothing is set", () => {
    expect(isResidentialConfigured({})).toBe(false);
  });

  it("false when only IPROYAL_USER is set (legacy false-positive)", () => {
    expect(isResidentialConfigured({ IPROYAL_USER: "pool-user" })).toBe(false);
  });

  it("false when MINI_EGRESS_URL set but EGRESS_SECRET missing", () => {
    expect(isResidentialConfigured({ MINI_EGRESS_URL: "https://egress.example/fetch" })).toBe(false);
  });

  it("false when EGRESS_SECRET set but MINI_EGRESS_URL missing", () => {
    expect(isResidentialConfigured({ EGRESS_SECRET: "s" })).toBe(false);
  });

  it("false on blank/whitespace values", () => {
    expect(isResidentialConfigured({ MINI_EGRESS_URL: "  ", EGRESS_SECRET: "s" })).toBe(false);
    expect(isResidentialConfigured({ MINI_EGRESS_URL: "https://egress.example", EGRESS_SECRET: "" })).toBe(false);
  });

  it("true when mini-egress URL + secret are both non-empty (runtime path armed)", () => {
    expect(
      isResidentialConfigured({
        MINI_EGRESS_URL: "https://egress.example/fetch",
        EGRESS_SECRET: "shared-secret",
      }),
    ).toBe(true);
  });
});
