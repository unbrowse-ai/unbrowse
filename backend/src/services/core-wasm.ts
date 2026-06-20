/**
 * Bridge to the single unbrowse-core Zig WASM.
 *
 * The Zig core (../../../unbrowse-core) is the canonical implementation of
 * declare canonicalization (and sign/verify/zk). It compiles to a
 * wasm32-freestanding reactor exporting `alloc / canonicalize / ...` over a
 * packed-u64 ABI: a string-returning export packs (ptr << 32 | len) into one
 * u64, and the caller copies `len` bytes from linear memory at `ptr`.
 *
 * This module instantiates that wasm ONCE (lazily, cached) and exposes
 * `canonicalizeViaWasm(body)`. It is defensive by construction: ANY failure to
 * load, instantiate, or run the wasm returns `null` and NEVER throws, so the
 * caller can fall back to the pure-TS canonicalization. A wasm failure must
 * never break a declare.
 *
 * Import shape: `import wasmModule from "../wasm/unbrowse_core.wasm"`.
 *   - On Cloudflare Workers / wrangler v4 the import resolves to a compiled
 *     `WebAssembly.Module` (esbuild bundles the .wasm as a module). We build a
 *     synchronous `WebAssembly.Instance` from it.
 *   - Under bun:test the import resolves to a string path; we read the bytes and
 *     compile synchronously. Both paths are handled below.
 */
import type { CanonicalDeclareBody } from "./declare-signature";

// The default export is a WebAssembly.Module on CF Workers; under bun it is the
// resolved file path string. Typed loosely so both runtimes type-check.
import wasmModule from "../wasm/unbrowse_core.wasm";

interface CoreExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  canonicalize(ptr: number, len: number): bigint;
}

// `undefined` = not yet attempted; `null` = attempted and failed (cache the
// failure so we don't re-pay the load cost on every declare).
let cached: CoreExports | null | undefined = undefined;

function compileModuleSync(): WebAssembly.Module | null {
  try {
    // CF Workers / wrangler: the import is already a compiled module.
    if (wasmModule instanceof WebAssembly.Module) return wasmModule;

    // bun / node: the import is a path string. Read + compile synchronously.
    if (typeof wasmModule === "string") {
      // Lazy `require` so CF Workers (no node:fs) never evaluates this branch.
      // bun/node expose a synchronous `import.meta.require` in ESM; type it
      // locally because `@cloudflare/workers-types` ships no such type.
      // (Same node-builtin-without-types pattern as node:crypto elsewhere here.)
      const req = (import.meta as unknown as { require?: (m: string) => unknown })
        .require;
      if (typeof req !== "function") return null;
      const fs = req("node:fs") as { readFileSync(p: string): Uint8Array };
      const bytes = fs.readFileSync(wasmModule);
      // workers-types models WebAssembly.Module as non-constructible; under bun
      // it is a real constructor, so reach it via the runtime global.
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
    if (typeof e.alloc !== "function" || typeof e.canonicalize !== "function" || !e.memory) {
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
 * fields, in the SAME order, that the TS `canonicalizeDeclareBody` emits. The
 * Zig side re-serializes them through its own canonicalizer, so the input JSON
 * just needs the values present in field order.
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

/**
 * Canonicalize a declare body via the Zig WASM core.
 *
 * Returns the canonical JSON string, or `null` on ANY failure (wasm not
 * loadable, unsupported runtime, alloc/canonicalize returning 0, decode
 * error). The caller MUST treat `null` as "use the TS fallback" — declares
 * never break on a wasm fault.
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
