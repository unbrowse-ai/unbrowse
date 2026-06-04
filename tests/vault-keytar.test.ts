import { afterEach, describe, expect, it } from "bun:test";
import {
  deleteCredential,
  getCredential,
  normalizeKeytarModule,
  resetKeytarClientForTests,
  setKeytarClientForTests,
  storeCredential,
} from "../src/vault/index.js";

const TEST_ACCOUNT = "test:keytar-runtime-fallback";

afterEach(async () => {
  setKeytarClientForTests(null);
  try {
    await deleteCredential(TEST_ACCOUNT);
  } catch {
    // ignore cleanup failures
  }
  resetKeytarClientForTests();
});

describe("normalizeKeytarModule", () => {
  it("accepts direct keytar-shaped modules", () => {
    const fn = async () => {};
    expect(normalizeKeytarModule({
      setPassword: fn,
      getPassword: async () => null,
      deletePassword: async () => true,
    })).not.toBeNull();
  });

  it("accepts default-exported keytar modules", () => {
    const fn = async () => {};
    expect(normalizeKeytarModule({
      default: {
        setPassword: fn,
        getPassword: async () => null,
        deletePassword: async () => true,
      },
    })).not.toBeNull();
  });

  it("unwraps nested default-exported keytar modules", () => {
    const fn = async () => {};
    expect(normalizeKeytarModule({
      default: {
        default: {
          setPassword: fn,
          getPassword: async () => null,
          deletePassword: async () => true,
        },
      },
    })).not.toBeNull();
  });

  it("rejects partial modules", () => {
    expect(normalizeKeytarModule({ default: { getPassword: async () => null } })).toBeNull();
  });
});

describe("vault keytar fallback", () => {
  it("stores credentials in one keychain vault item", async () => {
    const keychain = new Map<string, string>();
    const setAccounts: string[] = [];

    setKeytarClientForTests({
      setPassword: async (_service, account, password) => {
        setAccounts.push(account);
        keychain.set(account, password);
      },
      getPassword: async (_service, account) => keychain.get(account) ?? null,
      deletePassword: async (_service, account) => keychain.delete(account),
    });

    await storeCredential(TEST_ACCOUNT, "secret");
    await storeCredential("test:second-keytar-runtime-fallback", "second");

    expect(setAccounts.every((account) => account === "__unbrowse_vault_v1")).toBe(true);
    expect(keychain.has(TEST_ACCOUNT)).toBe(false);
    expect(await getCredential(TEST_ACCOUNT)).toBe("secret");
    expect(await getCredential("test:second-keytar-runtime-fallback")).toBe("second");
  });

  it("migrates legacy per-account keychain items into the single vault item", async () => {
    const legacy = JSON.stringify({
      value: "legacy-secret",
      stored_at: new Date().toISOString(),
    });
    const keychain = new Map<string, string>([[TEST_ACCOUNT, legacy]]);

    setKeytarClientForTests({
      setPassword: async (_service, account, password) => {
        keychain.set(account, password);
      },
      getPassword: async (_service, account) => keychain.get(account) ?? null,
      deletePassword: async (_service, account) => keychain.delete(account),
    });

    expect(await getCredential(TEST_ACCOUNT)).toBe("legacy-secret");
    expect(keychain.has(TEST_ACCOUNT)).toBe(false);
    expect(keychain.has("__unbrowse_vault_v1")).toBe(true);
  });

  it("falls back to the encrypted file vault when keytar fails at runtime", async () => {
    const nativeBindingError = new Error("Cannot find module '../build/Release/keytar.node'");
    setKeytarClientForTests({
      setPassword: async () => { throw nativeBindingError; },
      getPassword: async () => { throw nativeBindingError; },
      deletePassword: async () => { throw nativeBindingError; },
    });

    await storeCredential(TEST_ACCOUNT, "secret");

    expect(await getCredential(TEST_ACCOUNT)).toBe("secret");
    await deleteCredential(TEST_ACCOUNT);
    expect(await getCredential(TEST_ACCOUNT)).toBeNull();
  });

  it("falls back when keytar methods are not functions", async () => {
    // Simulates the case where normalizeKeytarModule passes type checks
    // but the native binding is broken at runtime
    const notAFunctionError = new TypeError("keytar.setPassword is not a function");
    setKeytarClientForTests({
      setPassword: async () => { throw notAFunctionError; },
      getPassword: async () => { throw notAFunctionError; },
      deletePassword: async () => { throw notAFunctionError; },
    });

    await storeCredential(TEST_ACCOUNT, "secret");
    expect(await getCredential(TEST_ACCOUNT)).toBe("secret");
    await deleteCredential(TEST_ACCOUNT);
    expect(await getCredential(TEST_ACCOUNT)).toBeNull();
  });

  it("falls back to the file backend on a non-binding keytar operation error (Issue #70), never an auth-breaking throw", async () => {
    // A keychain ACL / permission failure must NOT propagate — Issue #70: an
    // opaque macOS ACL error on a previously-created entry threw out of
    // storeCredential and killed every caller depending on auth-vault state.
    // The fix routes operation-level errors to the encrypted file backend for
    // that call. This test pins that contract: storeCredential RESOLVES (writes
    // to the file) rather than rejecting.
    setKeytarClientForTests({
      setPassword: async () => { throw new Error("Keychain permission denied"); },
      getPassword: async () => null,
      deletePassword: async () => true,
    });

    await expect(storeCredential(TEST_ACCOUNT, "secret")).resolves.toBeUndefined();
    await deleteCredential(TEST_ACCOUNT);
  });
});
