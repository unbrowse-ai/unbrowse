/**
 * Layer-2 (zkseal) witness — wiring the real ZK credential binding into the
 * capture-hole path. Grows seam by seam across the loop's EXECUTE days.
 *
 * DAY 3 (land — the seed): Seam 2, the binding mint. Prove zkBindKnownSecrets:
 *   (a) keys each binding by the SAME sha16 the redactor stamps (`bindingTag` →
 *       `[bound:<sha16>]`), so it can later join to the hole's placeholder;
 *   (b) mints a REAL binding that round-trips: verifyBinding(binding, proveHole)
 *       confirms knowledge of the bound secret WITHOUT the secret being present;
 *   (c) a wrong secret's proof fails against the binding (no forgery).
 */
import { describe, it, expect } from "bun:test";
import { getWalletPubkey } from "../src/values/signer.js";
import { bindingTag } from "../src/capture/wallet-bind.js";
import { zkBindKnownSecrets, proveHole, verifyHoleAttested, verifyHoleProof } from "../src/capture/zk-bound-hole.js";
import { verifyBinding } from "../src/values/zk-binding.js";
import { obfuscateRequestForReveng } from "../src/capture/obfuscate.js";
import { extractHoles, type HoleTemplate } from "../src/capture/hole-template.js";
import { clientFillAndProve, verifyClientHoleProofs, type RevengResponse } from "../src/capture/backend-reveng-endpoint.js";
import { deriveSealKey } from "../src/values/signer.js";
import type { RawRequest } from "../src/capture/index.js";

const enc = new TextEncoder();

/** A request carrying a known secret in the Authorization header. */
function reqWithSecret(secret: string): RawRequest {
  return {
    method: "GET",
    url: "https://api.example.com/v1/me",
    request_headers: { authorization: `Bearer ${secret}` },
    request_body: undefined,
    response_headers: {},
    response_body: undefined,
  } as RawRequest;
}

describe("zkseal Seam 2 — the binding mint (Day 3 seed)", () => {
  it("keys each binding by the same sha16 the redactor stamps", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "sk-live-abcdef0123456789";
    const map = await zkBindKnownSecrets([secret], wallet);

    const sha16 = bindingTag(secret, wallet).slice("bound:".length); // the join key
    expect(Object.keys(map)).toEqual([sha16]);
    expect(map[sha16].y).toMatch(/^[0-9a-f]+$/);
    expect(map[sha16].root).toBe(wallet); // bound to THIS wallet
    expect(map[sha16].sig.length).toBeGreaterThan(0);
  });

  it("the minted binding round-trips: holder proves knowledge, secret never present", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "session=9f8e7d6c5b4a3210";
    const map = await zkBindKnownSecrets([secret], wallet);
    const sha16 = bindingTag(secret, wallet).slice("bound:".length);

    const proof = proveHole(enc.encode(secret)); // holder proves with the real secret
    expect(verifyBinding(map[sha16], proof)).toBe(true);
    // the proof carries no secret bytes
    expect(JSON.stringify(proof)).not.toContain(secret);
  });

  it("a wrong secret cannot forge a proof for the binding", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "api_key=correct-horse-battery";
    const map = await zkBindKnownSecrets([secret], wallet);
    const sha16 = bindingTag(secret, wallet).slice("bound:".length);

    const forged = proveHole(enc.encode("api_key=wrong-guess"));
    expect(verifyBinding(map[sha16], forged)).toBe(false);
  });

  it("dedupes repeated secrets and skips empties in one pass", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const map = await zkBindKnownSecrets(["dup-secret", "dup-secret", ""], wallet);
    expect(Object.keys(map).length).toBe(1);
  });
});

