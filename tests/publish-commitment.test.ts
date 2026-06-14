/**
 * publish-commitment.test — published write routes carry the input COMMITMENT
 * (verifiable) but never a cleartext example_value.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeForPublish } from "../src/publish/sanitize.js";
import { commitValue } from "../src/proof/input-censor.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(requires: Array<Record<string, unknown>>): EndpointDescriptor {
  return {
    endpoint_id: "w",
    method: "POST",
    url_template: "https://api.example.com/posts",
    idempotency: "unsafe",
    semantic: { action_kind: "write", resource_kind: "record", requires },
  } as unknown as EndpointDescriptor;
}

describe("sanitizeForPublish — binding commitments", () => {
  it("keeps a sha256 commitment on a sensitive binding, strips a real example_value", () => {
    const [clean] = sanitizeForPublish([
      ep([
        { key: "password", required: true, source: "body", semantic_type: "secret", example_value: commitValue("pistol") },
        { key: "title", required: true, source: "body", example_value: "my real title" },
      ]),
    ]);
    const reqs = (clean.semantic!.requires ?? []) as Array<Record<string, unknown>>;
    const byKey = Object.fromEntries(reqs.map((r) => [r.key, r]));
    // commitment preserved (verifiable), and it is NOT the cleartext
    expect(byKey.password.example_value).toBe(commitValue("pistol"));
    expect(String(byKey.password.example_value)).not.toContain("pistol");
    // real cleartext example stripped
    expect("example_value" in byKey.title).toBe(false);
  });

  it("never leaks a non-committed secret value", () => {
    const [clean] = sanitizeForPublish([
      ep([{ key: "token", required: true, source: "body", example_value: "sk-live-SECRET" }]),
    ]);
    const blob = JSON.stringify(clean);
    expect(blob).not.toContain("sk-live-SECRET");
  });
});
