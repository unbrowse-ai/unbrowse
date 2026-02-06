/**
 * Unit tests for vault.ts
 *
 * Tests the Vault class through its public API:
 *   - store() / get() — round-trip encryption
 *   - list() — service listing
 *   - has() — existence check
 *   - delete() — removal
 *   - isExpired() — expiration check
 *   - exportAuthJson() — auth.json export
 *
 * Requires macOS (Keychain for vault key) and sqlite3 CLI.
 * Uses a temporary database file that is cleaned up after tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Vault } from "../../vault.js";
import type { VaultEntry } from "../../vault.js";

// Skip entire suite on non-macOS (Keychain dependency)
const isMac = process.platform === "darwin";

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let vault: Vault;
const testDbPath = join(tmpdir(), `vault-test-${randomUUID()}.db`);

beforeAll(() => {
  if (!isMac) return;
  vault = new Vault(testDbPath);
});

afterAll(() => {
  if (!isMac) return;
  vault?.close();
  try {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  } catch {
    // Cleanup best-effort
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Vault", () => {
  it.skipIf(!isMac)("creates database file on construction", () => {
    expect(existsSync(testDbPath)).toBe(true);
  });

  it.skipIf(!isMac)("store and get round-trips credentials", () => {
    vault.store("test-service", {
      baseUrl: "https://api.example.com",
      authMethod: "Bearer Token",
      headers: { Authorization: "Bearer secret123" },
      cookies: { session: "abc123", csrfToken: "xyz" },
      extra: { refreshToken: "refresh456" },
      notes: "Test credential",
    });

    const entry = vault.get("test-service");
    expect(entry).not.toBeNull();
    expect(entry!.service).toBe("test-service");
    expect(entry!.baseUrl).toBe("https://api.example.com");
    expect(entry!.authMethod).toBe("Bearer Token");
    expect(entry!.headers).toEqual({ Authorization: "Bearer secret123" });
    expect(entry!.cookies).toEqual({ session: "abc123", csrfToken: "xyz" });
    expect(entry!.extra).toEqual({ refreshToken: "refresh456" });
    expect(entry!.notes).toBe("Test credential");
  });

  it.skipIf(!isMac)("store with empty optional fields", () => {
    vault.store("minimal-service", {
      baseUrl: "https://min.example.com",
      authMethod: "Cookie",
    });

    const entry = vault.get("minimal-service");
    expect(entry).not.toBeNull();
    expect(entry!.headers).toEqual({});
    expect(entry!.cookies).toEqual({});
    expect(entry!.extra).toEqual({});
    expect(entry!.expiresAt).toBeUndefined();
    expect(entry!.notes).toBeUndefined();
  });

  it.skipIf(!isMac)("upserts on duplicate service name", () => {
    vault.store("upsert-test", {
      baseUrl: "https://v1.example.com",
      authMethod: "API Key",
      headers: { "X-API-Key": "old-key" },
    });

    vault.store("upsert-test", {
      baseUrl: "https://v2.example.com",
      authMethod: "Bearer Token",
      headers: { Authorization: "Bearer new-token" },
    });

    const entry = vault.get("upsert-test");
    expect(entry).not.toBeNull();
    expect(entry!.baseUrl).toBe("https://v2.example.com");
    expect(entry!.authMethod).toBe("Bearer Token");
    expect(entry!.headers).toEqual({ Authorization: "Bearer new-token" });
  });

  it.skipIf(!isMac)("get returns null for nonexistent service", () => {
    const entry = vault.get("nonexistent-service-xyz");
    expect(entry).toBeNull();
  });

  it.skipIf(!isMac)("has returns true for stored service", () => {
    vault.store("has-test", {
      baseUrl: "https://has.example.com",
      authMethod: "Cookie",
    });

    expect(vault.has("has-test")).toBe(true);
  });

  it.skipIf(!isMac)("has returns false for nonexistent service", () => {
    expect(vault.has("nonexistent-has-test")).toBe(false);
  });

  it.skipIf(!isMac)("delete removes a service", () => {
    vault.store("delete-test", {
      baseUrl: "https://delete.example.com",
      authMethod: "Bearer",
    });

    expect(vault.has("delete-test")).toBe(true);
    const deleted = vault.delete("delete-test");
    expect(deleted).toBe(true);
    expect(vault.has("delete-test")).toBe(false);
    expect(vault.get("delete-test")).toBeNull();
  });

  it.skipIf(!isMac)("delete returns true for nonexistent service", () => {
    // SQLite DELETE on nonexistent row succeeds silently
    const result = vault.delete("nonexistent-delete");
    expect(result).toBe(true);
  });

  it.skipIf(!isMac)("list returns all stored services", () => {
    // Store a couple unique services
    vault.store("list-a", {
      baseUrl: "https://a.example.com",
      authMethod: "Cookie",
    });
    vault.store("list-b", {
      baseUrl: "https://b.example.com",
      authMethod: "Bearer",
    });

    const services = vault.list();
    const names = services.map(s => s.service);
    expect(names).toContain("list-a");
    expect(names).toContain("list-b");

    // list should include baseUrl and authMethod
    const a = services.find(s => s.service === "list-a");
    expect(a).toBeDefined();
    expect(a!.baseUrl).toBe("https://a.example.com");
    expect(a!.authMethod).toBe("Cookie");
    expect(a!.updatedAt).toBeDefined();
  });

  it.skipIf(!isMac)("isExpired returns false for non-expiring entries", () => {
    vault.store("no-expire", {
      baseUrl: "https://noexpire.example.com",
      authMethod: "Bearer",
    });

    expect(vault.isExpired("no-expire")).toBe(false);
  });

  it.skipIf(!isMac)("isExpired returns true for past expiration date", () => {
    vault.store("expired-service", {
      baseUrl: "https://expired.example.com",
      authMethod: "Bearer",
      expiresAt: "2020-01-01T00:00:00Z",
    });

    expect(vault.isExpired("expired-service")).toBe(true);
  });

  it.skipIf(!isMac)("isExpired returns false for future expiration date", () => {
    vault.store("future-service", {
      baseUrl: "https://future.example.com",
      authMethod: "Bearer",
      expiresAt: "2099-12-31T23:59:59Z",
    });

    expect(vault.isExpired("future-service")).toBe(false);
  });

  it.skipIf(!isMac)("isExpired returns false for nonexistent service", () => {
    expect(vault.isExpired("nonexistent-expire")).toBe(false);
  });

  it.skipIf(!isMac)("exportAuthJson produces valid JSON with expected fields", () => {
    vault.store("export-test", {
      baseUrl: "https://export.example.com",
      authMethod: "API Key",
      headers: { "X-API-Key": "mykey" },
      cookies: { sid: "sess123" },
      extra: { note: "test" },
    });

    const json = vault.exportAuthJson("export-test");
    expect(json).not.toBeNull();

    const parsed = JSON.parse(json!);
    expect(parsed.service).toBe("export-test");
    expect(parsed.baseUrl).toBe("https://export.example.com");
    expect(parsed.authMethod).toBe("API Key");
    expect(parsed.headers).toEqual({ "X-API-Key": "mykey" });
    expect(parsed.cookies).toEqual({ sid: "sess123" });
    expect(parsed.authInfo).toEqual({ note: "test" });
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.notes).toBeInstanceOf(Array);
  });

  it.skipIf(!isMac)("exportAuthJson returns null for nonexistent service", () => {
    expect(vault.exportAuthJson("nonexistent-export")).toBeNull();
  });

  it.skipIf(!isMac)("handles special characters in service names and values", () => {
    vault.store("service-with'quotes", {
      baseUrl: "https://quotes.example.com",
      authMethod: "Bearer",
      headers: { Authorization: "Bearer token'with\"quotes" },
    });

    const entry = vault.get("service-with'quotes");
    expect(entry).not.toBeNull();
    expect(entry!.headers.Authorization).toBe("Bearer token'with\"quotes");
  });

  it.skipIf(!isMac)("close is safe to call multiple times", () => {
    // close() is a no-op for CLI approach
    expect(() => vault.close()).not.toThrow();
    expect(() => vault.close()).not.toThrow();
  });
});
