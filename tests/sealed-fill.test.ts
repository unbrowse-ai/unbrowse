/**
 * sealed-fill.test — the witness for the sealed-hole-fill integration
 * (src/capture/sealed-fill.ts): the backend exposes only the holes; the client
 * keeps its fills SEALED to the wallet and reveals them LOCALLY at emit time. Proves:
 * sealed fills leak nothing; the wallet holder fills the concrete request; a
 * stranger key cannot complete it; and it round-trips against the REAL wallet.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { extractHoles, type HoleTemplate } from "../src/capture/hole-template.js";
import { sealFills, fillHolesSealed } from "../src/capture/sealed-fill.js";
import { SealReveal } from "../src/values/wallet-seal.js";
import type { RawRequest } from "../src/capture/index.js";

const key = () => new Uint8Array(randomBytes(32));

// An obfuscated capture: the secret is already a [REDACTED] placeholder (the backend
// only ever sees this) — extractHoles names the slot the client must fill.
function template(): HoleTemplate {
  const skeleton: RawRequest = {
    url: "https://api.example.com/v1/orders",
    method: "POST",
    request_headers: { authorization: "[REDACTED]", "content-type": "application/json" },
    request_body: undefined,
    response_status: 200,
    response_headers: {},
  };
  return extractHoles(skeleton);
}

describe("sealed-hole-fill", () => {
  it("the template exposes the hole but never the secret", () => {
    const t = template();
    expect(t.holes.some((h) => h.name === "authorization" && h.kind === "secret")).toBe(true);
    expect(JSON.stringify(t)).not.toContain("sk_live"); // no secret anywhere in what the backend produced
  });

  it("sealed fills are ciphertext — they leak nothing of the secret", () => {
    const sealed = sealFills({ authorization: "Bearer sk_live_DO_NOT_LEAK" }, key());
    expect(new TextDecoder().decode(sealed.authorization.sealed)).not.toContain("sk_live");
  });

  it("the wallet holder reveals locally and completes the concrete request", () => {
    const k = key();
    const sealed = sealFills({ authorization: "Bearer sk_live_REALTOKEN" }, k);
    const req = fillHolesSealed(template(), sealed, k);
    expect(req.request_headers.authorization).toBe("Bearer sk_live_REALTOKEN"); // filled locally
  });

  it("a stranger key CANNOT complete the request (stays sealed)", () => {
    const sealed = sealFills({ authorization: "Bearer sk_live_REALTOKEN" }, key());
    expect(() => fillHolesSealed(template(), sealed, key())).toThrow(SealReveal);
  });

  it("round-trips against the REAL wallet seal key", async () => {
    const { deriveSealKey } = await import("../src/values/signer.js");
    const wk = deriveSealKey();
    const sealed = sealFills({ authorization: "Bearer wallet-bound" }, wk);
    expect(fillHolesSealed(template(), sealed, wk).request_headers.authorization).toBe("Bearer wallet-bound");
  });
});
