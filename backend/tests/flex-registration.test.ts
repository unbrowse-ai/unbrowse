/**
 * Phase 0 — registration gate (P0.2 + P0.6).
 *
 * The /v1/agents/register endpoint must reject any request that doesn't carry
 * the full Flex onboarding triple: wallet_address + flex_escrow_address +
 * flex_session_key_address. The error body lists which fields are missing so
 * the CLI / /account UI can guide the user through the remaining steps.
 *
 * Local-admin dev mode (API_KEY === "local-test") bypasses the Flex gate
 * because the synthetic __admin__ profile has no real wallet/escrow/session
 * key — that path is tested separately in agents-register-local.test.ts.
 */

import { describe, expect, test } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

// Production-shaped env: API_KEY is anything other than "local-test" so the
// admin shortcut does NOT short-circuit the Flex gate.
const env: Env = {
  API_KEY: "production-key",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://local.test/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Phase 0 — registration gate", () => {
  test("rejects registration with only name + tos (no Flex fields)", async () => {
    const res = await app.fetch(makeRequest({
      name: "agent-1",
      tos_version: CURRENT_TOS_VERSION,
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; missing: string[]; remediation: string };
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(body.missing).toContain("wallet_address");
    expect(body.missing).toContain("flex_escrow_address");
    expect(body.missing).toContain("flex_session_key_address");
    expect(body.remediation).toContain("unbrowse setup");
  });

  test("rejects registration with wallet only (missing both Flex fields)", async () => {
    const res = await app.fetch(makeRequest({
      name: "agent-2",
      tos_version: CURRENT_TOS_VERSION,
      wallet_address: "WalletXXXXXXXXXXXXXX",
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; missing: string[] };
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(body.missing).toEqual(["flex_escrow_address", "flex_session_key_address"]);
  });

  test("rejects registration with wallet + escrow (missing session key)", async () => {
    const res = await app.fetch(makeRequest({
      name: "agent-3",
      tos_version: CURRENT_TOS_VERSION,
      wallet_address: "WalletXXXXXXXXXXXXXX",
      flex_escrow_address: "EscrowXXXXXXXXXXXXXXX",
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; missing: string[] };
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(body.missing).toEqual(["flex_session_key_address"]);
  });

  test("rejects empty-string Flex fields the same as missing", async () => {
    const res = await app.fetch(makeRequest({
      name: "agent-4",
      tos_version: CURRENT_TOS_VERSION,
      wallet_address: "WalletXXXXXXXXXXXXXX",
      flex_escrow_address: "   ", // whitespace-only counts as missing
      flex_session_key_address: "SessKeyXXXXXXXXXXXXXX",
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; missing: string[] };
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(body.missing).toEqual(["flex_escrow_address"]);
  });

  test("still rejects when ToS is missing (ToS check runs before Flex check)", async () => {
    const res = await app.fetch(makeRequest({
      name: "agent-5",
      wallet_address: "WalletXXXXXXXXXXXXXX",
      flex_escrow_address: "EscrowXXXXXXXXXXXXXXX",
      flex_session_key_address: "SessKeyXXXXXXXXXXXXXX",
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    // ToS is checked first — the Flex gate never fires.
    expect(body.error).toBe("tos_acceptance_required");
  });

  test("local-admin env (API_KEY=local-test) bypasses the Flex gate", async () => {
    const localEnv: Env = { ...env, API_KEY: "local-test" };
    const res = await app.fetch(makeRequest({
      name: "local-worker@example.com",
      tos_version: CURRENT_TOS_VERSION,
      // No Flex fields supplied; should still succeed because the admin path
      // short-circuits inside registerAgent → useLocalAdminRegistration.
    }), localEnv);
    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string; api_key: string };
    expect(body.agent_id).toBe("__admin__");
    expect(body.api_key).toBe("local-test");
  });
});
