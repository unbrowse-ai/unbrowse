import { describe, expect, test } from "bun:test";
import { cleanBackfillManifest, type BackfillCandidate } from "../src/lib/backfill.js";
import { holeifyEndpointAttribution } from "../src/capture/zk-bound-hole.js";

// HARD INVARIANT (end-to-end): when a cached manifest is prepared for backfill/publish,
// the serialized body that would cross the wire contains ZERO raw attribution ids /
// secrets — only wallet-bound commitments (`zkbind:` tags). Public structural fields
// (url_template etc.) stay inert so the route remains reusable.

const RAW_PUBKEY = "9hCmWfZeWHEnjvgzMwx4suzVyGv4bgTbrdvZGoq5D2zg";
const RAW_SHORT_ID = "GrK2aguaZZurVAFoiadvP";
// Real-shaped same-domain host. NOTE: `api.example.com` (the literal in the brief) is
// rejected by the real publish-validation path — `example.com` is a reserved/junk domain
// that `isIndexableDomain` drops, so `cleanBackfillManifest` would return null before the
// holeify step we are testing ever runs. We use a representative real-shaped domain so the
// end-to-end backfill prep path actually executes the wallet-bind invariant.
const DOMAIN = "api.acme.dev";
const URL_TEMPLATE = `https://${DOMAIN}/v1/items`;

function makeManifest(): BackfillCandidate {
  return {
    skill_id: "s1",
    domain: DOMAIN,
    endpoints: [
      {
        url_template: URL_TEMPLATE,
        corroboration: {
          submitter_agent_ids: [RAW_PUBKEY],
          verified_release_submitter_ids: [RAW_SHORT_ID],
        },
      },
    ],
  };
}

describe("backfill prep emits no raw attribution ids on the wire", () => {
  test("serialized body carries only zkbind: commitments, structure preserved", async () => {
    const m = makeManifest();

    // Real backfill prep path: shape-clean (strips junk endpoints) → wallet-bind attribution.
    const cleaned = cleanBackfillManifest(m);
    expect(cleaned).not.toBeNull();
    cleaned!.endpoints = await holeifyEndpointAttribution(cleaned!.endpoints);

    const wire = JSON.stringify(cleaned);

    // 1 + 2: no raw ids anywhere in the serialized body.
    expect(wire).not.toContain(RAW_PUBKEY);
    expect(wire).not.toContain(RAW_SHORT_ID);

    // 3: every corroboration id is a wallet-bound commitment.
    const ep = cleaned!.endpoints[0] as {
      url_template: string;
      corroboration: {
        submitter_agent_ids: string[];
        verified_release_submitter_ids: string[];
      };
    };
    const allIds = [
      ...ep.corroboration.submitter_agent_ids,
      ...ep.corroboration.verified_release_submitter_ids,
    ];
    expect(allIds.length).toBe(2);
    for (const id of allIds) {
      expect(id.startsWith("zkbind:")).toBe(true);
    }

    // 4: public structural field preserved (not holed) — reusability guardrail.
    expect(ep.url_template).toBe(URL_TEMPLATE);
  });
});
