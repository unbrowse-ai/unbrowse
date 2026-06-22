/**
 * contract-pay witness — per-agent RBAC + opt-in x402 compensation for GET/POST tasks.
 * Load-bearing proof (no fabricated green):
 *  - allowed + no price → free.
 *  - allowed + a per-method price → a 402 x402 quote payable to the AGENT's wallet (compensation).
 *  - per-method opt-in: a price on POST only leaves GET free, POST payable.
 *  - payment NEVER buys past RBAC: a denied caller stays denied EVEN WITH a price (Decalogue cmd 8).
 */
import { describe, expect, it } from "bun:test";
import { payGate } from "../src/values/contract-pay.ts";

const AGENT = "FnKAsX65xiNBukiLt9YYyzHJQrsRxQG62X9uMavKtkf"; // the agent being compensated

describe("payGate — RBAC + opt-in x402 compensation per GET/POST task", () => {
  it("FREE: allowed + no price → free (no payment required)", () => {
    const d = payGate({ surface: "agent:reddit", method: "GET", allowed: true, recipient: AGENT, resource: "task:1" });
    expect(d.kind).toBe("free");
  });

  it("PAYABLE: allowed + a per-method price → a 402 quote payable to the agent's wallet", () => {
    const d = payGate({
      surface: "agent:reddit",
      method: "POST",
      allowed: true,
      price: { POST: { amount: "10000" } }, // $0.01 USDC (6dp)
      recipient: AGENT,
      resource: "task:post-comment",
    });
    expect(d.kind).toBe("payment_required");
    if (d.kind !== "payment_required") throw new Error("unreachable");
    expect(d.quote.payTo).toBe(AGENT); // the agent gets compensated
    expect(d.quote.amount).toBe("10000");
    expect(d.quote.scheme).toBe("exact");
    expect(d.quote.network).toBe("solana");
  });

  it("PER-METHOD OPT-IN: a price on POST only → GET free, POST payable", () => {
    const price = { POST: { amount: "5000" } };
    const get = payGate({ surface: "s", method: "GET", allowed: true, price, recipient: AGENT, resource: "r" });
    const post = payGate({ surface: "s", method: "POST", allowed: true, price, recipient: AGENT, resource: "r" });
    expect(get.kind).toBe("free");
    expect(post.kind).toBe("payment_required");
  });

  it("RBAC WINS: a denied caller stays denied EVEN WITH a price (payment can't buy past RBAC)", () => {
    const d = payGate({
      surface: "s",
      method: "POST",
      allowed: false, // RBAC denied
      price: { POST: { amount: "999999" } },
      recipient: AGENT,
      resource: "r",
    });
    expect(d.kind).toBe("denied"); // NOT payment_required — payment never buys past the gate
  });

  it("carries the /contract verdict shape on every decision", () => {
    const d = payGate({ surface: "s", method: "GET", allowed: true, recipient: AGENT, resource: "r" });
    expect(typeof d._contract.terminal).toBe("boolean");
  });
});
