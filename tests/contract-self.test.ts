/**
 * contract-self witness — the CLI is self-aware about its economy + security; anyone can ask + know.
 * Load-bearing proof (no drift): the portrait is built FROM the live code, so what we tell a user
 * matches what the code does — the settlement asset equals contract-pay's USDC_SOL_MINT (a hand-copied
 * portrait could drift; this cannot). And a free-text question routes to the right slice.
 */
import { describe, expect, it } from "bun:test";
import { contractSelfPortrait, contractSelfAnswer } from "../src/values/contract-self.ts";
import { USDC_SOL_MINT } from "../src/values/contract-pay.ts";

describe("contractSelf — the CLI knows its own economy + security", () => {
  it("NO DRIFT: the portrait's settlement asset IS the code's USDC mint (built from source)", () => {
    const p = contractSelfPortrait();
    expect(p.economy.settlement.mint).toBe(USDC_SOL_MINT); // can't drift — same source
    expect(p.economy.stakeToken.symbol).toBe("FDRY");
    expect(p.economy.settlement.symbol).toBe("USDC");
  });

  it("ECONOMY: names FDRY-bonds / USDC-settles + x402 agent compensation", () => {
    const p = contractSelfPortrait();
    expect(p.economy.stakeToken.role).toMatch(/never settles|stake/i);
    expect(p.economy.compensation).toMatch(/x402|agent|paid/i);
  });

  it("SECURITY: names grantGate RBAC + payment-never-buys-past-RBAC + fail-closed", () => {
    const p = contractSelfPortrait();
    expect(p.security.rbac).toMatch(/grantGate|capability|no grant/i);
    expect(p.security.paymentBoundary).toMatch(/never buys past|denied.*denied|permitted/i);
    expect(p.security.failClosed).toMatch(/malformed|never becomes a quote/i);
  });

  it("ASK: a security question routes to the security answer", () => {
    const a = contractSelfAnswer("is it secure? how do permissions work?");
    expect(a).toMatch(/Security/);
    expect(a).toMatch(/grantGate|capability/);
    expect(a).not.toMatch(/^Economy —/);
  });

  it("ASK: an economy question routes to the economy answer", () => {
    const a = contractSelfAnswer("how does the token economy and payment work?");
    expect(a).toMatch(/Economy/);
    expect(a).toMatch(/FDRY|USDC|x402/);
  });

  it("ASK: a general question returns the whole portrait (economy + security + features)", () => {
    const a = contractSelfAnswer("what is this and how does it work?");
    expect(a).toMatch(/Economy:/);
    expect(a).toMatch(/Security:/);
    expect(a).toMatch(/Features:/);
  });
});
