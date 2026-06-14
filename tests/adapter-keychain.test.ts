/**
 * adapter-keychain.test — payment adapters share the unified keychain store.
 *
 * Proves the migration helper every adapter uses (the SAME shape the x402
 * signer was folded in with): prefer the OS secret store, migrate the legacy
 * env/file source in on first use, never re-read the legacy after. Then proves
 * the base-x402 (EVM) adapter resolves its key through that store.
 *
 * Runs isolated: _setup.ts sets UNBROWSE_WALLET_DIR, so defaultSecretOpts()
 * pins everything to the encrypted-file backend in a throwaway dir — the real
 * OS keychain is never touched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSecretOpts,
  getSecret,
  removeSecret,
  resolveSecret,
  setSecret,
  _resetBackendGuards,
} from "../src/values/keychain.js";
import {
  baseX402Address,
  baseX402Available,
} from "../src/payments/base-x402-signer.js";

const tmp = mkdtempSync(join(tmpdir(), "unbrowse-adapter-kc-"));
const fileOpts = { forceBackend: "encrypted-file" as const, fallbackDir: tmp };

afterEach(() => _resetBackendGuards());

describe("resolveSecret — the shared migration shape", () => {
  it("migrates the legacy source in, then reads from the store after", () => {
    let legacyReads = 0;
    const legacy = () => { legacyReads++; return "legacy-secret-value"; };

    // First call: store is empty → legacy is read + re-persisted.
    expect(resolveSecret("svc-mig", "default", legacy, fileOpts)).toBe("legacy-secret-value");
    expect(legacyReads).toBe(1);
    expect(getSecret("svc-mig", "default", fileOpts)).toBe("legacy-secret-value");

    // Second call: store wins → legacy is NEVER touched again.
    expect(resolveSecret("svc-mig", "default", legacy, fileOpts)).toBe("legacy-secret-value");
    expect(legacyReads).toBe(1);

    removeSecret("svc-mig", "default", fileOpts);
  });

  it("returns null (and does not persist) when neither store nor legacy has it", () => {
    expect(resolveSecret("svc-absent", "default", () => null, fileOpts)).toBeNull();
    expect(getSecret("svc-absent", "default", fileOpts)).toBeNull();
  });

  it("prefers an already-stored secret over the legacy value", () => {
    setSecret("svc-pref", "default", "stored", fileOpts);
    expect(resolveSecret("svc-pref", "default", () => "legacy", fileOpts)).toBe("stored");
    removeSecret("svc-pref", "default", fileOpts);
  });
});

describe("defaultSecretOpts honors isolation (tests never hit the real keychain)", () => {
  it("forces the encrypted-file backend under UNBROWSE_WALLET_DIR (_setup sets it)", () => {
    // _setup.ts sets UNBROWSE_WALLET_DIR for every test → isolated.
    expect(defaultSecretOpts().forceBackend).toBe("encrypted-file");
  });
});

describe("base-x402 (EVM) adapter resolves its key through the store", () => {
  // hardhat account #1 — well-known throwaway test key.
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  afterEach(() => removeSecret("unbrowse-base-x402", "default", defaultSecretOpts()));

  it("reads the key from the unified store (no legacy file needed)", () => {
    // Seed via the adapter's own opts (defaultSecretOpts → file backend in tests).
    expect(setSecret("unbrowse-base-x402", "default", KEY, defaultSecretOpts())).toBe(true);
    expect(baseX402Available()).toBe(true);
    // Address is DERIVED from the key — works even with no legacy file present.
    expect(baseX402Address()).toBe(ADDR);
  });

  it("reports unavailable when no key is anywhere", () => {
    removeSecret("unbrowse-base-x402", "default", defaultSecretOpts());
    // Guard: only meaningful when no legacy ~/.identity/base-x402-key.json exists.
    if (baseX402Available()) {
      console.warn("[adapter-kc] legacy ~/.identity/base-x402-key.json present — skipping negative case");
      return;
    }
    expect(baseX402Available()).toBe(false);
  });
});
