import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  decideMutationPolicy,
  getMutationPolicySettings,
  updateMutationPolicySettings,
} from "../src/settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-mutation-policy-"));
  process.env.UNBROWSE_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("mutation policy", () => {
  it("defaults to asking before an unwhitelisted mutation", () => {
    expect(getMutationPolicySettings()).toEqual({ mode: "ask", whitelist: [] });
    expect(decideMutationPolicy("POST", "https://example.com/items")).toMatchObject({
      allowed: false,
      mode: "ask",
      reason: "mutation_confirmation_required",
    });
  });

  it("allows only matching whitelist patterns without a prompt", () => {
    updateMutationPolicySettings({ mode: "whitelist", whitelist: ["POST https://example.com/items/*"] });
    expect(decideMutationPolicy("POST", "https://example.com/items/123").allowed).toBe(true);
    expect(decideMutationPolicy("DELETE", "https://example.com/items/123").allowed).toBe(false);
  });

  it("permits a one-time confirmed mutation in ask mode", () => {
    expect(decideMutationPolicy("PATCH", "https://example.com/items/123", true)).toMatchObject({
      allowed: true,
      mode: "confirmed",
    });
  });

  it("deny mode remains closed even when the agent asks", () => {
    updateMutationPolicySettings({ mode: "deny" });
    expect(decideMutationPolicy("DELETE", "https://example.com/items/123", true).allowed).toBe(false);
  });
});
