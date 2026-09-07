// indexContributorAuth — the bearer-OPTIONAL contribution-write middleware.
// Wallet auth is the real auth; the API key is just the web2 wrapper. With no key
// the request must NOT 401 — it attributes the contribution to the global index
// wallet so the index always grows (the fix for the silent skills:0 publish failure).
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { indexContributorAuth, GLOBAL_INDEX_AGENT_ID } from "../src/middleware/auth.js";

function makeApp() {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/x", indexContributorAuth as any);
  app.get("/x", (c) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.json({ agent_id: (c as any).get("agent_id"), anon: (c as any).get("anon_index_contribution") ?? false }),
  );
  return app;
}

async function call(env: Record<string, unknown>): Promise<{ status: number; body: { agent_id?: string; anon?: boolean } }> {
  const res = await makeApp().request("/x", {}, env as never);
  return { status: res.status, body: await res.json() };
}

describe("indexContributorAuth — bearer optional, wallet-less → global index", () => {
  it("never 401s on a missing key (the silent-publish-failure bug)", async () => {
    const { status } = await call({ PAYMENT_RECIPIENT: "W" });
    expect(status).toBe(200);
  });

  it("no key → attributes to the infra-fee wallet (PAYMENT_RECIPIENT) + flags anon", async () => {
    const { body } = await call({ PAYMENT_RECIPIENT: "FEE_WALLET" });
    expect(body.agent_id).toBe("FEE_WALLET");
    expect(body.anon).toBe(true);
  });

  it("no key → explicit UNBROWSE_GLOBAL_INDEX_WALLET wins over PAYMENT_RECIPIENT", async () => {
    const { body } = await call({ UNBROWSE_GLOBAL_INDEX_WALLET: "GIDX", PAYMENT_RECIPIENT: "FEE_WALLET" });
    expect(body.agent_id).toBe("GIDX");
  });

  it("no key + no wallet env → sentinel, contribution still lands (not lost)", async () => {
    const { body } = await call({});
    expect(body.agent_id).toBe(GLOBAL_INDEX_AGENT_ID);
    expect(body.anon).toBe(true);
  });
});
