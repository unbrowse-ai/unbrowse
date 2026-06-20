/**
 * CLI-side bridge to the single unbrowse-core Zig WASM — the PRODUCER half.
 *
 * The Zig core (../../../unbrowse-core) is the canonical implementation of
 * declare canonicalization AND ed25519 signing (the backend uses the SAME core
 * for canonicalize+verify — backend/src/services/core-wasm.ts). This module
 * lets the CLI's `contract declare` path CANONICALIZE and SIGN through that one
 * core instead of carrying its own duplicate byte-emitter (the exact
 * duplication that caused a real declare-signature bug).
 *
 * It compiles to a wasm32-freestanding reactor exporting
 * `alloc / free / canonicalize / sign / verify / zk_*` over a packed-u64 ABI: a
 * byte-returning export packs (ptr << 32 | len) into one u64, and the caller
 * copies `len` bytes from linear memory at `ptr`.
 *
 * Defensive by construction: ANY failure to load, instantiate, or run the wasm
 * returns `null` and NEVER throws, so the caller can fall back to the pure-TS
 * canonicalization / the node:crypto signer. A wasm fault must never break a
 * declare.
 */

// The default export is the resolved file-path string under bun (the CLI's
// single-binary build embeds the .wasm via Bun's file loader) and a compiled
// WebAssembly.Module on bundlers that pre-compile it. Typed loosely so both
// shapes type-check. Mirrors backend/src/services/core-wasm.ts.
import wasmModule from "../wasm/unbrowse_core.wasm";

/** Canonical declare body — same six fields the backend signs/verifies over. */
export interface CanonicalDeclareBody {
  plan: string;
  action: string;
  parent_id: string | null;
  agent: string | null;
  wallet_identity: string;
  ts: string;
}

interface CoreExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  canonicalize(ptr: number, len: number): bigint;
  sign(skPtr: number, msgPtr: number, msgLen: number): bigint;
  verify(pkPtr: number, sigPtr: number, msgPtr: number, msgLen: number): number;
}

// `undefined` = not yet attempted; `null` = attempted and failed (cache the
// failure so we don't re-pay the load cost on every declare).
let cached: CoreExports | null | undefined = undefined;

function compileModuleSync(): WebAssembly.Module | null {
  try {
    // Bundlers that pre-compile: the import is already a compiled module.
    if (wasmModule instanceof WebAssembly.Module) return wasmModule;

    // bun / node: the import is a path string. Read + compile synchronously.
    if (typeof wasmModule === "string") {
      const req = (import.meta as unknown as { require?: (m: string) => unknown })
        .require;
      if (typeof req !== "function") return null;
      const fs = req("node:fs") as { readFileSync(p: string): Uint8Array };
      const bytes = fs.readFileSync(wasmModule);
      const WasmModule = (WebAssembly as unknown as {
        Module: new (b: BufferSource) => WebAssembly.Module;
      }).Module;
      return new WasmModule(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

function loadCore(): CoreExports | null {
  if (cached !== undefined) return cached;
  try {
    const mod = compileModuleSync();
    if (!mod) {
      cached = null;
      return null;
    }
    const instance = new WebAssembly.Instance(mod, {});
    const e = instance.exports as unknown as CoreExports;
    if (
      typeof e.alloc !== "function" ||
      typeof e.canonicalize !== "function" ||
      typeof e.sign !== "function" ||
      !e.memory
    ) {
      cached = null;
      return null;
    }
    cached = e;
    return e;
  } catch {
    cached = null;
    return null;
  }
}

/**
 * Fixed-order JSON the wasm `canonicalize` export consumes — the SAME six
 * fields, in the SAME order, that the TS canonicalization emits. The Zig side
 * re-serializes them through its own canonicalizer, so the input JSON just
 * needs the values present in field order.
 */
function bodyToInputJson(b: CanonicalDeclareBody): string {
  return JSON.stringify({
    plan: b.plan,
    action: b.action,
    parent_id: b.parent_id,
    agent: b.agent,
    wallet_identity: b.wallet_identity,
    ts: b.ts,
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Canonicalize a declare body via the Zig WASM core.
 *
 * Returns the canonical JSON string, or `null` on ANY failure (wasm not
 * loadable, unsupported runtime, alloc/canonicalize returning 0, decode error).
 * The caller MUST treat `null` as "use the TS fallback" — declares never break
 * on a wasm fault.
 */
export function canonicalizeViaWasm(body: CanonicalDeclareBody): string | null {
  const core = loadCore();
  if (!core) return null;
  try {
    const input = new TextEncoder().encode(bodyToInputJson(body));
    const ptr = core.alloc(input.length);
    if (!ptr) return null;
    new Uint8Array(core.memory.buffer, ptr, input.length).set(input);

    const packed = core.canonicalize(ptr, input.length);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    if (outPtr === 0) return null; // Zig returns 0 on parse/alloc failure.

    // Copy out before any further alloc could move/reuse the buffer.
    const out = new Uint8Array(core.memory.buffer.slice(outPtr, outPtr + outLen));
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}

/**
 * Sign canonical message bytes with an ed25519 secret key via the Zig WASM
 * `sign` export — the PRODUCER half routed through the one core.
 *
 * `secretKeyBytes` is the 64-byte ed25519 SecretKey encoding (32-byte seed ||
 * 32-byte pubkey), exactly as `std.crypto.sign.Ed25519.SecretKey` expects (the
 * same encoding the conformance test feeds). Returns the 64-byte signature as a
 * 128-char hex string, or `null` on ANY failure (wasm unavailable, wrong key
 * length, sign returning 0). The caller MUST treat `null` as "use the
 * node:crypto signer fallback" — signing never breaks on a wasm fault.
 *
 * Ed25519 is RFC-8032: the WASM signature over these exact bytes is
 * indistinguishable from a node:crypto signature over them, and verifies under
 * the backend's verify path either way.
 */
export function signViaWasm(
  canonicalBytes: Uint8Array | string,
  secretKeyBytes: Uint8Array,
): string | null {
  const core = loadCore();
  if (!core || typeof core.sign !== "function") return null;
  try {
    // Zig Ed25519.SecretKey.encoded_length === 64 (seed || pubkey).
    if (secretKeyBytes.length !== 64) return null;
    const msg =
      typeof canonicalBytes === "string"
        ? new TextEncoder().encode(canonicalBytes)
        : canonicalBytes;

    const skPtr = core.alloc(secretKeyBytes.length);
    if (!skPtr) return null;
    new Uint8Array(core.memory.buffer, skPtr, secretKeyBytes.length).set(secretKeyBytes);

    const msgPtr = core.alloc(msg.length || 1);
    if (!msgPtr) return null;
    if (msg.length) new Uint8Array(core.memory.buffer, msgPtr, msg.length).set(msg);

    const packed = core.sign(skPtr, msgPtr, msg.length);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    if (outPtr === 0 || outLen !== 64) return null; // Zig returns 0 on failure.

    const sig = new Uint8Array(core.memory.buffer.slice(outPtr, outPtr + outLen));
    return bytesToHex(sig);
  } catch {
    return null;
  }
}
