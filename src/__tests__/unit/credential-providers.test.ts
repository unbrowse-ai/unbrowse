/**
 * Unit tests for credential-providers.ts
 *
 * Tests the exported functions and classes:
 *   - createCredentialProvider() — factory
 *   - lookupCredentials() — URL-to-domain lookup with fallback logic
 *   - buildFormFields() — form selector generation
 *   - KeychainProvider / OnePasswordProvider / VaultCredentialProvider — construction
 *
 * Uses a real in-memory provider (implements CredentialProvider) for
 * testing lookupCredentials without system dependencies.
 */

import { describe, it, expect } from "bun:test";
import {
  createCredentialProvider,
  lookupCredentials,
  buildFormFields,
  KeychainProvider,
  OnePasswordProvider,
  VaultCredentialProvider,
} from "../../credential-providers.js";
import type { CredentialProvider, LoginCredential } from "../../credential-providers.js";

// ── In-memory provider for testing ───────────────────────────────────────────

/**
 * A real CredentialProvider backed by an in-memory map.
 * No mocking — this is a concrete implementation used for testing.
 */
class InMemoryProvider implements CredentialProvider {
  name = "in-memory";
  private creds: Map<string, LoginCredential[]>;

  constructor(entries: Record<string, LoginCredential[]> = {}) {
    this.creds = new Map(Object.entries(entries));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async lookup(domain: string): Promise<LoginCredential[]> {
    return this.creds.get(domain) ?? [];
  }
}

// ── createCredentialProvider ──────────────────────────────────────────────────

describe("createCredentialProvider", () => {
  it("returns KeychainProvider for 'keychain'", () => {
    const provider = createCredentialProvider("keychain");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("keychain");
    expect(provider).toBeInstanceOf(KeychainProvider);
  });

  it("returns OnePasswordProvider for '1password'", () => {
    const provider = createCredentialProvider("1password");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("1password");
    expect(provider).toBeInstanceOf(OnePasswordProvider);
  });

  it("returns VaultCredentialProvider for 'vault' with dbPath", () => {
    const provider = createCredentialProvider("vault", "/tmp/test.db");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("vault");
    expect(provider).toBeInstanceOf(VaultCredentialProvider);
  });

  it("returns null for 'vault' without dbPath", () => {
    const provider = createCredentialProvider("vault");
    expect(provider).toBeNull();
  });

  it("returns auto-detect provider for 'auto'", () => {
    const provider = createCredentialProvider("auto");
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("auto");
  });

  it("returns null for 'none'", () => {
    const provider = createCredentialProvider("none");
    expect(provider).toBeNull();
  });

  it("returns null for undefined", () => {
    const provider = createCredentialProvider(undefined);
    expect(provider).toBeNull();
  });

  it("returns null for unrecognized values", () => {
    expect(createCredentialProvider("bitwarden")).toBeNull();
    expect(createCredentialProvider("lastpass")).toBeNull();
    expect(createCredentialProvider("")).toBeNull();
  });
});

// ── lookupCredentials ────────────────────────────────────────────────────────

describe("lookupCredentials", () => {
  it("looks up by full hostname", async () => {
    const provider = new InMemoryProvider({
      "github.com": [{
        username: "user1",
        password: "pass1",
        source: "vault",
      }],
    });

    const result = await lookupCredentials(provider, "https://github.com/login");
    expect(result).not.toBeNull();
    expect(result!.username).toBe("user1");
  });

  it("strips www. prefix and retries", async () => {
    const provider = new InMemoryProvider({
      "example.com": [{
        username: "user2",
        password: "pass2",
        source: "vault",
      }],
    });

    const result = await lookupCredentials(provider, "https://www.example.com/login");
    expect(result).not.toBeNull();
    expect(result!.username).toBe("user2");
  });

  it("falls back to base domain for subdomains", async () => {
    const provider = new InMemoryProvider({
      "github.com": [{
        username: "user3",
        password: "pass3",
        source: "keychain",
      }],
    });

    const result = await lookupCredentials(provider, "https://login.github.com/sso");
    expect(result).not.toBeNull();
    expect(result!.username).toBe("user3");
  });

  it("returns null when no credentials found", async () => {
    const provider = new InMemoryProvider({});
    const result = await lookupCredentials(provider, "https://unknown.com");
    expect(result).toBeNull();
  });

  it("returns first match when multiple credentials exist", async () => {
    const provider = new InMemoryProvider({
      "github.com": [
        { username: "first", password: "p1", source: "keychain" },
        { username: "second", password: "p2", source: "vault" },
      ],
    });

    const result = await lookupCredentials(provider, "https://github.com");
    expect(result!.username).toBe("first");
  });

  it("returns null for invalid URLs", async () => {
    const provider = new InMemoryProvider({});
    const result = await lookupCredentials(provider, "not-a-url");
    expect(result).toBeNull();
  });

  it("prefers full hostname match over base domain", async () => {
    const provider = new InMemoryProvider({
      "auth.example.com": [{
        username: "auth-user",
        password: "auth-pass",
        source: "vault",
      }],
      "example.com": [{
        username: "base-user",
        password: "base-pass",
        source: "vault",
      }],
    });

    const result = await lookupCredentials(provider, "https://auth.example.com/login");
    expect(result!.username).toBe("auth-user");
  });

  it("uses hostname (without port) for lookup", async () => {
    // URL.hostname strips the port, so credentials must be keyed by hostname alone
    const provider = new InMemoryProvider({
      "localhost": [{
        username: "dev",
        password: "devpass",
        source: "vault",
      }],
    });

    const result = await lookupCredentials(provider, "http://localhost:3000/login");
    expect(result).not.toBeNull();
    expect(result!.username).toBe("dev");
  });
});

// ── buildFormFields ──────────────────────────────────────────────────────────

describe("buildFormFields", () => {
  it("returns selectors for username and password", () => {
    const cred: LoginCredential = {
      username: "testuser",
      password: "testpass",
      source: "vault",
    };

    const fields = buildFormFields(cred);
    const keys = Object.keys(fields);
    expect(keys).toHaveLength(2);

    // Username selector should map to username value
    const usernameSelector = keys.find(k => k.includes("username") || k.includes("email"));
    expect(usernameSelector).toBeDefined();
    expect(fields[usernameSelector!]).toBe("testuser");

    // Password selector should map to password value
    const passwordSelector = keys.find(k => k.includes("password"));
    expect(passwordSelector).toBeDefined();
    expect(fields[passwordSelector!]).toBe("testpass");
  });

  it("includes common input selectors", () => {
    const cred: LoginCredential = {
      username: "user@example.com",
      password: "p@ss",
      source: "keychain",
    };

    const fields = buildFormFields(cred);
    const keys = Object.keys(fields);

    // Username field should include email-type selectors
    const usernameKey = keys.find(k => k.includes('type="email"'));
    expect(usernameKey).toBeDefined();

    // Password field should include password-type selectors
    const passwordKey = keys.find(k => k.includes('type="password"'));
    expect(passwordKey).toBeDefined();
  });

  it("includes autocomplete attribute selectors", () => {
    const fields = buildFormFields({
      username: "u",
      password: "p",
      source: "vault",
    });

    const keys = Object.keys(fields);
    const usernameKey = keys.find(k => k.includes('autocomplete="username"'));
    expect(usernameKey).toBeDefined();

    const passwordKey = keys.find(k => k.includes('autocomplete="current-password"'));
    expect(passwordKey).toBeDefined();
  });
});

// ── Provider construction ────────────────────────────────────────────────────

describe("KeychainProvider", () => {
  it("has name 'keychain'", () => {
    const provider = new KeychainProvider();
    expect(provider.name).toBe("keychain");
  });

  it("implements CredentialProvider interface", () => {
    const provider = new KeychainProvider();
    expect(typeof provider.isAvailable).toBe("function");
    expect(typeof provider.lookup).toBe("function");
    expect(typeof provider.store).toBe("function");
  });
});

describe("OnePasswordProvider", () => {
  it("has name '1password'", () => {
    const provider = new OnePasswordProvider();
    expect(provider.name).toBe("1password");
  });

  it("implements CredentialProvider interface", () => {
    const provider = new OnePasswordProvider();
    expect(typeof provider.isAvailable).toBe("function");
    expect(typeof provider.lookup).toBe("function");
  });

});

describe("VaultCredentialProvider", () => {
  it("has name 'vault'", () => {
    const provider = new VaultCredentialProvider("/tmp/nonexistent.db");
    expect(provider.name).toBe("vault");
  });

  it("implements CredentialProvider interface", () => {
    const provider = new VaultCredentialProvider("/tmp/nonexistent.db");
    expect(typeof provider.isAvailable).toBe("function");
    expect(typeof provider.lookup).toBe("function");
    expect(typeof provider.store).toBe("function");
  });

  it("isAvailable returns false for nonexistent path", async () => {
    const provider = new VaultCredentialProvider("/tmp/nonexistent-path-that-does-not-exist.db");
    expect(await provider.isAvailable()).toBe(false);
  });
});
