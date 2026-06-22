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
import { dlopen, FFIType, CString } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOST = `${process.platform}-${process.arch}`;
const EXT = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";

/** Resolve the VENDORED lib — packaged path first (installed npm), then the dev repo. */
function resolveLib(): string | null {
  const rel = join("vendor", "contract", HOST, `libcontract.${EXT}`);
  const here = import.meta.dir; // src/values when dev, runtime/… when packed
  const candidates = [
    join(here, "..", "..", "packages", "skill", rel), // dev repo
    join(here, "..", "..", rel), // packaged (runtime/ → package root)
    join(here, "..", rel),
    join(process.cwd(), "packages", "skill", rel),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

let lib: ReturnType<typeof dlopen> | null = null;
function load() {
  if (lib) return lib;
  const path = resolveLib();
  if (!path) throw new Error(`contract-native: vendored libcontract.${EXT} for ${HOST} not found (vendor/contract)`);
  lib = dlopen(path, {
    contract_declare: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    contract_get: { args: [FFIType.cstring], returns: FFIType.ptr },
    contract_list: { args: [], returns: FFIType.ptr },
    contract_route: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    contract_energy: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.f64 },
    contract_bible_anchor: { args: [FFIType.cstring], returns: FFIType.i64 },
  });
  return lib;
}

const cstr = (s: string) => Buffer.from(s + "\0");
const readPtr = (p: number | null): string | null => (p ? new CString(p as number).toString() : null);

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
 * Bible-anchor `text` to its single most-relevant verse index — a PURE, stateless, deterministic
 * read of the embedded substrate (no ledger write, no network): same text → same index. Returns
 * the verse index (≥ 0), or null when no anchor was found / the lib errored (−1). Inherently local,
 * so it is safe to call embedded-first on a hot path with a no-op fallback (the field is omitted).
 */
export function bibleAnchorNative(text: string): number | null {
  const idx = load().symbols.contract_bible_anchor(cstr(text)) as number | bigint;
  const n = typeof idx === "bigint" ? Number(idx) : idx;
  return Number.isFinite(n) && n >= 0 ? n : null;
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
