/**
 * contribution-no-leak.test — the witness for plan node 6 (no-secret-leak on the WRITE
 * path). The reveng READ path already proves no secret crosses the wire
 * (revengEgressPayload); this extends that invariant to the CONTRIBUTION payload.
 *
 * Proves: a contribution {delta, validity, attestation} built from a capture full of real
 * secrets (bearer token, cookie, api key, set-cookie) carries NONE of those values — the
 * shape is a one-way content pointer, the validity proof is group elements, the
 * attestation is origin/shape/signature. Belt and braces: the upstream obfuscation strips
 * the secret values too.
 */
import { describe, expect, it } from "bun:test";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import type { RawRequest } from "../src/capture/index.js";
import { signDelta, shapePointer } from "../src/values/route-delta.js";
import { proveDeltaValidity } from "../src/values/delta-proof.js";
import { attestExecution } from "../src/capture/exec-attest.js";

const BEARER = "sk-live-CONTRIB-SECRET-deadbeef0123456789";
const COOKIE = "session-SECRET-cafebabe9876543210";
const APIKEY = "apikeySECRETfeedface5555";
const SETCOOKIE = "sidSECRET0f0f0f0f";
const SECRETS = [BEARER, COOKIE, APIKEY, SETCOOKIE];

function secretLadenCapture(): RawRequest {
  return {
    url: "https://api.example.com/v1/items?page=1",
    method: "GET",
    request_headers: {
      authorization: `Bearer ${BEARER}`,
      cookie: `session=${COOKIE}`,
      "content-type": "application/json",
    },
    request_body: JSON.stringify({ api_key: APIKEY, q: "items" }),
    response_status: 200,
    response_headers: { "set-cookie": `sid=${SETCOOKIE}; HttpOnly` },
    response_body: JSON.stringify({ items: [{ id: 1 }] }),
    timestamp: "2026-06-13T00:00:00Z",
  };
}

describe("contribution-no-leak (plan node 6)", () => {
  it("the contribution payload carries no secret value — shape is a hash, not the bytes", async () => {
    const raw = secretLadenCapture();
    // Even hashing the RAW capture (worst case, no obfuscation) the shape is one-way:
    const shape = shapePointer(raw);
    const delta = await signDelta({ op: "add", endpoint: "GET api.example.com/v1/items", shape, freshness: 1000 });
    const validity = proveDeltaValidity(delta, 3, 16);
    const attestation = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: shape });

    const wire = JSON.stringify({ delta, validity, attestation });
    for (const secret of SECRETS) {
      expect(wire).not.toContain(secret);
    }
    expect(delta.shape).toMatch(/^sha256:[0-9a-f]{64}$/); // only a commitment travels
  });

  it("the upstream obfuscation strips every secret value before it is even hashed", () => {
    const sanitized = obfuscateCaptureForReveng([secretLadenCapture()]);
    const wire = JSON.stringify(sanitized);
    for (const secret of SECRETS) {
      expect(wire).not.toContain(secret);
    }
  });

  it("the same secret-stripped structure yields a stable shape (deterministic contribution)", () => {
    const a = shapePointer(obfuscateCaptureForReveng([secretLadenCapture()]));
    const b = shapePointer(obfuscateCaptureForReveng([secretLadenCapture()]));
    expect(a).toBe(b);
  });
});
