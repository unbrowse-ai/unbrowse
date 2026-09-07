import { describe, expect, test } from "bun:test";
import { buildReleaseAttestationHeaders } from "../src/client/index.js";

describe("buildReleaseAttestationHeaders", () => {
  test("drops partial release attestation headers", () => {
    expect(buildReleaseAttestationHeaders("manifest", "")).toEqual({});
    expect(buildReleaseAttestationHeaders("", "signature")).toEqual({});
    expect(buildReleaseAttestationHeaders("   ", "signature")).toEqual({});
    expect(buildReleaseAttestationHeaders("manifest", "   ")).toEqual({});
  });

  test("emits both headers together when attestation is complete", () => {
    expect(buildReleaseAttestationHeaders(" manifest ", " signature ")).toEqual({
      "X-Unbrowse-Release-Manifest": "manifest",
      "X-Unbrowse-Release-Signature": "signature",
    });
  });
});
