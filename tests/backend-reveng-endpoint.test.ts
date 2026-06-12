/**
 * backend-reveng-endpoint.test — the witness for "the backend IS the harness."
 *
 * Proves the end-to-end obfuscated-API flow over a REAL capture carrying real
 * secrets:
 *   1. the client obfuscates + audits — NONE of the user's secrets leave the
 *      machine (audit.safe, and no secret byte survives in the request);
 *   2. the backend returns ONLY {skeleton, holes} — no secret, no engine, no
 *      forbidden internal field (responseExposesOnlyHoles);
 *   3. the client fills the holes LOCALLY sealed to the wallet and the concrete
 *      request RECONSTRUCTS the original exactly (round-trip fidelity) — the
 *      backend never saw a plaintext secret;
 *   4. a real ZK-bound hole verifies ATTESTED on the backend without the secret,
 *      while a plain commitment / unbound hole does not (honest, fail-closed).
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  clientObfuscate,
  backendSurface,
  responseExposesOnlyHoles,
  backendAttestedHoles,
  clientFillSealed,
} from "../src/capture/backend-reveng-endpoint.js";
import { bindHole, parseBoundTag } from "../src/capture/zk-bound-hole.js";
import { verifyHoleAttested } from "../src/capture/zk-bound-hole.js";
import type { Hole } from "../src/capture/hole-template.js";
import type { RawRequest } from "../src/capture/index.js";

const TOKEN = "Bearer sk_live_DO_NOT_LEAK_0123456789abcdef";
const COOKIE = "session=abcdef0123456789abcdef0123456789";
const ACCESS = "at_9f8e7d6c5b4a39281706fedcba987654";
const ID = "deadbeefcafef00d1234567890abcdef"; // 32-hex opaque id → {id} (an llm hole, not a secret)

function realCapture(): RawRequest {
  return {
    url: `https://api.shop.example/v1/users/${ID}/orders`,
    method: "POST",
    request_headers: { authorization: TOKEN, cookie: COOKIE, "content-type": "application/json" },
    request_body: JSON.stringify({ access_token: ACCESS, qty: 2 }),
    response_status: 200,
    response_headers: {},
    response_body: JSON.stringify({ ok: true }),
    timestamp: "2026-06-03T00:00:00Z",
  };
}

const WALLET = "11111111111111111111111111111111"; // a wallet pubkey (binds the redactions)
const SECRETS = [TOKEN, COOKIE, ACCESS];

describe("backend-reveng-endpoint — the backend is the harness", () => {
  it("client obfuscate+audit: NO secret leaves the machine", () => {
    const { request, audit } = clientObfuscate([realCapture()], { secrets: SECRETS, walletPubkey: WALLET });
    expect(audit.safe).toBe(true);
    expect(audit.redactions).toBeGreaterThan(0);
    expect(audit.boundRedactions).toBeGreaterThan(0); // wallet-bound, not just hidden
    const wire = JSON.stringify(request.capture);
    for (const s of SECRETS) expect(wire).not.toContain(s); // nothing on the wire
  });

  it("backend surfaces ONLY {skeleton, holes} — no secret, no engine internals", () => {
    const { request } = clientObfuscate([realCapture()], { secrets: SECRETS, walletPubkey: WALLET });
    const resp = backendSurface(request);
    expect(responseExposesOnlyHoles(resp)).toBe(true);
    const wire = JSON.stringify(resp);
    for (const s of SECRETS) expect(wire).not.toContain(s);
    // the holes name every slot the client must fill, and only those
    const names = resp.templates[0].holes.map((h) => h.name);
    expect(names).toContain("authorization");
    expect(names).toContain("cookie");
    expect(names).toContain("access_token");
    expect(resp.templates[0].holes.some((h) => h.location.in === "path" && h.kind === "id")).toBe(true);
  });

  it("client fills holes sealed-to-wallet LOCALLY → reconstructs the exact request", () => {
    const key = new Uint8Array(randomBytes(32));
    const { request } = clientObfuscate([realCapture()], { secrets: SECRETS, walletPubkey: WALLET });
    const resp = backendSurface(request);
    // the client sources each hole from its vault (secrets) / its llm (the id)
    const pathHole = resp.templates[0].holes.find((h) => h.location.in === "path")!;
    const fills: Record<string, string> = {
      authorization: TOKEN,
      cookie: COOKIE,
      access_token: ACCESS,
      [pathHole.name]: ID,
    };
    const [concrete] = clientFillSealed(resp, [fills], key);
    expect(concrete.request_headers.authorization).toBe(TOKEN);
    expect(concrete.request_headers.cookie).toBe(COOKIE);
    expect(JSON.parse(concrete.request_body!).access_token).toBe(ACCESS);
    expect(new URL(concrete.url).pathname).toContain(ID); // the id slot reconstructed
  });

  it("a stranger key cannot reconstruct the request (fills stay sealed)", () => {
    const { request } = clientObfuscate([realCapture()], { secrets: SECRETS, walletPubkey: WALLET });
    const resp = backendSurface(request);
    const pathHole = resp.templates[0].holes.find((h) => h.location.in === "path")!;
    const fills = { authorization: TOKEN, cookie: COOKIE, access_token: ACCESS, [pathHole.name]: ID };
    // seal under one key, attempt to fill under another → throws (cannot complete)
    expect(() => {
      // re-seal under a fresh key but reveal under a different one
      const { sealFills } = require("../src/capture/sealed-fill.js");
      const { fillHolesSealed } = require("../src/capture/sealed-fill.js");
      const sealed = sealFills(fills, new Uint8Array(randomBytes(32)));
      fillHolesSealed(resp.templates[0], sealed, new Uint8Array(randomBytes(32)));
    }).toThrow();
  });

  it("a real ZK-bound hole verifies ATTESTED on the backend without the secret", async () => {
    const hole: Hole = { location: { in: "header", name: "x-api-key" }, name: "x-api-key", kind: "secret", fill: "vault" };
    const bound = await bindHole(hole, new TextEncoder().encode("super-secret-credential"));
    expect(verifyHoleAttested(bound)).toBe(true); // backend confirms wallet bound it — no secret seen
    expect(parseBoundTag(bound.bound)).not.toBeNull();
    // an unbound hole, and a plain [bound:hex] commitment, are NOT attested (honest)
    expect(verifyHoleAttested(hole)).toBe(false);
    expect(verifyHoleAttested({ ...hole, bound: "[bound:0123456789abcdef]" })).toBe(false);
  });

  it("backendAttestedHoles counts only the truly-attested holes", () => {
    const { request } = clientObfuscate([realCapture()], { secrets: SECRETS, walletPubkey: WALLET });
    const resp = backendSurface(request);
    // the obfuscation produced plain commitments, not Ed25519 attestations → 0 attested, honest
    const { attested, total } = backendAttestedHoles(resp);
    expect(total).toBeGreaterThan(0);
    expect(attested).toBe(0);
  });
});
