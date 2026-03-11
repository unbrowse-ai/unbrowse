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
  resetKeytarClientForTests();
  try {
    await deleteCredential(TEST_ACCOUNT);
  } catch {
    // ignore cleanup failures
  }
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

  it("does not swallow non-binding keytar errors", async () => {
    setKeytarClientForTests({
      setPassword: async () => { throw new Error("Keychain permission denied"); },
      getPassword: async () => null,
      deletePassword: async () => true,
    });

    await expect(storeCredential(TEST_ACCOUNT, "secret")).rejects.toThrow("Keychain permission denied");
    expect(await getCredential(TEST_ACCOUNT)).toBeNull();
  });
});