describe("zkseal Seam 1+3 — end-to-end binding through the capture-hole path (Day 4 lights)", () => {
  it("obfuscate → mint → extractHoles upgrades Hole.bound to a real zkbind tag, reviving verifyHoleAttested", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-1234567890abcdef";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);

    const { holes } = extractHoles(skeleton, bindings);
    const authHole = holes.find((h) => h.name === "authorization");
    expect(authHole).toBeDefined();
    // Hole.bound is now the REAL binding, not the bare commitment
    expect(authHole!.bound?.startsWith("zkbind:")).toBe(true);
    // the dead backend check is alive: the wallet really bound this slot
    expect(verifyHoleAttested(authHole!)).toBe(true);
  });

  it("the holder proves knowledge of the bound secret at fill time (verifyHoleProof), secret never transmitted", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-fill-time-proof-99";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);
    const authHole = extractHoles(skeleton, bindings).holes.find((h) => h.name === "authorization")!;

    // At fill time the holder fills the hole with the vault value (the exact
    // string that was bound, e.g. the full `Bearer <tok>` header) and proves
    // knowledge of it — the secret bytes never leave.
    const boundValue = [...sink][0];
    const proof = proveHole(enc.encode(boundValue));
    expect(verifyHoleProof(authHole, proof)).toBe(true);
    // a wrong value cannot satisfy the same hole
    expect(verifyHoleProof(authHole, proveHole(enc.encode("Bearer tok-wrong")))).toBe(false);
  });

  it("a foreign wallet's binding does not match this wallet's commitment sha16 (no cross-owner correlation)", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-owner-bound";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    // a binding map minted under a DIFFERENT wallet pubkey → different sha16 keys
    const foreign = "00".repeat(32);
    const foreignBindings = await zkBindKnownSecrets([...sink], foreign);

    const authHole = extractHoles(skeleton, foreignBindings).holes.find((h) => h.name === "authorization")!;
    // no matching sha16 → no upgrade → stays the bare commitment, attestation stays closed
    expect(authHole.bound?.startsWith("zkbind:")).toBe(false);
    expect(verifyHoleAttested(authHole)).toBe(false);
  });

  it("no-wallet path falls back to the commitment unchanged (backward compatible)", () => {
    const secret = "tok-no-wallet";
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { secrets: [secret] }); // no walletPubkey
    const { holes } = extractHoles(skeleton); // no bindings
    const authHole = holes.find((h) => h.name === "authorization");
    // obfuscation without a wallet emits [REDACTED], not a bound tag — still a hole, no zk
    expect(authHole).toBeDefined();
    expect(authHole!.bound?.startsWith("zkbind:")).toBeFalsy();
    expect(verifyHoleAttested(authHole!)).toBe(false);
  });
});

