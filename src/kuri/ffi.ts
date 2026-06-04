/**
 * src/kuri/ffi.ts — in-process stateless kuri fetch via Bun FFI.
 *
 * Loads `libkuri_ffi` (built from kuri's `zig build ffi`) and calls its C-ABI
 * `kuri_fetch(url, mode)` directly — no kuri server, no :8080 daemon, no Bridge,
 * no subprocess. This is the embedded, stateless fetch path: one call in, rendered
 * markdown/html out. Self-first primary; callers fall back to their existing path
 * when the lib isn't present for the platform (graceful: `kuriFfiAvailable()`).
 *
 * The shared lib is vendored per-platform at vendor/kuri/<target>/ by CI (same
 * cross-sysroot constraint as the kuri binary); locally it resolves from the
 * submodule dev build (submodules/kuri/zig-out/lib).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export type FetchMode = "markdown" | "html";

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
	// bun:ffi `suffix` is the platform dylib extension (dylib/so/dll).
	let suffix = "dylib";
	try {
		// lazy require so this module is importable even off-Bun (returns null below).
		suffix = (require("bun:ffi") as { suffix: string }).suffix;
	} catch {
		return null;
	}
	const target = platformTarget();
	const libName = `libkuri_ffi.${suffix}`;
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

let _loaded = false;
let _ffi: { symbols: KuriFfi; ptr: (b: Uint8Array) => unknown; CString: new (p: unknown) => { toString(): string } } | null = null;

function load() {
	if (_loaded) return _ffi;
	_loaded = true;
	const libPath = resolveLibPath();
	if (!libPath) return null;
	try {
		const { dlopen, FFIType, ptr, CString } = require("bun:ffi");
		const lib = dlopen(libPath, {
			kuri_fetch: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
			kuri_free: { args: [FFIType.ptr], returns: FFIType.void },
			kuri_ffi_abi_version: { args: [], returns: FFIType.i32 },
		});
		if (lib.symbols.kuri_ffi_abi_version() !== 1) return null; // ABI mismatch — refuse
		_ffi = { symbols: lib.symbols as KuriFfi, ptr, CString };
	} catch {
		_ffi = null;
	}
	return _ffi;
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
	const ffi = load();
	if (!ffi) return null;
	const urlBuf = Buffer.from(`${url}\0`, "utf8");
	const resPtr = ffi.symbols.kuri_fetch(ffi.ptr(urlBuf), mode === "markdown" ? 0 : 1);
	if (!resPtr) return null;
	try {
		return new ffi.CString(resPtr).toString();
	} finally {
		ffi.symbols.kuri_free(resPtr);
	}
}
