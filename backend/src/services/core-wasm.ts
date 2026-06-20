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
  fuse_score(ptr: number, len: number): bigint;
  verify(pkPtr: number, sigPtr: number, msgPtr: number, msgLen: number): number;
  zk_verify(
    yPtr: number,
    yLen: number,
    tPtr: number,
    tLen: number,
    sPtr: number,
    sLen: number,
    ctxPtr: number,
    ctxLen: number,
  ): number;
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

/**
 * The (intent, candidate, evidence) inputs the energy scorer consumes — the
 * SAME shape `energyScore` in energy.ts takes. Duplicated structurally here (not
 * imported) so this bridge module depends only on the wasm ABI, not on the TS
 * energy impl.
 */
type EnergyCandidate = { id: number; text: string };
type EnergyEvidence = { dense: number };
interface EnergyResultWasm {
  energy: number;
  witnesses: [number, number];
  agree: boolean;
}

/**
 * Encode the energy input to the JSON shape the WASM `fuse_score` export
 * parses (see wasm.zig EnergyInput): `{ intent, candidate: { text }, dense }`.
 * JSON has no NaN/Infinity literal, so the three IEEE specials pass as the
 * string sentinels the Zig side decodes; an absent/undefined dense omits the
 * field entirely (== TS `evidence.dense === undefined`). This mirrors exactly
 * how unbrowse-core/test/energy-conformance.test.ts builds `wasmInput`.
 */
function energyToInputJson(
  intent: string,
  candidate: EnergyCandidate,
  evidence: EnergyEvidence | undefined,
): string {
  const base: {
    intent: string;
    candidate: { text: string };
    dense?: number | string;
  } = { intent, candidate: { text: candidate.text } };
  const d = evidence?.dense;
  if (typeof d === "number") {
    if (Number.isNaN(d)) base.dense = "NaN";
    else if (d === Infinity) base.dense = "Infinity";
    else if (d === -Infinity) base.dense = "-Infinity";
    else base.dense = d;
  }
  // d === undefined => omit `dense` entirely (TS absent / NaN-guard default 0).
  return JSON.stringify(base);
}

/**
 * Score an (intent, candidate, evidence) triple via the Zig WASM `fuse_score`
 * core. Returns the `{ energy, witnesses, agree }` result, or `null` on ANY
 * failure (wasm not loadable, missing `fuse_score` export, alloc/run failure,
 * malformed JSON out). The caller MUST treat `null` as "use the TS fallback" —
 * the resolve energy-ordering never breaks on a wasm fault. NEVER throws.
 *
 * The Zig port is a bit-for-bit (ε=0) match of energy.ts `energyScore`
 * (witnessed by unbrowse-core/test/energy-conformance.test.ts), so the live
 * ranking is unchanged: this only sources the ordering from the one core.
 */
export function energyScoreViaWasm(
  intent: string,
  candidate: EnergyCandidate,
  evidence: EnergyEvidence | undefined,
): EnergyResultWasm | null {
  const core = loadCore();
  if (!core || typeof core.fuse_score !== "function") return null;
  try {
    const input = new TextEncoder().encode(
      energyToInputJson(intent, candidate, evidence),
    );
    const ptr = core.alloc(input.length || 1);
    if (!ptr) return null;
    if (input.length) new Uint8Array(core.memory.buffer, ptr, input.length).set(input);

    const packed = core.fuse_score(ptr, input.length);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    if (outPtr === 0) return null; // Zig returns 0 on parse/alloc failure.

    // Copy out before any further alloc could move/reuse the buffer.
    const out = new Uint8Array(core.memory.buffer.slice(outPtr, outPtr + outLen));
    const parsed = JSON.parse(new TextDecoder().decode(out)) as {
      energy?: unknown;
      witnesses?: unknown;
      agree?: unknown;
    };
    // Validate the ABI shape; a malformed JSON out is a failure, not a result.
    if (
      typeof parsed.energy !== "number" ||
      !Array.isArray(parsed.witnesses) ||
      parsed.witnesses.length !== 2 ||
      typeof parsed.witnesses[0] !== "number" ||
      typeof parsed.witnesses[1] !== "number" ||
      typeof parsed.agree !== "boolean"
    ) {
      return null;
    }
    return {
      energy: parsed.energy,
      witnesses: [parsed.witnesses[0], parsed.witnesses[1]],
      agree: parsed.agree,
    };
  } catch {
    return null;
  }
}

