/**
 * Regression test for vault keytar operation-error fallback.
 *
 * Background (issue #70 follow-up): on macOS, an existing keychain
 * entry whose ACL no longer admits the current process throws an
 * opaque "An unknown error occurred." with `error.stack === undefined`.
 * The old `callKeytar` only treated *binding* errors as recoverable
 * (regex over the message); operation errors propagated upward, so
 * `storeCredential` died and every caller depending on auth-vault state
 * crashed. The Bun-side `test:issue-regressions` pre-release hook was
 * the canary.
 *
 * The hardening: keytar operation errors (any throw that doesn't match
 * the binding-error regex) now fall back to the encrypted file backend
 * for *that call* without permanently disabling keytar for the process.
 *
 * No mocks of keytar itself — we drive the real `setKeytarClientForTests`
 * seam with a stub client that throws the exact macOS shape the bug
 * produced, and assert that `storeCredential` + `getCredential` complete
 * cleanly via the file backend.
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setKeytarClientForTests,
  resetKeytarClientForTests,
  storeCredential,
  getCredential,
} from "../src/vault/index.js";

const cleanupHomes = new Set<string>();

afterEach(() => {
  resetKeytarClientForTests();
  for (const h of cleanupHomes) {
    try { rmSync(h, { recursive: true, force: true }); } catch {}
  }
  cleanupHomes.clear();
});

test("vault: opaque keytar operation error falls back to file backend (no throw)", async () => {
  // Redirect the vault dir into a temp home so we don't touch the dev's
  // real ~/.unbrowse vault during this test.
  const tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-vault-fallback-"));
  cleanupHomes.add(tmpHome);
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    // Real-shape stub: setPassword throws the exact error macOS keytar
    // emits on an ACL-rejected entry (message "An unknown error
    // occurred.", stack undefined).
    setKeytarClientForTests({
      setPassword: async () => {
        const err = new Error("An unknown error occurred.");
        delete (err as { stack?: string }).stack;
        throw err;
      },
      getPassword: async () => {
        const err = new Error("An unknown error occurred.");
        delete (err as { stack?: string }).stack;
        throw err;
      },
      deletePassword: async () => {
        const err = new Error("An unknown error occurred.");
        delete (err as { stack?: string }).stack;
        throw err;
      },
    });

    // The bug: this throws "An unknown error occurred." Pre-fix.
    // The fix: falls back to file backend and completes.
    await storeCredential("linkedin.com-session", JSON.stringify({ token: "abc" }));

    const got = await getCredential("linkedin.com-session");
    expect(got).toBe(JSON.stringify({ token: "abc" }));
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  }
});

test("vault: keytar operation error on read also falls through to file", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-vault-read-"));
  cleanupHomes.add(tmpHome);
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    setKeytarClientForTests({
      setPassword: async () => {
        const err = new Error("An unknown error occurred.");
        delete (err as { stack?: string }).stack;
        throw err;
      },
      getPassword: async () => {
        const err = new Error("An unknown error occurred.");
        delete (err as { stack?: string }).stack;
        throw err;
      },
      deletePassword: async () => false,
    });

    await storeCredential("x.com-token", "raw-token-value");
    // The read must not propagate the keytar throw either; it falls
    // through to the file backend.
    const v = await getCredential("x.com-token");
    expect(v).toBe("raw-token-value");
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  }
});