describe("zkseal Seam 3 — the proof moves in the live fill pipeline (Day 5 creatures)", () => {
  // Build the client-side RevengResponse the way the holder would: obfuscate
  // (mint bindings), then extractHoles WITH the bindings so the holes carry the
  // real zkbind tag. fills maps hole.name -> the exact bound value.
  async function clientTemplate(req: RawRequest, secrets: string[]) {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(req, { walletPubkey: wallet, secrets, boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);
    const template: HoleTemplate = extractHoles(skeleton, bindings);
    return { template, bound: [...sink] };
  }

  it("GOLDEN: clientFillAndProve emits proofs the backend verifies; secret never on the wire", async () => {
    const secret = "tok-golden-001";
    const { template, bound } = await clientTemplate(reqWithSecret(secret), [secret]);
    const resp: RevengResponse = { templates: [template] };
    const key = deriveSealKey();
    // the holder fills the auth hole with the exact bound value
    const fills = [{ authorization: bound[0] }];

    const { requests, proofs } = clientFillAndProve(resp, fills, key);
    expect(requests.length).toBe(1);
    expect(verifyClientHoleProofs(resp, proofs)).toBe(true);
    // proofs carry no secret bytes
    expect(JSON.stringify(proofs)).not.toContain(secret);
  });

  it("EDGE: an id-hole (LLM-sourced, unbound) requires no proof and does not block verification", async () => {
    // a request with an {id} path placeholder and no secret
    const req = { method: "GET", url: "https://api.example.com/v1/users/{id}", request_headers: {}, request_body: undefined, response_headers: {}, response_body: undefined } as RawRequest;
    const template = extractHoles(obfuscateRequestForReveng(req, {}));
    const resp: RevengResponse = { templates: [template] };
    const { proofs } = clientFillAndProve(resp, [{ "path[4]": "42" }], deriveSealKey());
    expect(verifyClientHoleProofs(resp, proofs)).toBe(true); // no bound holes → nothing to prove
  });

  it("EDGE: multiple bound holes in one request are each proven", async () => {
    const s1 = "tok-multi-aaa", s2 = "tok-multi-bbb";
    const req = { method: "POST", url: "https://api.example.com/v1/act", request_headers: { authorization: `Bearer ${s1}`, "x-api-key": s2 }, request_body: undefined, response_headers: {}, response_body: undefined } as RawRequest;
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(req, { walletPubkey: wallet, secrets: [s1, s2], boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);
    const template = extractHoles(skeleton, bindings);
    const resp: RevengResponse = { templates: [template] };
    // fill each bound hole with its bound value
    const fills: Record<string, string> = {};
    for (const h of template.holes) {
      const boundVal = [...sink].find((v) => v.includes(h.name === "authorization" ? s1 : s2));
      if (boundVal) fills[h.name] = boundVal;
    }
    const { proofs } = clientFillAndProve(resp, [fills], deriveSealKey());
    expect(verifyClientHoleProofs(resp, proofs)).toBe(true);
  });

  it("ADVERSARIAL: filling a bound hole with the WRONG value fails backend verification", async () => {
    const secret = "tok-adversary-xyz";
    const { template } = await clientTemplate(reqWithSecret(secret), [secret]);
    const resp: RevengResponse = { templates: [template] };
    // holder fills with a value they do NOT actually hold for this binding
    const { proofs } = clientFillAndProve(resp, [{ authorization: "Bearer wrong-value" }], deriveSealKey());
    expect(verifyClientHoleProofs(resp, proofs)).toBe(false); // gate closes
  });

  it("ADVERSARIAL: a bound hole with NO proof supplied closes the gate", async () => {
    const secret = "tok-missing-proof";
    const { template } = await clientTemplate(reqWithSecret(secret), [secret]);
    const resp: RevengResponse = { templates: [template] };
    expect(verifyClientHoleProofs(resp, [{}])).toBe(false); // missing proof → false
  });

  it("DOMINION E2E: the whole caller journey in one flow — obfuscate → mint → hole → attest → fill → prove → verify → concrete request", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-e2e-journey-7788";

    // 1) client obfuscates its capture (secret never leaves; sink records the bound value)
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    expect(JSON.stringify(skeleton)).not.toContain(secret); // 2) no plaintext on the wire

    // 3) client mints the real ZK bindings over the exact bound values
    const bindings = await zkBindKnownSecrets([...sink], wallet);

    // 4) holes are extracted and upgraded to real zkbind tags
    const template = extractHoles(skeleton, bindings);
    const authHole = template.holes.find((h) => h.name === "authorization")!;
    expect(authHole.bound?.startsWith("zkbind:")).toBe(true);

    // 5) backend attests the slot was wallet-bound — without the secret, without a proof
    expect(verifyHoleAttested(authHole)).toBe(true);

    // 6) client fills sealed-to-wallet AND proves knowledge of the bound value
    const resp: RevengResponse = { templates: [template] };
    const { requests, proofs } = clientFillAndProve(resp, [{ authorization: [...sink][0] }], deriveSealKey());

    // 7) backend verifies the proofs (gate open) — secret still never seen
    expect(verifyClientHoleProofs(resp, proofs)).toBe(true);
    expect(JSON.stringify(proofs)).not.toContain(secret);

    // 8) the concrete request is reconstituted locally with the real value
    expect(requests.length).toBe(1);
    expect(requests[0].request_headers?.authorization).toContain(secret); // only here, client-side
  });
});