function hexToBytesOrNull(hex: string): Uint8Array | null {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

/**
 * Verify an ed25519 signature via the Zig WASM `verify` export.
 *
 * `canonicalBytes` are the exact signed message bytes (the canonical declare
 * projection); `sigHex` is the 64-byte hex signature; `pubHex` is the 32-byte
 * hex public key (= wallet_identity). Returns the boolean result, or `null` on
 * ANY load/instantiate/run failure (wasm unavailable, missing `verify` export,
 * malformed hex, wrong byte lengths). The caller MUST treat `null` as "use the
 * Web Crypto fallback" — verification never breaks on a wasm fault.
 *
 * Ed25519 is RFC-8032: the WASM (std.crypto) and Web Crypto produce/accept the
 * identical signature bytes, so a Web-Crypto-signed declare verifies here too.
 */
export function verifyViaWasm(
  canonicalBytes: Uint8Array | string,
  sigHex: string,
  pubHex: string,
): boolean | null {
  const core = loadCore();
  if (!core || typeof core.verify !== "function") return null;
  try {
    const pub = hexToBytesOrNull(pubHex);
    if (!pub || pub.length !== 32) return null;
    const sig = hexToBytesOrNull(sigHex);
    if (!sig || sig.length !== 64) return null;
    const msg =
      typeof canonicalBytes === "string"
        ? new TextEncoder().encode(canonicalBytes)
        : canonicalBytes;

    // Lay all three inputs into linear memory via the bump allocator.
    const pkPtr = core.alloc(pub.length);
    if (!pkPtr) return null;
    new Uint8Array(core.memory.buffer, pkPtr, pub.length).set(pub);

    const sigPtr = core.alloc(sig.length);
    if (!sigPtr) return null;
    new Uint8Array(core.memory.buffer, sigPtr, sig.length).set(sig);

    const msgPtr = core.alloc(msg.length || 1);
    if (!msgPtr) return null;
    if (msg.length) new Uint8Array(core.memory.buffer, msgPtr, msg.length).set(msg);

    return core.verify(pkPtr, sigPtr, msgPtr, msg.length) === 1;
  } catch {
    return null;
  }
}

/**
 * Verify the SCHNORR / Fiat-Shamir algebra leg of a zk credential binding via
 * the Zig WASM `zk_verify` export — `g^s == t * y^e (mod p)` with the FS
 * challenge `e` recomputed from `(G, y, t, ctx)` inside the core. This is the
 * SAME big-integer algebra the TS `verifyBinding` runs, lifted into the one
 * core (proven byte-identical to paper/reference/zk/binding.py both directions
 * by unbrowse-core/test/conformance.test.ts).
 *
 * IMPORTANT — this is the ALGEBRA LEG ONLY. The WASM `zk_verify` ABI takes
 * `(y, t, s, ctx)`; it does NOT carry the binding `root`/`sig`, so it does NOT
 * check the ed25519 wallet-signature leg ("this y belongs to this wallet").
 * The caller (`verifyBinding` in declare-zk.ts) keeps the wallet-sig leg in TS
 * (Web Crypto) and ANDs it with this result, so no security check is dropped.
 *
 * `binding.y` and `proof.{t,s}` are Python-style hex strings ("0x"-prefixed);
 * `proof.ctx` is raw `ctx.hex()` (no 0x). All four are passed to the core as
 * the exact ascii bytes the conformance test passes, since the core re-parses
 * them with the same hex/decimal logic as the reference.
 *
 * Returns the boolean Schnorr result, or `null` on ANY load/instantiate/run
 * failure (wasm unavailable, missing `zk_verify` export, alloc failure). The
 * caller MUST treat `null` as "use the TS fallback" — verification never breaks
 * on a wasm fault. NEVER throws.
 */
export function zkVerifyViaWasm(
  binding: { y: string },
  proof: { t: string; s: string; ctx: string },
): boolean | null {
  const core = loadCore();
  if (!core || typeof core.zk_verify !== "function") return null;
  try {
    const enc = new TextEncoder();
    const yB = enc.encode(binding.y);
    const tB = enc.encode(proof.t);
    const sB = enc.encode(proof.s);
    const ctxB = enc.encode(proof.ctx);

    // Lay each ascii string into linear memory via the bump allocator. A
    // zero-length field (e.g. empty ctx) still needs a valid pointer; alloc(1)
    // keeps the pointer non-zero without writing.
    const lay = (bytes: Uint8Array): number | null => {
      const ptr = core.alloc(bytes.length || 1);
      if (!ptr) return null;
      if (bytes.length) new Uint8Array(core.memory.buffer, ptr, bytes.length).set(bytes);
      return ptr;
    };

    const yPtr = lay(yB);
    if (yPtr === null) return null;
    const tPtr = lay(tB);
    if (tPtr === null) return null;
    const sPtr = lay(sB);
    if (sPtr === null) return null;
    const ctxPtr = lay(ctxB);
    if (ctxPtr === null) return null;

    return (
      core.zk_verify(
        yPtr,
        yB.length,
        tPtr,
        tB.length,
        sPtr,
        sB.length,
        ctxPtr,
        ctxB.length,
      ) === 1
    );
  } catch {
    return null;
  }
}
