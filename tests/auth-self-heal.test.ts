/**
 * Witness for the self-healing auth path (ensureUsableKey) — the Claude-Code
 * auth state machine adapted to unbrowse: validate → refresh-existing-identity
 * → else hand back an actionable onboarding step (never a raw 403, never throw,
 * never loop).
 *
 * These two cases are deterministic, need no backend, and are NON-DESTRUCTIVE
 * (they never call the reset/register-anon path, so the developer's real
 * ~/.unbrowse/config.json is untouched). The full 401/403 → register-anon →
 * retry branch is verified by code + the resolve.ts wiring; it can't be unit-
 * exercised against prod because dirty dev builds hit a separate 426
 * release-attestation gate before any auth logic runs.
 */
import { test, expect } from "bun:test";
import { ensureUsableKey } from "../src/client/index.ts";

test("local-only mode short-circuits to a sentinel key (no network, no reset)", async () => {
  const prev = process.env.UNBROWSE_LOCAL_ONLY;
  process.env.UNBROWSE_LOCAL_ONLY = "1";
  try {
    const r = await ensureUsableKey();
    expect(r.key).toBe("local-only");
    expect(r.refreshed).toBe(false);
    expect(r.onboarding).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.UNBROWSE_LOCAL_ONLY;
    else process.env.UNBROWSE_LOCAL_ONLY = prev;
  }
});

test("offline backend: returns a coherent recovery envelope — never throws, never dead-ends", async () => {
  const prevKey = process.env.UNBROWSE_API_KEY;
  const prevUrl = process.env.UNBROWSE_API_URL;
  const prevLocal = process.env.UNBROWSE_LOCAL_ONLY;
  delete process.env.UNBROWSE_LOCAL_ONLY;
  // A bogus key + unreachable backend — the worst case the resolve path used to
  // dead-end on. Default (non-force) path: validate, tolerate offline, return
  // coherently. It never resets, so real creds are safe.
  process.env.UNBROWSE_API_KEY = "ubr_definitely_invalid_key_for_test";
  process.env.UNBROWSE_API_URL = "http://127.0.0.1:1";
  try {
    const r = await ensureUsableKey();
    expect(typeof r.key).toBe("string");
    expect(typeof r.refreshed).toBe("boolean");
    // Either a usable/offline-tolerated key, or an actionable onboarding step —
    // never an empty key with no guidance, and never a thrown error.
    const coherent = r.key.length > 0 || (!!r.onboarding && r.onboarding.includes("build register"));
    expect(coherent).toBe(true);
  } finally {
    if (prevKey === undefined) delete process.env.UNBROWSE_API_KEY; else process.env.UNBROWSE_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.UNBROWSE_API_URL; else process.env.UNBROWSE_API_URL = prevUrl;
    if (prevLocal !== undefined) process.env.UNBROWSE_LOCAL_ONLY = prevLocal;
  }
});
