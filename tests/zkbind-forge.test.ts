/**
 * SECURITY: zkbind commitment forge resistance.
 *
 * `looksLikeSecret(key, value)` in src/publish/sanitize.ts admits a value as
 * NOT-a-secret if it "looks like" a wallet-bound commitment `zkbind:y.root.sig`.
 * The current gate (`isBoundCommitment`) verifies only the SHAPE — starts with
 * "zkbind:" and has exactly 3 non-empty dot parts. That is a BYPASS: an attacker
 * can wrap a raw secret as `zkbind:<rawsecret>.x.y` and the gate admits it.
 *
 * These tests assert the SECURE (hardened) behavior. They should PASS once the
 * gate validates the cryptographic shape of each part (real minted commitments
 * admitted; forged / malformed ones rejected). Run:
 *   bun test tests/zkbind-forge.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the wallet to a throwaway dir so minting a real commitment never
// touches the real macOS keychain / ~/.unbrowse. MUST be set before any import
// that loads the signer.
process.env.UNBROWSE_WALLET_DIR = mkdtempSync(join(tmpdir(), "zkbind-forge-"));
process.env.UNBROWSE_WALLET_PASSPHRASE = "zkbind-forge-test";

import { looksLikeSecret } from "../src/publish/sanitize.js";
import { holeifyIds } from "../src/capture/zk-bound-hole.js";

// A real Solana address (base58, 44 chars) — the kind of identity value the
// corroboration path actually holeifies.
const REAL_ID = "9hCmWfZeWHEnjvgzMwx4suzVyGv4bgTbrdvZGoq5D2zg";

// Secret-shaped raw values (each independently trips looksLikeSecret on its own).
const RAW_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ";
const RAW_BASE64_50 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJj"; // 51 base64 chars

let realTag: string;
let parts: string[];

beforeAll(async () => {
  const out = await holeifyIds([REAL_ID]);
  realTag = out[0];
  expect(typeof realTag).toBe("string");
  expect(realTag.startsWith("zkbind:")).toBe(true);
  parts = realTag.slice("zkbind:".length).split(".");
  expect(parts.length).toBe(3);
});

describe("zkbind forge resistance", () => {
  // 1. A real minted commitment IS admitted (not flagged as a secret).
  test("real minted commitment is admitted (not a secret)", () => {
    expect(looksLikeSecret("submitter_agent_ids", realTag)).toBe(false);
  });

  // 4. The three parts of a genuine commitment have the expected crypto shape.
  //    Pin these so the hardened gate's expectations are anchored on a REAL tag.
  test("genuine commitment parts are hex of the expected shape", () => {
    const [y, root, sig] = parts;
    const HEX = /^[0-9a-f]+$/;
    // root = ed25519 wallet pubkey = 32 bytes = 64 hex chars
    expect(root).toMatch(HEX);
    expect(root.length).toBe(64);
    // sig = ed25519 signature = 64 bytes = 128 hex chars
    expect(sig).toMatch(HEX);
    expect(sig.length).toBe(128);
    // y = g^x mod p over the 2048-bit MODP group: long lowercase hex (no 0x).
    expect(y).toMatch(HEX);
    expect(y.length).toBeGreaterThanOrEqual(64);
  });

  // 2. FORGE — a raw secret smuggled into the y-slot must NOT be admitted.
  describe("forged: raw secret in the y-slot is still flagged as a secret", () => {
    test("JWT smuggled as y, with plausible root/sig-length tail", () => {
      // 64-hex root + 128-hex sig tail so a length-only gate would still need to
      // reject on the y-slot's non-crypto shape.
      const root = "a".repeat(64);
      const sig = "b".repeat(128);
      const forged = `zkbind:${RAW_JWT}.${root}.${sig}`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });

    test("long base64 secret smuggled as y", () => {
      const forged = `zkbind:${RAW_BASE64_50}.abcd.ef01`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });

    test("bare 3-part shape with short non-crypto tail is not a free pass", () => {
      // The original bypass: ANY 3 non-empty dot parts. Wrap a raw secret and
      // append two trivial parts; a shape-only gate admits this.
      const forged = `zkbind:${RAW_JWT}.x.y`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });
  });

  // 3. MALFORMED — non-hex / wrong-arity / empty / too-short parts are NOT
  //    admitted as a valid commitment (so they fall through to the secret gate;
  //    here we assert they are NOT treated as a safe commitment by checking that
  //    a malformed tag wrapping a real secret stays flagged).
  describe("malformed commitments are not admitted as valid", () => {
    test("non-hex components wrapping a secret stay flagged", () => {
      // root/sig made of non-hex chars (g,z) — not a real ed25519 hex pubkey/sig.
      const forged = `zkbind:${RAW_JWT}.zzzzzz.gggggg`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });

    test("wrong number of parts (4) wrapping a secret stays flagged", () => {
      const root = "a".repeat(64);
      const sig = "b".repeat(128);
      const forged = `zkbind:${RAW_JWT}.${root}.${sig}.extra`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });

    test("absurdly short root/sig wrapping a secret stays flagged", () => {
      const forged = `zkbind:${RAW_JWT}.ab.cd`;
      expect(looksLikeSecret("submitter_agent_ids", forged)).toBe(true);
    });
  });
});
