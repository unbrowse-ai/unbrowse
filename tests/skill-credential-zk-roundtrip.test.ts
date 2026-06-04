import { describe, expect, test } from "bun:test";
import { credentialHoles, credentialHoleToRuntimeHole } from "../src/skillmd.js";
import { bindHole, proveHole, verifyHoleAttested, verifyHoleProof } from "../src/capture/zk-bound-hole.js";
import type { SkillManifest } from "../src/types/skill.js";

// End-to-end proof of the north star's "credentials are ZK-surfaced holes filled
// by private key": a credential declared in a generated skill is bound to a
// private-key secret, proven, and verified — the secret never transmitted.
function authedSkill(): SkillManifest {
  return {
    skill_id: "sk_x", domain: "x.com", name: "X", description: "x routes",
    version: "1.0.0", updated_at: "2026-06-04T00:00:00Z",
    intent_signature: "get home timeline", intents: ["get home timeline"],
    endpoints: [{
      endpoint_id: "ep", method: "GET", url_template: "https://x.com/i/api/graphql/HomeTimeline",
      headers_template: { authorization: "{token}", accept: "application/json" },
    }],
  } as unknown as SkillManifest;
}

describe("credential hole — ZK bind/prove/verify round-trip from a private key", () => {
  test("the declared 'authorization' credential binds, proves, and verifies without revealing the secret", async () => {
    const cred = credentialHoles(authedSkill()).find((h) => h.name === "authorization");
    expect(cred).toBeDefined();
    const hole = credentialHoleToRuntimeHole(cred!);

    const secretHex = "11".repeat(32);
    const secret = Uint8Array.from(Buffer.from(secretHex, "hex"));
    const bound = await bindHole(hole, secret);

    // The wallet (private key) really bound this slot.
    expect(verifyHoleAttested(bound)).toBe(true);
    // ZK: the secret never appears in the published bound tag.
    expect(bound.bound ?? "").not.toContain(secretHex);
    expect(bound.bound ?? "").toMatch(/^zkbind:/);

    // Holder proves knowledge of the bound secret; verifier accepts.
    const proof = proveHole(secret);
    expect(verifyHoleProof(bound, proof)).toBe(true);
  });

  test("a different secret fails verification (real ZK, not a stub)", async () => {
    const cred = credentialHoles(authedSkill()).find((h) => h.name === "authorization")!;
    const hole = credentialHoleToRuntimeHole(cred);
    const bound = await bindHole(hole, Uint8Array.from(Buffer.from("22".repeat(32), "hex")));
    const wrongProof = proveHole(Uint8Array.from(Buffer.from("99".repeat(32), "hex")));
    expect(verifyHoleProof(bound, wrongProof)).toBe(false);
  });

  test("bridge maps cookie credentials onto the cookie header", () => {
    const hole = credentialHoleToRuntimeHole({ name: "session", location: "cookie", fill: "zk:private-key" });
    expect(hole.kind).toBe("secret");
    expect((hole.location as { in: string; name: string }).in).toBe("header");
    expect((hole.location as { in: string; name: string }).name).toBe("cookie");
  });
});
