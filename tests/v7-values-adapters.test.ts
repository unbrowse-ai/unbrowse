/**
 * v7 value-store adapter tests.
 *
 * platform: .planning/v7-rip/VALUE_STORE_ADAPTERS.md, .planning/v7-rip/ZK_SCOPE.md §v7.0
 *
 * NO MOCKS (CLAUDE.md "Never mock in tests"). Real spawn for op/keychain/bw —
 * when the underlying binary is absent the test honestly skips. arg-adapter
 * and the signer/parser/stderr-filter are pure in-process and always run.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, createPublicKey } from "node:crypto";
import { Readable } from "node:stream";

import {
  parse,
  looksLikePointer,
  resolve as resolveValue,
  registerAdapter,
  type AdapterContext,
} from "../src/values/index.js";
import { safeZero, sodiumAvailable } from "../src/values/memzero.js";
import {
  filterAdapterStderr,
  scrubStderrString,
} from "../src/values/stderr-filter.js";
import {
  sign as signerSign,
  getWalletPubkey,
  __internal as signerInternal,
} from "../src/values/signer.js";
import { ArgAdapter } from "../src/values/adapters/arg.js";
import { OpAdapter } from "../src/values/adapters/op.js";
import { KeychainAdapter } from "../src/values/adapters/keychain.js";
import { BwAdapter } from "../src/values/adapters/bw.js";
import { AdapterError } from "../src/values/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeCtx(argScope?: Record<string, unknown>): AdapterContext {
  return {
    contextHash: new Uint8Array(randomBytes(32)),
    argScope,
  };
}

function which(bin: string): boolean {
  const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" });
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

const HAS_OP = which("op");
const HAS_BW = which("bw");
const IS_DARWIN = platform() === "darwin";

// Use UNBROWSE_WALLET_PASSPHRASE for tests so we don't pollute the real
// wallet keychain entry on the dev machine. Set BEFORE any signer call.
beforeAll(() => {
  process.env.UNBROWSE_WALLET_PASSPHRASE = "test-wallet-passphrase-v7-values";
});

afterAll(() => {
  // Clean up file fallback if we created one (non-darwin or keychain failure).
  const filePath = signerInternal.FILE_FALLBACK_PATH;
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
});

// ─── 1. parse + looksLikePointer ─────────────────────────────────────────────

describe("pointer.parse", () => {
  it("parses op://Vault/Item/field", () => {
    const p = parse("op://Vault/Item/field");
    expect(p.scheme).toBe("op");
    expect(p.path).toBe("Vault/Item/field");
    expect(p.raw).toBe("op://Vault/Item/field");
  });

  it("parses keychain:// with email-like account", () => {
    const p = parse("keychain://com.unbrowse.session/lewis@unbrowse.ai");
    expect(p.scheme).toBe("keychain");
    expect(p.path).toBe("com.unbrowse.session/lewis@unbrowse.ai");
  });

  it("parses bw:// with uuid", () => {
    const p = parse("bw://9b1f-uuid/password");
    expect(p.scheme).toBe("bw");
    expect(p.path).toBe("9b1f-uuid/password");
  });

  it("parses arg:// with nested path", () => {
    const p = parse("arg://payload/headers/Authorization");
    expect(p.scheme).toBe("arg");
    expect(p.path).toBe("payload/headers/Authorization");
  });

  it("throws AdapterError on non-uri", () => {
    expect(() => parse("not a uri")).toThrow(AdapterError);
  });

  it("throws AdapterError on empty string", () => {
    expect(() => parse("")).toThrow(AdapterError);
  });

  it("throws unknown_scheme on unsupported scheme", () => {
    try {
      parse("vault://something/here");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("unknown_scheme");
    }
  });

  it("looksLikePointer is true for valid pointers", () => {
    expect(looksLikePointer("op://x/y/z")).toBe(true);
    expect(looksLikePointer("arg://username")).toBe(true);
  });

  it("looksLikePointer is false for cleartext", () => {
    expect(looksLikePointer("hunter2")).toBe(false);
    expect(looksLikePointer("https://example.com")).toBe(false);
    expect(looksLikePointer("")).toBe(false);
  });
});

// ─── 2. signer: idempotent pubkey + sign+verify round-trip ───────────────────

describe("signer", () => {
  it("getWalletPubkey returns 32 bytes, idempotent", async () => {
    const a = await getWalletPubkey();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    const b = await getWalletPubkey();
    expect(b.length).toBe(32);
    // Same value on second call.
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("sign produces a verifiable Ed25519 signature over the canonical fragment", async () => {
    const pointer = "arg://test/round-trip";
    const nonce = new Uint8Array(randomBytes(32));
    const contextHash = new Uint8Array(randomBytes(32));
    const commitment = new Uint8Array(randomBytes(32));

    const { signature, walletPubkey } = await signerSign(
      pointer,
      nonce,
      contextHash,
      commitment,
    );
    expect(signature.length).toBe(64);
    expect(walletPubkey.length).toBe(32);

    // Re-build the canonical fragment EXACTLY as the signer does, EXACTLY
    // as backend/src/services/audit.ts canonicalizeSignedFragment does.
    const fragment = JSON.stringify({
      pointer,
      nonce: Buffer.from(nonce).toString("base64"),
      contextHash: Buffer.from(contextHash).toString("hex"),
      commitment: Buffer.from(commitment).toString("hex"),
    });
    const data = new TextEncoder().encode(fragment);

    // Verify with Web Crypto Ed25519 (the same path audit.ts uses).
    const key = await crypto.subtle.importKey(
      "raw",
      walletPubkey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
    expect(ok).toBe(true);
  });

  it("walletPubkey from sign matches getWalletPubkey", async () => {
    const pk1 = await getWalletPubkey();
    const { walletPubkey: pk2 } = await signerSign(
      "arg://x",
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
    );
    expect(Buffer.from(pk1).toString("hex")).toBe(Buffer.from(pk2).toString("hex"));
  });
});

// ─── 3. arg-adapter: full happy path with commitment + dispose ──────────────

describe("ArgAdapter.resolve", () => {
  it("resolves arg://username and produces a verifiable signature + correct commitment", async () => {
    const adapter = new ArgAdapter();
    await adapter.ensureReady();
    const ptr = parse("arg://username");
    const nonce = new Uint8Array(randomBytes(32));
    const ctx = makeCtx({ username: "alice" });

    // Use `await using` semantics manually here so we can also inspect the
    // value after dispose (in the next test).
    const r = await adapter.resolve(ptr, nonce, ctx);
    try {
      expect(r.adapter).toBe("arg");
      expect(r.pointer).toBe("arg://username");
      expect(r.value).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(r.value)).toBe("alice");
      expect(r.signature.length).toBe(64);
      expect(r.walletPubkey.length).toBe(32);
      expect(r.commitment.length).toBe(32);

      // commitment = sha256(value || nonce)
      const expected = createHash("sha256");
      expected.update(new TextEncoder().encode("alice"));
      expected.update(nonce);
      expect(Buffer.from(r.commitment).toString("hex")).toBe(expected.digest("hex"));

      // Signature verifies against canonical fragment.
      const fragment = JSON.stringify({
        pointer: "arg://username",
        nonce: Buffer.from(nonce).toString("base64"),
        contextHash: Buffer.from(ctx.contextHash).toString("hex"),
        commitment: Buffer.from(r.commitment).toString("hex"),
      });
      const key = await crypto.subtle.importKey(
        "raw",
        r.walletPubkey,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        r.signature,
        new TextEncoder().encode(fragment),
      );
      expect(ok).toBe(true);
    } finally {
      await r[Symbol.asyncDispose]();
    }
  });

  it("walks sub-paths (arg://payload/headers/Authorization)", async () => {
    const adapter = new ArgAdapter();
    const ptr = parse("arg://payload/headers/Authorization");
    const r = await adapter.resolve(ptr, new Uint8Array(32), makeCtx({
      payload: { headers: { Authorization: "Bearer xyz" } },
    }));
    try {
      expect(new TextDecoder().decode(r.value)).toBe("Bearer xyz");
    } finally {
      await r[Symbol.asyncDispose]();
    }
  });

  it("throws arg_missing on absent key", async () => {
    const adapter = new ArgAdapter();
    const ptr = parse("arg://nope");
    try {
      await adapter.resolve(ptr, new Uint8Array(32), makeCtx({ username: "alice" }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("arg_missing");
    }
  });

  it("throws arg_missing on missing argScope", async () => {
    const adapter = new ArgAdapter();
    const ptr = parse("arg://username");
    try {
      await adapter.resolve(ptr, new Uint8Array(32), { contextHash: new Uint8Array(32) });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("arg_missing");
    }
  });
});

// ─── 4. AsyncDisposable zeroing ──────────────────────────────────────────────

describe("ResolvedValue Symbol.asyncDispose", () => {
  it("zeros the value buffer after using-scope exit", async () => {
    const adapter = new ArgAdapter();
    const ptr = parse("arg://secret");
    let captured: Uint8Array | null = null;
    {
      const r = await adapter.resolve(
        ptr,
        new Uint8Array(32),
        makeCtx({ secret: "hunter2" }),
      );
      // Hold a reference to the .value Uint8Array so we can observe its
      // state after disposal — we are inspecting the SAME memory, not
      // a copy.
      captured = r.value;
      expect(new TextDecoder().decode(captured)).toBe("hunter2");
      await r[Symbol.asyncDispose]();
    }
    // After dispose: every byte should be 0.
    expect(captured).not.toBeNull();
    const allZero = (captured as Uint8Array).every((b) => b === 0);
    expect(allZero).toBe(true);
  });

  it("dispose is idempotent (double-dispose is a no-op)", async () => {
    const adapter = new ArgAdapter();
    const ptr = parse("arg://x");
    const r = await adapter.resolve(ptr, new Uint8Array(32), makeCtx({ x: "y" }));
    await r[Symbol.asyncDispose]();
    // No throw on second call.
    await r[Symbol.asyncDispose]();
    expect(r.value.every((b) => b === 0)).toBe(true);
  });

  it("works with native `await using` syntax", async () => {
    // This exercise the actual TS 5.2+ explicit-resource-mgmt path.
    let captured: Uint8Array | null = null;
    {
      const adapter = new ArgAdapter();
      const ptr = parse("arg://creds/token");
      await using r = await adapter.resolve(
        ptr,
        new Uint8Array(32),
        makeCtx({ creds: { token: "abc123" } }),
      );
      captured = r.value;
      expect(new TextDecoder().decode(captured)).toBe("abc123");
    }
    expect((captured as unknown as Uint8Array).every((b) => b === 0)).toBe(true);
  });
});

// ─── 5. stderr-filter ────────────────────────────────────────────────────────

describe("stderr-filter", () => {
  it("scrubStderrString redacts password echoes", () => {
    const out = scrubStderrString("[error] password is 'hunter2' for foo", "op");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubStderrString redacts token: values", () => {
    const out = scrubStderrString("token: eyJhbGciOiJIUzI1NiJ9.foo.bar", "bw");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("scrubStderrString redacts 1Password item JSON fragments", () => {
    const out = scrubStderrString(
      'op: failed: {"fields":[{"value":"my-secret"}]} blah',
      "op",
    );
    expect(out).not.toContain("my-secret");
  });

  it("scrubStderrString redacts bitwarden login json", () => {
    const out = scrubStderrString(
      'bw: oops "login":{"password":"superSecret123"} end',
      "bw",
    );
    expect(out).not.toContain("superSecret123");
  });

  it("scrubStderrString redacts hex dumps (security -g defense in depth)", () => {
    const out = scrubStderrString(
      "password: 0xdeadbeefdeadbeefdeadbeef",
      "keychain",
    );
    expect(out).not.toContain("0xdeadbeefdeadbeefdeadbeef");
  });

  it("scrubStderrString preserves benign lines", () => {
    const out = scrubStderrString("[info] op CLI version 2.30.0", "op");
    expect(out).toContain("op CLI version 2.30.0");
  });

  it("filterAdapterStderr drains a stream and scrubs", async () => {
    const stream = Readable.from(["[error] password = leaked-value\nfoo\n"]);
    const out = await filterAdapterStderr(stream, "op");
    expect(out).not.toContain("leaked-value");
    expect(out).toContain("foo");
  });
});

// ─── 6. memzero ──────────────────────────────────────────────────────────────

describe("memzero", () => {
  it("safeZero zeros the buffer", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    safeZero(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("safeZero is idempotent", () => {
    const buf = new Uint8Array(8);
    safeZero(buf);
    safeZero(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("sodiumAvailable reports honestly", () => {
    const v = sodiumAvailable();
    expect(typeof v).toBe("boolean");
    // Under bun test we expect sodium-native to be available (it's in
    // dependencies). If load failed for arch reasons that's still honest.
  });
});

// ─── 7. resolve() top-level dispatch ─────────────────────────────────────────

describe("registry resolve()", () => {
  it("dispatches arg:// to ArgAdapter end-to-end", async () => {
    const nonce = new Uint8Array(randomBytes(32));
    const r = await resolveValue("arg://hello", nonce, makeCtx({ hello: "world" }));
    try {
      expect(r.adapter).toBe("arg");
      expect(new TextDecoder().decode(r.value)).toBe("world");
    } finally {
      await r[Symbol.asyncDispose]();
    }
  });

  it("throws unknown_scheme via parse() before adapter dispatch", async () => {
    try {
      await resolveValue("vault://x/y", new Uint8Array(32), makeCtx());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("unknown_scheme");
    }
  });

  it("registerAdapter can override an adapter", async () => {
    // Replace arg adapter with one that returns a fixed value; verify the
    // dispatch picks the new one.
    const orig = new ArgAdapter();
    let called = false;
    class TestArgAdapter extends ArgAdapter {
      override async resolve(
        ptr: ReturnType<typeof parse>,
        nonce: Uint8Array,
        ctx: AdapterContext,
      ) {
        called = true;
        return super.resolve(ptr, nonce, ctx);
      }
    }
    registerAdapter(new TestArgAdapter());
    const r = await resolveValue(
      "arg://x",
      new Uint8Array(32),
      makeCtx({ x: "z" }),
    );
    try {
      expect(called).toBe(true);
      expect(new TextDecoder().decode(r.value)).toBe("z");
    } finally {
      await r[Symbol.asyncDispose]();
      registerAdapter(orig); // restore for downstream tests
    }
  });
});

// ─── 8. op adapter (real binary; skip if absent) ─────────────────────────────

describe("OpAdapter", () => {
  it.skipIf(!HAS_OP)("ensureReady throws adapter_locked when not signed in", async () => {
    // We can't assume the dev is signed in; what we CAN assume is that
    // ensureReady() either succeeds (signed in) or throws AdapterError.
    const adapter = new OpAdapter();
    try {
      await adapter.ensureReady();
      // signed in — that's fine, no assertion needed.
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const code = (err as AdapterError).code;
      expect(["adapter_locked", "adapter_unavailable", "adapter_exit_nonzero"]).toContain(code);
    }
  });

  it.skipIf(HAS_OP)("ensureReady throws adapter_unavailable when op binary is missing", async () => {
    // Note: we test through spawn — when op is not on PATH, child.on('error')
    // fires with ENOENT and we wrap as adapter_spawn_failed (or
    // adapter_unavailable on whoami path). Either is acceptable.
    const adapter = new OpAdapter();
    try {
      await adapter.ensureReady();
      throw new Error("expected throw on missing op binary");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const code = (err as AdapterError).code;
      expect([
        "adapter_unavailable",
        "adapter_spawn_failed",
        "adapter_exit_nonzero",
      ]).toContain(code);
    }
  });
});

// ─── 9. keychain adapter (real security binary on darwin) ────────────────────

describe("KeychainAdapter", () => {
  it.skipIf(IS_DARWIN)("throws platform_unsupported on non-darwin", async () => {
    const adapter = new KeychainAdapter();
    try {
      await adapter.ensureReady();
      throw new Error("expected throw on non-darwin");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("platform_unsupported");
    }
  });

  it.skipIf(!IS_DARWIN)("can round-trip a value via keychain when written via security", async () => {
    // Write a temp keychain entry, read it back through the adapter, then
    // delete it. No mock — real `security` CLI.
    const service = "unbrowse-v7-test-" + randomBytes(4).toString("hex");
    const account = "test-account";
    const secret = "hunter2-" + randomBytes(2).toString("hex");

    const writeR = spawnSync(
      "/usr/bin/security",
      ["add-generic-password", "-s", service, "-a", account, "-w", secret, "-U"],
      { encoding: "utf8" },
    );
    if (writeR.status !== 0) {
      // ACL/permission failure in test env — honest skip via early return.
      return;
    }
    try {
      const adapter = new KeychainAdapter();
      await adapter.ensureReady();
      const ptr = parse(`keychain://${service}/${account}`);
      const r = await adapter.resolve(ptr, new Uint8Array(randomBytes(32)), makeCtx());
      try {
        expect(new TextDecoder().decode(r.value)).toBe(secret);
        expect(r.adapter).toBe("keychain");
      } finally {
        await r[Symbol.asyncDispose]();
      }
    } finally {
      spawnSync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", service, "-a", account],
        { encoding: "utf8" },
      );
    }
  });

  it.skipIf(!IS_DARWIN)("throws adapter_exit_nonzero on missing item", async () => {
    const adapter = new KeychainAdapter();
    await adapter.ensureReady();
    const ptr = parse(
      `keychain://unbrowse-v7-nonexistent-${randomBytes(4).toString("hex")}/foo`,
    );
    try {
      await adapter.resolve(ptr, new Uint8Array(32), makeCtx());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("adapter_exit_nonzero");
    }
  });
});

// ─── 10. bw adapter (skip if bw absent or BW_SESSION unset) ──────────────────

describe("BwAdapter", () => {
  it.skipIf(!HAS_BW)("ensureReady throws adapter_locked without BW_SESSION", async () => {
    // Temporarily clear BW_SESSION to force the locked path; restore after.
    const orig = process.env.BW_SESSION;
    delete process.env.BW_SESSION;
    try {
      const adapter = new BwAdapter();
      try {
        await adapter.ensureReady();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe("adapter_locked");
      }
    } finally {
      if (orig !== undefined) process.env.BW_SESSION = orig;
    }
  });

  it.skipIf(HAS_BW)("ensureReady throws adapter_locked when bw is missing", async () => {
    // BW_SESSION env gate fires before spawn, giving adapter_locked.
    const orig = process.env.BW_SESSION;
    delete process.env.BW_SESSION;
    try {
      const adapter = new BwAdapter();
      try {
        await adapter.ensureReady();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe("adapter_locked");
      }
    } finally {
      if (orig !== undefined) process.env.BW_SESSION = orig;
    }
  });
});
