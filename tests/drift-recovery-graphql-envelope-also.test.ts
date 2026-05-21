// W-DRIFT-RECOVERY-GRAPHQL-ENVELOPE-ALSO: when a graphql endpoint returns
// an error envelope (data absent, errors[] populated), the substrate now
// also attempts page_fetch recovery against the contextUrl. Previously
// gated off under the assumption that a graphql error meant the page was
// also broken; bench cycle-3 probe 010 (dockerhub `Must provide query
// string.` on api.scout.docker.com/v1/graphql while
// https://hub.docker.com/r/library/nginx/tags still server-renders the
// tag listings) falsified that assumption.
//
// The shape-overlap gate (PR #609) protects against accepting unrelated
// junk, so re-using the same recovery branch is safe: either real data
// flows through or the envelope path remains the fallback (no worse than
// today). This suite is the structural-pin regression guard.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("drift recovery enters page_fetch branch for graphql-envelope too", () => {
  const src = readFileSync(
    resolve(import.meta.dir, "../src/execution/index.ts"),
    "utf8",
  );

  test("obsolete guard `!gqlEnvelope.is_envelope &&` is NOT in the recovery gate", () => {
    expect(src.includes("!gqlEnvelope.is_envelope && recaptureSignal.url")).toBe(false);
  });

  test("recovery branch is still wired and gated on having a re-capture URL", () => {
    expect(src.includes("tryRecoverFromSchemaDrift")).toBe(true);
    expect(src.includes("recoveredDataMatchesOriginalShape")).toBe(true);
    expect(src.includes("if (recaptureSignal.url) {")).toBe(true);
  });

  test("shape-overlap gate (PR #609) is still present to protect the relaxed entry", () => {
    expect(src.includes("drift_recovered_shape_mismatch")).toBe(true);
    expect(src.includes("Fall through to the envelope path")).toBe(true);
  });
});
