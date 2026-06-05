/**
 * src/kuri/ffi.ts — in-process stateless kuri fetch via C-ABI FFI.
 *
 * Loads `libkuri_ffi` (built from kuri's `zig build ffi`) and calls its C-ABI
 * `kuri_fetch(url, mode)` directly — no kuri server, no :8080 daemon, no Bridge,
 * no subprocess. This is the embedded, stateless fetch path: one call in, rendered
 * markdown/html out. Self-first primary; callers fall back to their existing path
 * when the lib isn't present for the platform (graceful: `kuriFfiAvailable()`).
 *
 * Runtime-agnostic: under Bun it uses the built-in `bun:ffi`; under plain Node it
 * uses `koffi` (a prebuilt N-API FFI — no node-gyp). Either way every failure path
 * returns null/false, so the runtime never depends on a particular engine.
 *
 * The shared lib is vendored per-platform at vendor/kuri/<target>/ by CI (same
 * cross-sysroot constraint as the kuri binary); locally it resolves from the
 * submodule dev build (submodules/kuri/zig-out/lib).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const isBun = typeof process !== "undefined" && !!(process as { versions?: { bun?: string } }).versions?.bun;

export type FetchMode = "markdown" | "html";

/** Platform dylib extension, without depending on bun:ffi's `suffix`. */
function libSuffix(): string {
	if (isBun) {
		try {
			return (require("bun:ffi") as { suffix: string }).suffix;
		} catch {
			/* fall through to platform map */
		}
	}
	if (process.platform === "darwin") return "dylib";
	if (process.platform === "win32") return "dll";
	return "so";
}

function platformTarget(): string | null {
	const p = process.platform;
	const a = process.arch;
	if (p === "darwin" && a === "arm64") return "darwin-arm64";
	if (p === "darwin" && a === "x64") return "darwin-x64";
	if (p === "linux" && a === "arm64") return "linux-arm64";
	if (p === "linux" && a === "x64") return "linux-x64";
	if (p === "win32" && a === "x64") return "win-x64";
	return null;
}

function resolveLibPath(): string | null {
	const target = platformTarget();
	const libName = `libkuri_ffi.${libSuffix()}`;
	const candidates = [
		process.env.UNBROWSE_KURI_FFI_LIB,
		join(process.cwd(), "submodules/kuri/zig-out/lib", libName),
		target ? join(moduleDir, "../../vendor/kuri", target, libName) : undefined,
		target ? join(moduleDir, "../../packages/skill/vendor/kuri", target, libName) : undefined,
	].filter((c): c is string => !!c && existsSync(c));
	return candidates[0] ?? null;
}

interface KuriFfi {
	kuri_fetch: (urlPtr: unknown, mode: number) => unknown;
	kuri_free: (ptr: unknown) => void;
	kuri_ffi_abi_version: () => number;
}

// Engine-neutral handle: call kuri_fetch with a NUL-terminated url buffer + mode,
// read the returned C string, then free it. Implemented over bun:ffi or koffi.
interface KuriHandle {
	fetch: (url: string, mode: number) => string | null;
}

let _loaded = false;
let _handle: KuriHandle | null = null;

function loadViaBunFfi(libPath: string): KuriHandle | null {
	try {
		const { dlopen, FFIType, ptr, CString } = require("bun:ffi");
		const lib = dlopen(libPath, {
			kuri_fetch: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
			kuri_free: { args: [FFIType.ptr], returns: FFIType.void },
			kuri_ffi_abi_version: { args: [], returns: FFIType.i32 },
		});
		const symbols = lib.symbols as KuriFfi;
		if (symbols.kuri_ffi_abi_version() !== 1) return null; // ABI mismatch — refuse
		return {
			fetch: (url, mode) => {
				const urlBuf = Buffer.from(`${url}\0`, "utf8");
				const resPtr = symbols.kuri_fetch(ptr(urlBuf), mode);
				if (!resPtr) return null;
				try {
					return new CString(resPtr).toString();
				} finally {
					symbols.kuri_free(resPtr);
				}
			},
		};
	} catch {
		return null;
	}
}

function loadViaKoffi(libPath: string): KuriHandle | null {
	try {
		// Prebuilt N-API FFI (no node-gyp). Absent → graceful null, caller falls back.
		const koffi = require("koffi") as {
			load: (p: string) => { func: (sig: string) => (...a: unknown[]) => unknown };
			decode: (ptr: unknown, type: string) => string;
		};
		const lib = koffi.load(libPath);
		const kuriFetchFn = lib.func("void *kuri_fetch(void *, int)") as (b: Buffer, m: number) => unknown;
		const kuriFreeFn = lib.func("void kuri_free(void *)") as (p: unknown) => void;
		const kuriAbiFn = lib.func("int kuri_ffi_abi_version()") as () => number;
		if (kuriAbiFn() !== 1) return null; // ABI mismatch — refuse
		return {
			fetch: (url, mode) => {
				const urlBuf = Buffer.from(`${url}\0`, "utf8");
				const resPtr = kuriFetchFn(urlBuf, mode);
				if (!resPtr) return null;
				try {
					return koffi.decode(resPtr, "char *");
				} finally {
					kuriFreeFn(resPtr);
				}
			},
		};
	} catch {
		return null;
	}
}

function load(): KuriHandle | null {
	if (_loaded) return _handle;
	_loaded = true;
	const libPath = resolveLibPath();
	if (!libPath) return null;
	_handle = isBun ? loadViaBunFfi(libPath) : loadViaKoffi(libPath);
	return _handle;
}

/** Whether the embedded stateless fetch lib is loaded for this platform. */
export function kuriFfiAvailable(): boolean {
	return !!load();
}

/**
 * Fetch `url` and render it in-process (markdown or raw html). Returns null when
 * the lib is unavailable or the fetch was blocked/failed — callers fall back.
 * Stateless: no daemon, no shared state.
 */
export function kuriFetch(url: string, mode: FetchMode = "markdown"): string | null {
	const handle = load();
	if (!handle) return null;
	return handle.fetch(url, mode === "markdown" ? 0 : 1);
}
