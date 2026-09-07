/**
 * Wave 2 unit tests for backend/src/services/privy.ts.
 *
 * Per CLAUDE.md "Never mock in tests" — we don't mock Privy's REST API.
 * Instead this asserts the structural invariants on real malformed/expired
 * tokens that should fail loud regardless of the upstream Privy service.
 * The live wallet-binding path is verified end-to-end by Wave 4's
 * http-curl matrix (real JWT from a real Privy sign-in, not a fixture).
 */
import { describe, it, expect } from "bun:test";
import { verifyPrivyAuthToken } from "../src/services/privy.js";

const FAKE_ENV = {
  PRIVY_APP_ID: "cmpalnem701z00cjmncqve4q0",
  PRIVY_APP_SECRET: "fake-secret-for-structural-tests-only",
} as any;

describe("verifyPrivyAuthToken (Wave 2 structural invariants)", () => {
  it("rejects empty token with privy_jwt_malformed", async () => {
    await expect(verifyPrivyAuthToken("", FAKE_ENV)).rejects.toThrow(/privy_jwt_malformed/);
  });

  it("rejects single-part token with privy_jwt_malformed", async () => {
    await expect(verifyPrivyAuthToken("header-only", FAKE_ENV)).rejects.toThrow(/privy_jwt_malformed/);
  });

  it("rejects two-part token with privy_jwt_malformed", async () => {
    await expect(verifyPrivyAuthToken("a.b", FAKE_ENV)).rejects.toThrow(/privy_jwt_malformed/);
  });

  it("rejects non-base64 header bytes", async () => {
    // Three parts but header isn't decodable JSON
    await expect(verifyPrivyAuthToken("!!!!.!!!!.!!!!", FAKE_ENV)).rejects.toThrow();
  });

  it("rejects unsupported alg (we only accept ES256)", async () => {
    // header: {"alg":"HS256","typ":"JWT","kid":"x"}
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "x" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payload = btoa(JSON.stringify({ sub: "did:privy:x" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const sig = "AAAA";
    await expect(verifyPrivyAuthToken(`${header}.${payload}.${sig}`, FAKE_ENV)).rejects.toThrow(/privy_jwt_unsupported_alg/);
  });

  it("errors loudly when PRIVY_APP_ID is unset (not silently allow)", async () => {
    const noAppId = { ...FAKE_ENV, PRIVY_APP_ID: undefined } as any;
    // header: {"alg":"ES256","typ":"JWT","kid":"x"} — must reach the env check
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "x" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payload = btoa(JSON.stringify({ sub: "did:privy:x" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    await expect(verifyPrivyAuthToken(`${header}.${payload}.AAAA`, noAppId)).rejects.toThrow(/privy_app_id_unset/);
  });
});
