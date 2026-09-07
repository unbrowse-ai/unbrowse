/**
 * contract-native — the contract substrate, embedded IN-PROCESS in the unbrowse CLI.
 *
 * This is the bottom of the descent: `/contract` is not a subprocess or a cloud call
 * here — libcontract (the Zig substrate, 33 C-ABI symbols) is vendored next to the CLI
 * (packages/skill/vendor/contract/<platform>/libcontract.<ext>, the kuri pattern) and
 * dlopen'd via bun:ffi, so the unbrowse runtime declares/recalls/routes contracts in
 * the same process. The LEDGER stays a pointer (~/.contracts) and the doctrine stays
 * signed-SHA files — the lib carries CODE (a native organ), never the payload.
 *
 * Trusted in-process caller only (the CLI). Arms-length callers use `aiko "<goal>"`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = `${process.platform}-${process.arch}`;
const EXT = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";

const isBun = typeof process !== "undefined" && !!(process as { versions?: { bun?: string } }).versions?.bun;
/**
 * Directory of this module — `src/values` in the dev repo, `runtime/…` when packed.
 *
 * Computed LAZILY, never at module scope. This file is reachable from the
 * Cloudflare Worker bundle (backend/src/services/reverse-engineer/index.ts imports
 * src/orchestrator/dag-feedback.js, which reaches here through client/index.ts →
 * cached-resolution.ts → contract-everything.ts). In the workerd runtime
 * `import.meta.url` is undefined, so calling `fileURLToPath` at module scope threw
 * during Worker startup validation and failed every deploy with
 * `TypeError: The "path" argument must be of type string or an instance of URL`.
 *
 * Deferring it is sufficient and costs nothing: the only consumer is
 * `resolveLib()`, which is only ever reached from `load()` AFTER `bunFfi()` has
 * returned non-null — i.e. under Bun, where `import.meta.url` is always defined.
 * In a Worker `bunFfi()` returns null and `load()` throws first, so this is never
 * evaluated there.
 */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * bun:ffi acquired LAZILY (CLI/Bun-only) — NEVER a static `import ... from "bun:ffi"`.
 * A static top-level import is followed by esbuild INTO the Node CLI bundle (runtime/cli.js),
 * and Node's ESM loader rejects the `bun:` scheme at module-eval time
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME) — crashing every command. A `require()` is left as a
 * runtime call the launcher's Node never executes (guarded by isBun), so the module loads
 * clean under Node and every caller falls through to the cloud/TS fallbacks. (kuri/ffi.ts pattern.)
 */
type BunFfi = {
  dlopen: (path: string, symbols: Record<string, unknown>) => { symbols: Record<string, (...a: unknown[]) => unknown> };
  FFIType: Record<string, unknown>;
  CString: new (p: number) => { toString(): string };
};
let _ffi: BunFfi | null = null;
function bunFfi(): BunFfi | null {
  if (_ffi) return _ffi;
  if (!isBun) return null;
  try {
    _ffi = require("bun:ffi") as BunFfi;
    return _ffi;
  } catch {
    return null;
  }
}

/** Resolve the VENDORED lib — packaged path first (installed npm), then the dev repo. */
function resolveLib(): string | null {
  const rel = join("vendor", "contract", HOST, `libcontract.${EXT}`);
  const here = moduleDir();
  const candidates = [
    join(here, "..", "..", "packages", "skill", rel), // dev repo
    join(here, "..", "..", rel), // packaged (runtime/ → package root)
    join(here, "..", rel),
    join(process.cwd(), "packages", "skill", rel),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

let lib: { symbols: Record<string, (...a: unknown[]) => unknown> } | null = null;
function load() {
  if (lib) return lib;
  const f = bunFfi();
  if (!f) throw new Error("contract-native: bun:ffi unavailable (not running under Bun)");
  const { dlopen, FFIType } = f;
  const path = resolveLib();
  if (!path) throw new Error(`contract-native: vendored libcontract.${EXT} for ${HOST} not found (vendor/contract)`);
  lib = dlopen(path, {
    contract_declare: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    contract_get: { args: [FFIType.cstring], returns: FFIType.ptr },
    contract_list: { args: [], returns: FFIType.ptr },
    contract_route: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    contract_energy: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.f64 },
    contract_embed_1536: { args: [FFIType.cstring], returns: FFIType.ptr },
  });
  return lib;
}

const cstr = (s: string) => Buffer.from(s + "\0");
const readPtr = (p: number | null): string | null => {
  if (!p) return null;
  const f = bunFfi();
  if (!f) return null;
  return new f.CString(p as number).toString();
};

/** Declare a /contract in-process via the embedded substrate. Returns the 8-hex id. */
export function declareNative(plan: string, action: string, parentId?: string, agent?: string): string | null {
  const s = load().symbols;
  const id = s.contract_declare(cstr(plan), cstr(action), parentId ? cstr(parentId) : null, agent ? cstr(agent) : null);
  return readPtr(id as number | null);
}

/** All rows for an id as JSONL. */
export function getNative(id: string): string | null {
  return readPtr(load().symbols.contract_get(cstr(id)) as number | null);
}

/** All declared contracts as `<id>\t<plan>` lines. */
export function listNative(): string | null {
  return readPtr(load().symbols.contract_list() as number | null);
}

/** Route a context to the lowest-energy key (train-on-fire selector). */
export function routeNative(context: string, keysCsv: string): string | null {
  return readPtr(load().symbols.contract_route(cstr(context), cstr(keysCsv)) as number | null);
}

/** Energy (−cosine) of a key against a context. */
export function energyNative(key: string, context: string): number {
  return load().symbols.contract_energy(cstr(key), cstr(context)) as number;
}

/**
 * Embed `text` to a 1536-dim vector via the NATIVE substrate organ — the substrate's own
 * Qwen3-Embedding-4B (llama.cpp :8090) MRL-reduced to 1536 in Zig (embed_server.embed1536),
 * NOT TS math, NOT ollama. The exact dim the emergent RAG store is locked to. Returns the
 * float vector, or null when the lib/symbol is absent OR the embed server is down (the caller
 * falls through to a cloud 1536 path — fail-visible, never a silent bad vector).
 */
export function embed1536Native(text: string): number[] | null {
  let s: ReturnType<typeof load>["symbols"];
  try {
    s = load().symbols;
  } catch {
    return null; // lib not vendored for this platform
  }
  const fn = (s as Record<string, unknown>).contract_embed_1536 as ((t: Buffer) => number | null) | undefined;
  if (!fn) return null; // older vendored lib without the symbol
  const json = readPtr(fn(cstr(text)) as number | null);
  if (!json) return null; // server down / model not loaded
  try {
    const v = JSON.parse(json) as number[];
    return Array.isArray(v) && v.length === 1536 ? v : null;
  } catch {
    return null;
  }
}

/** Is the embedded substrate available in this install? (graceful fallback signal.) */
export function nativeAvailable(): boolean {
  try {
    load();
    return true;
  } catch {
    return false;
  }
}
