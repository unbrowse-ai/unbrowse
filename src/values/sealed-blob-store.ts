/**
 * sealed-blob-store — the persistent OFF-graph vessel for sealed credential/storage values.
 *
 * The firmament between value (below) and structure (above): the graph carries only the
 * sha256 COMMITMENT; the sealed bytes live here, content-addressed by that same commitment.
 * Mirrors the proven `fsBlobStore` (values/resolution-ledger.ts) — one file per hash under the
 * unbrowse home dir — but BINARY (the sealed AES-256-GCM blob is `Uint8Array`, not utf8 text),
 * and key-guarded (a key must be 64-hex sha256, so a hostile commitment can't path-traverse).
 *
 * A value sealed now is revealable later by the same install: the seal key is deterministic
 * (deriveSealKey, HKDF over the persistent wallet seed) and the blob persists on disk here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SealedBlobStore {
  /** Sealed bytes for a commitment, or undefined if absent / bad key. */
  get(valueHash: string): Uint8Array | undefined;
  /** Persist sealed bytes under their sha256 commitment. */
  put(valueHash: string, sealed: Uint8Array): void;
  has(valueHash: string): boolean;
}

/** Canonical on-disk location: ~/.unbrowse/sealed-blobs (the defaultResolutionCacheDir pattern). */
export function defaultSealedBlobDir(): string {
  return join(homedir(), ".unbrowse", "sealed-blobs");
}

// A valid key is exactly a sha256 hex digest — no separators, no traversal. Fail-closed on anything else.
const VALUE_HASH_RE = /^[0-9a-f]{64}$/i;

/** Disk-backed sealed-blob store. Persistent across process/instances (content-addressed files). */
export function fsSealedBlobStore(dir: string = defaultSealedBlobDir()): SealedBlobStore {
  return {
    get(valueHash) {
      if (!VALUE_HASH_RE.test(valueHash)) return undefined;
      const p = join(dir, valueHash.toLowerCase());
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
    },
    put(valueHash, sealed) {
      if (!VALUE_HASH_RE.test(valueHash)) throw new Error("sealed-blob key must be a sha256 hex digest");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, valueHash.toLowerCase()), Buffer.from(sealed));
    },
    has(valueHash) {
      return VALUE_HASH_RE.test(valueHash) && existsSync(join(dir, valueHash.toLowerCase()));
    },
  };
}

/** In-memory variant — same interface, for tests / ephemeral contexts. */
export function memSealedBlobStore(): SealedBlobStore {
  const m = new Map<string, Uint8Array>();
  return {
    get: (h) => (VALUE_HASH_RE.test(h) ? m.get(h.toLowerCase()) : undefined),
    put: (h, s) => { if (!VALUE_HASH_RE.test(h)) throw new Error("sealed-blob key must be a sha256 hex digest"); m.set(h.toLowerCase(), s); },
    has: (h) => VALUE_HASH_RE.test(h) && m.has(h.toLowerCase()),
  };
}
