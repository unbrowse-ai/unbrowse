// tests/kv-auth-binding.test.ts
// Witness: the data-bearing caches (resolution cache + session yield store) are bound to
// the VERIFIED auth principal — an authed entry is never replayed cross-principal.
//
// Two-sided falsifier (lewis-brain both-sides check): each cache is probed with the SAME
// principal (must HIT — proves the cache works) AND a DIFFERENT principal + anon (must MISS
// — proves isolation). If binding were absent the cross-principal MISS fails; if binding
// broke the cache the same-principal HIT fails. Only a correct auth-bound KV passes both.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedResolution } from "../src/values/cached-resolution";
import { principalScope, bindPrincipalScope, credentialFromAuthHeaders } from "../src/runtime/principal-scope";
import { recordYields, fillHolesFromYields, type YieldStore } from "../src/runtime/yield-store";
import type { OperationBinding } from "../src/types/skill";

describe("KV bound to the verified auth principal — no cross-auth leak", () => {
  test("principalScope: stable per credential, distinct across credentials, anon for empty", () => {
    expect(principalScope("cred-A")).toBe(principalScope("cred-A"));
    expect(principalScope("cred-A")).not.toBe(principalScope("cred-B"));
    expect(principalScope("")).toBe("anon");
    expect(principalScope(null)).toBe("anon");
    expect(principalScope("cred-A")).not.toBe("anon");
    // non-reversible: the credential text never appears in the scope token
    expect(principalScope("super-secret-bearer")).not.toContain("secret");
  });

  test("bindPrincipalScope: undefined leaves scope untouched; bound namespaces per principal", () => {
    expect(bindPrincipalScope("posts", undefined)).toBe("posts"); // legacy/public unchanged
    expect(bindPrincipalScope("posts", "cred-A")).toBe(`${principalScope("cred-A")}/posts`);
    expect(bindPrincipalScope(undefined, "cred-A")).toBe(principalScope("cred-A"));
    expect(bindPrincipalScope("posts", "cred-A")).not.toBe(bindPrincipalScope("posts", "cred-B"));
  });

  test("credentialFromAuthHeaders: derives a stable principal from auth headers, undefined for none", () => {
    expect(credentialFromAuthHeaders(undefined)).toBeUndefined();
    expect(credentialFromAuthHeaders({})).toBeUndefined();
    expect(credentialFromAuthHeaders({ "content-type": "application/json" })).toBeUndefined(); // non-auth header → public
    const a = credentialFromAuthHeaders({ Authorization: "Bearer AAA" });
    const b = credentialFromAuthHeaders({ Authorization: "Bearer BBB" });
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
    // header order does not fork the principal (sorted)
    expect(credentialFromAuthHeaders({ Authorization: "Bearer X", Cookie: "s=1" }))
      .toBe(credentialFromAuthHeaders({ Cookie: "s=1", Authorization: "Bearer X" }));
  });

  test("wired yield isolation: different auth_headers cannot read each other's yields", () => {
    const store: YieldStore = new Map();
    const sid = "shared-session"; // same session id on purpose — binding must still isolate
    const credA = credentialFromAuthHeaders({ Authorization: "Bearer token-A" });
    const credB = credentialFromAuthHeaders({ Authorization: "Bearer token-B" });
    const provides: OperationBinding[] = [{ key: "token", example_value: "A-derived-secret" } as OperationBinding];
    recordYields(sid, provides, { store, scope: "auth", principal: credA });
    const reqs: OperationBinding[] = [{ key: "token" } as OperationBinding];
    // B presents a DIFFERENT credential but the SAME session_id → still cannot read A's yield.
    const forB = fillHolesFromYields(sid, reqs, {}, { store, scope: "auth", principal: credB });
    expect(forB.filled).toEqual([]);
    // A (same credential) reads its own.
    const forA = fillHolesFromYields(sid, reqs, {}, { store, scope: "auth", principal: credA });
    expect(forA.params.token).toBe("A-derived-secret");
  });

  test("resolution cache: same principal HITS, different principal + anon MISS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvauth-res-"));
    const key = "GET /api/me";
    const ttlMs = 60_000;
    // A resolves an auth-derived private value.
    const A = await cachedResolution({ key, principal: "cred-A", ttlMs, dir, cacheable: () => true, recompute: async () => "A-private" });
    expect(A).toEqual({ value: "A-private", cached: false });
    // SAME principal → HIT (recompute must NOT run) — proves the cache is real.
    let aRan = false;
    const A2 = await cachedResolution({ key, principal: "cred-A", ttlMs, dir, cacheable: () => true, recompute: async () => { aRan = true; return "nope"; } });
    expect(aRan).toBe(false);
    expect(A2).toEqual({ value: "A-private", cached: true });
    // DIFFERENT principal, same intent → MISS (recomputes, never sees A's data).
    let bRan = false;
    const B = await cachedResolution({ key, principal: "cred-B", ttlMs, dir, cacheable: () => true, recompute: async () => { bRan = true; return "B-own"; } });
    expect(bRan).toBe(true);
    expect(B.value).toBe("B-own");
    expect(B.value).not.toBe("A-private");
    // ANON (no credential) → MISS A's authed entry.
    let anonRan = false;
    const anon = await cachedResolution({ key, principal: "", ttlMs, dir, cacheable: () => true, recompute: async () => { anonRan = true; return "anon-own"; } });
    expect(anonRan).toBe(true);
    expect(anon.value).not.toBe("A-private");
  });

  test("yield store: a token yielded by principal A cannot fill principal B's (or anon's) hole", () => {
    const store: YieldStore = new Map();
    const sid = "sess-1";
    const provides: OperationBinding[] = [{ key: "token", example_value: "A-secret-token" } as OperationBinding];
    recordYields(sid, provides, { store, scope: "auth", principal: "cred-A" });
    const reqs: OperationBinding[] = [{ key: "token" } as OperationBinding];
    // SAME principal → the hole fills — proves the yield pipe works.
    const forA = fillHolesFromYields(sid, reqs, {}, { store, scope: "auth", principal: "cred-A" });
    expect(forA.filled).toEqual(["token"]);
    expect(forA.params.token).toBe("A-secret-token");
    // DIFFERENT principal → NO fill (cross-auth isolation).
    const forB = fillHolesFromYields(sid, reqs, {}, { store, scope: "auth", principal: "cred-B" });
    expect(forB.filled).toEqual([]);
    expect(forB.params.token).toBeUndefined();
    // ANON → NO fill.
    const forAnon = fillHolesFromYields(sid, reqs, {}, { store, scope: "auth", principal: "" });
    expect(forAnon.filled).toEqual([]);
  });
});
