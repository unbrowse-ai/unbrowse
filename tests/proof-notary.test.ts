import { describe, expect, test } from "bun:test";
import {
  createNotaryClient,
  isNotaryAvailable,
} from "../src/proof/notary.js";

describe("TLSNotary client", () => {
  test("isNotaryAvailable returns false when no server configured", () => {
    delete process.env.UNBROWSE_NOTARY_URL;
    expect(isNotaryAvailable()).toBe(false);
  });

  test("isNotaryAvailable returns true when server URL is set", () => {
    process.env.UNBROWSE_NOTARY_URL = "https://notary.example.com";
    expect(isNotaryAvailable()).toBe(true);
    delete process.env.UNBROWSE_NOTARY_URL;
  });

  test("createNotaryClient returns client with expected interface", () => {
    const client = createNotaryClient("https://notary.example.com");
    expect(typeof client.generateTlsProof).toBe("function");
    expect(typeof client.verifyTlsProof).toBe("function");
    expect(client.notaryUrl).toBe("https://notary.example.com");
  });

  test("generateTlsProof returns a proof with tlsnotary type", async () => {
    const client = createNotaryClient("https://notary.example.com");
    const proof = await client.generateTlsProof({
      url: "https://api.example.com/v1/data",
      method: "GET",
      responseBody: '{"result":"ok"}',
      responseStatus: 200,
      domain: "example.com",
      timestamp: "2026-05-02T12:00:00Z",
    });
    expect(proof.proof_type).toBe("tlsnotary");
    expect(proof.notary_id).toContain("notary.example.com");
    expect(proof.commitment.domain).toBe("example.com");
  });
});
