import { describe, it, expect } from "bun:test";
import { buildXPayment, pickExactAccept } from "./x402-pay-mainnet.mjs";

// Falsifiable signal (Genesis Day 4) over the Step-3 client: the X-PAYMENT it
// builds must match the shape the deployed backend parses — top-level
// scheme:"exact" (dispatch), `accepted` (forwarded as paymentRequirements), and
// payload.transaction (the signed wire tx). Mirrors the LIVE 402 accept shape.

const exactAccept = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "3672",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn",
  maxTimeoutSeconds: 300,
  extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", facilitator: "https://facilitator.payai.network" },
};
const signedPayload = { transaction: "QUJDREVGEXAMPLEBASE64WIRE==" };

describe("x402 client X-PAYMENT construction", () => {
  it("builds a base64 payload the backend can dispatch + forward", () => {
    const header = buildXPayment(exactAccept, signedPayload);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact"); // backend reads payload.scheme to route to PayAI
    expect(decoded.accepted).toEqual(exactAccept); // forwarded as paymentRequirements
    expect(decoded.payload.transaction).toBe(signedPayload.transaction);
    expect(decoded.extra.facilitator).toBe("https://facilitator.payai.network");
  });

  it("inherits the facilitator from the accept when not overridden", () => {
    const decoded = JSON.parse(Buffer.from(buildXPayment(exactAccept, signedPayload), "base64").toString("utf8"));
    expect(decoded.extra.facilitator).toBe(exactAccept.extra.facilitator);
  });

  it("ADVERSARIAL: a minimal accept with no `extra` still builds a valid payload (default facilitator, no crash)", () => {
    const minimal = { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "3672", asset: "x", payTo: "y", maxTimeoutSeconds: 300 };
    const decoded = JSON.parse(Buffer.from(buildXPayment(minimal, signedPayload), "base64").toString("utf8"));
    expect(decoded.scheme).toBe("exact");
    expect(decoded.extra.facilitator).toBe("https://facilitator.payai.network");
    expect(decoded.payload.transaction).toBe(signedPayload.transaction);
  });

  it("pickExactAccept selects the solana exact entry and ignores others", () => {
    const accepts = [
      { scheme: "@faremeter/flex", network: "solana-mainnet" },
      exactAccept,
    ];
    expect(pickExactAccept(accepts)).toBe(exactAccept);
    expect(pickExactAccept([{ scheme: "@faremeter/flex", network: "solana-mainnet" }])).toBeUndefined();
    expect(pickExactAccept([])).toBeUndefined();
  });
});
