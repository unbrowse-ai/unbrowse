// AC-INV + AC-P0 (client side): identity/attribution ids → wallet-bound commitments
// via the standard hole interface. The raw id never appears in the output (it is
// replaced by a one-way, wallet-signed zkbind tag), and the client secret-shape gate
// admits the commitment (a secret-free form) while still flagging the raw id.
import { describe, it, expect } from "bun:test";
import {
  holeifyIds,
  holeifyEndpointAttribution,
  parseBoundTag,
  verifyHoleAttested,
} from "../src/capture/zk-bound-hole.js";
import { looksLikeSecret } from "../src/publish/sanitize.js";

// A 44-char base58 wallet pubkey — matches the base64-ish secret-value pattern, so
// it is exactly the value the backend rejects as a residual secret leak.
const RAW_PUBKEY = "9hCmWfZeWHEnjvgzMwx4suzVyGv4bgTbrdvZGoq5D2zg";
const SHORT_ID = "GrK2aguaZZurVAFoiadvP";

describe("holeifyIds — attribution ids become wallet-bound commitments", () => {
  it("replaces every raw id with a valid zkbind commitment; no raw id survives", async () => {
    const out = await holeifyIds([RAW_PUBKEY, SHORT_ID]);
    expect(out.length).toBe(2);
    for (const tag of out) {
      expect(tag.startsWith("zkbind:")).toBe(true);
      // the raw inputs must not appear anywhere in the output (one-way)
      expect(tag.includes(RAW_PUBKEY)).toBe(false);
      expect(tag.includes(SHORT_ID)).toBe(false);
      // the commitment is wallet-attested (Ed25519 sig over y), checkable with no secret
      const b = parseBoundTag(tag);
      expect(b).not.toBeNull();
      expect(verifyHoleAttested({ location: { in: "header", name: "x" }, name: "x", kind: "secret", fill: "vault", bound: tag })).toBe(true);
    }
  });

  it("passes an already-bound tag through unchanged (idempotent)", async () => {
    const [tag] = await holeifyIds([RAW_PUBKEY]);
    const again = await holeifyIds([tag]);
    expect(again).toEqual([tag]);
  });

  it("drops empty / non-string entries", async () => {
    const out = await holeifyIds(["", RAW_PUBKEY, null as unknown as string, 42 as unknown as string]);
    expect(out.length).toBe(1);
  });

  it("holeifies corroboration on each endpoint, leaving non-corroboration shape intact", async () => {
    const eps = [
      { url_template: "https://api.x.com/v1/items", corroboration: { submitter_agent_ids: [RAW_PUBKEY], verified_release_submitter_ids: [SHORT_ID] } },
      { url_template: "https://api.x.com/v1/other" }, // no corroboration → untouched
    ];
    const out = await holeifyEndpointAttribution(eps);
    const corr = (out[0] as { corroboration: { submitter_agent_ids: string[]; verified_release_submitter_ids: string[] } }).corroboration;
    expect(corr.submitter_agent_ids.every((t) => t.startsWith("zkbind:"))).toBe(true);
    expect(corr.verified_release_submitter_ids.every((t) => t.startsWith("zkbind:"))).toBe(true);
    expect(JSON.stringify(out)).not.toContain(RAW_PUBKEY);
    expect(JSON.stringify(out)).not.toContain(SHORT_ID);
    expect((out[1] as { url_template: string }).url_template).toBe("https://api.x.com/v1/other");
  });
});

describe("looksLikeSecret — admit the commitment, flag the raw id", () => {
  it("flags a raw wallet pubkey (the thing that trips the backend)", () => {
    expect(looksLikeSecret("submitter_agent_ids", RAW_PUBKEY)).toBe(true);
  });
  it("admits a zkbind commitment (secret-free by construction)", async () => {
    const [tag] = await holeifyIds([RAW_PUBKEY]);
    expect(looksLikeSecret("submitter_agent_ids", tag)).toBe(false);
  });
});
