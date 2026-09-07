/**
 * Witness: the OWS declarative policy engine — allowed_chains + expires_at, AND-combined,
 * deny vs warn. Matches the OWS v1.3 CLI policy semantics.
 */
import { test, expect } from "bun:test";
import { evaluatePolicy, type OwsPolicy, type PolicyContext, type WalletDescriptor } from "../src/payments/ows.js";

const wallet: WalletDescriptor = {
  id: "3198bc9c-0000-4000-8000-000000000000",
  name: "agent-treasury",
  createdAt: "2026-03-22T00:00:00Z",
  chainType: "multi",
  accounts: [{ accountId: "eip155:8453:0xab16", address: "0xab16", derivationPath: "m/44'/60'/0'/0/0", chainId: "eip155:8453" }],
  metadata: {},
};

const policy: OwsPolicy = {
  id: "agent-limits",
  name: "Base only, expires EOY",
  version: 1,
  rules: [
    { type: "allowed_chains", chain_ids: ["eip155:8453"] },
    { type: "expires_at", timestamp: "2026-12-31T23:59:59Z" },
  ],
  action: "deny",
};

function ctx(chainId: PolicyContext["chainId"], timestamp: string): PolicyContext {
  return { chainId, wallet, timestamp };
}

test("allows a request on an allowlisted chain before expiry", () => {
  expect(evaluatePolicy(policy, ctx("eip155:8453", "2026-06-01T00:00:00Z"))).toEqual({ allow: true });
});

test("denies a chain not in the allowlist", () => {
  const r = evaluatePolicy(policy, ctx("eip155:1", "2026-06-01T00:00:00Z"));
  expect(r.allow).toBe(false);
  expect(r.reason).toMatch(/eip155:1 not in allowlist/);
});

test("denies after the expiry timestamp (rules are AND-combined)", () => {
  const r = evaluatePolicy(policy, ctx("eip155:8453", "2027-01-01T00:00:00Z"));
  expect(r.allow).toBe(false);
  expect(r.reason).toMatch(/expired/);
});

test("a warn policy reports the reason but allows", () => {
  const warnPolicy: OwsPolicy = { ...policy, action: "warn" };
  const r = evaluatePolicy(warnPolicy, ctx("eip155:1", "2026-06-01T00:00:00Z"));
  expect(r.allow).toBe(true);
  expect(r.reason).toMatch(/not in allowlist/);
});
