/**
 * Best-effort secret-buffer zeroing.
 *
 * Preferred: libsodium memzero, which compiles to a volatile-write asm
 * sequence the optimizer cannot elide.
 *
 * Fallback: `Uint8Array.fill(0)`. Best-effort under V8 — the VM may have
 * copied bytes into hidden strings if anyone called `.toString()` on the
 * buffer. The `no-tostring-on-secret` lint rule (eslint.config.v7-values.cjs)
 * is the enforcement layer; this function is the runtime mitigation.
 *
 * The fallback path emits a ONE-TIME stderr warning on first use so missing
 * `sodium-native` in production is visible (Hab 2:2 — write the vision plain
 * on the tablet, that he may run that readeth it).
 */

type SodiumMemzero = (buf: Uint8Array) => void;

let sodiumMemzero: SodiumMemzero | null = null;
let triedLoad = false;
let warned = false;

function tryLoadSodium(): void {
  if (triedLoad) return;
  triedLoad = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sodium: unknown = require("sodium-native");
    if (
      sodium &&
      typeof sodium === "object" &&
      typeof (sodium as { sodium_memzero?: unknown }).sodium_memzero === "function"
    ) {
      sodiumMemzero = (buf) => {
        (sodium as { sodium_memzero: SodiumMemzero }).sodium_memzero(buf);
      };
    }
  } catch {
    // Fall through to best-effort fill(0) path.
  }
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  try {
    process.stderr.write(
      "[unbrowse-values] sodium-native not available; using best-effort Uint8Array.fill(0) for memzero. " +
        "Install sodium-native for volatile-write zeroing.\n",
    );
  } catch {
    // stderr write failed (e.g. closed in test); silently ignore.
  }
}

/** Zero a buffer in place. Idempotent. Safe to call on already-zeroed bufs. */
export function safeZero(buf: Uint8Array): void {
  tryLoadSodium();
  if (sodiumMemzero) {
    try {
      sodiumMemzero(buf);
      return;
    } catch {
      // Defensive: if the native call throws (mis-sized buf, locked memory,
      // etc.), fall back to fill(0) and never propagate — zeroing must be
      // best-effort-non-throwing so it can sit in a finally clause.
    }
  }
  warnOnce();
  try {
    buf.fill(0);
  } catch {
    // Buffer may be detached (transferred ArrayBuffer); nothing to do.
  }
}

/** True iff the sodium-native fast path is loaded. Exposed for diagnostics. */
export function sodiumAvailable(): boolean {
  tryLoadSodium();
  return sodiumMemzero !== null;
}
