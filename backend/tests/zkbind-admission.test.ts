// AC-P0 (backend side): the residual-secret gate admits a wallet-bound commitment
// (zkbind:y.root.sig) in attribution fields — it is secret-free by construction —
// while still rejecting a RAW submitter id (the value that tripped the 422 on
// backfill). Admission is by design (the commitment shape), not regex luck.
import { describe, it, expect } from "bun:test";
import { detectResidualSecretLeak, looksLikeSecret } from "../src/services/publish-sanitize.js";

const RAW_PUBKEY = "9hCmWfZeWHEnjvgzMwx4suzVyGv4bgTbrdvZGoq5D2zg";
// a structurally-valid commitment tag (y.root.sig) — no secret in it.
const COMMITMENT = "zkbind:" + "a".repeat(80) + "." + "b".repeat(64) + "." + "c".repeat(128);

describe("detectResidualSecretLeak — zkbind admission", () => {
  it("flags a raw submitter pubkey in corroboration (regression — this is the 422 case)", () => {
    const eps = [{ url_template: "https://api.x.com/v1/items", corroboration: { submitter_agent_ids: [RAW_PUBKEY] } }];
    const hits = detectResidualSecretLeak(eps);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("admits a wallet-bound commitment in the same field (no leak)", () => {
    const eps = [{ url_template: "https://api.x.com/v1/items", corroboration: { submitter_agent_ids: [COMMITMENT], verified_release_submitter_ids: [COMMITMENT] } }];
    const hits = detectResidualSecretLeak(eps);
    expect(hits).toEqual([]);
  });

  it("looksLikeSecret: raw → true, commitment → false (the admission predicate)", () => {
    expect(looksLikeSecret("submitter_agent_ids", RAW_PUBKEY)).toBe(true);
    expect(looksLikeSecret("submitter_agent_ids", COMMITMENT)).toBe(false);
  });
});
