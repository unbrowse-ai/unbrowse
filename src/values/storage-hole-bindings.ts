/**
 * storage-hole-bindings — promote captured credential/storage values (localStorage,
 * sessionStorage, cookies, headers) to first-class SEALED nodes in the requires/yields
 * operation DAG.
 *
 * "Render the structure to all, seal the value to the holder" (Luke 8:17 — the structure
 * comes to light; Heb 9 — the inner value sealed). The global graph shares the dependency
 * SHAPE plus a KEYED COMMITMENT; the secret VALUE is sealed off-graph under the wallet and
 * revealed only locally, per-step, at execution.
 *
 * The on-graph commitment is `uhs1:` + HMAC-SHA256(commitmentKey, plaintext) — a KEYED MAC, not a
 * bare hash. This matters for a SHARED graph: an outsider without the wallet cannot brute-force a
 * low-entropy value's commitment, and equal values do NOT link across installs (different wallet →
 * different commitment). The `uhs1:` sentinel makes a sealed commitment unambiguous, so a legacy
 * plaintext token that merely *looks* like a hash (64 hex chars) is never mistaken for one.
 */
import { createHmac } from "node:crypto";
import { sealValue, revealValue } from "./wallet-seal.js";
import type { OperationBinding, SkillOperationNode, SkillManifest } from "../types/skill.js";
import type { SealedBlobStore } from "./sealed-blob-store.js";

export type StorageHoleKind = "localStorage" | "sessionStorage" | "cookie" | "header";

// Sentinel marking a value as a sealed-hole commitment (unbrowse hole seal, v1). A legacy plaintext
// value never carries it, so the replay resolver can tell sealed from plaintext WITHOUT a fragile
// shape guess (the prior 64-hex heuristic dropped sha256-shaped legacy tokens).
const SENTINEL = "uhs1:";

export interface SealedStorageHole {
  /** YIELDS binding placed on the producing op — carries the (sentinel+MAC) commitment, NEVER the value. */
  binding: OperationBinding;
  /** The sealed blob at rest (sha256-hex header + AES-GCM ciphertext), stored OFF-graph under `commitment`. */
  sealed: Uint8Array;
  /** Off-graph store KEY = HMAC hex (the commitment without the sentinel). */
  commitment: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Keyed on-graph commitment: `uhs1:` + HMAC-SHA256(commitmentKey, plaintext). */
function holeCommitment(value: string, commitmentKey: Uint8Array): string {
  return SENTINEL + createHmac("sha256", Buffer.from(commitmentKey)).update(value, "utf8").digest("hex");
}
/** True if a value is a sealed-hole commitment (carries the sentinel). */
export function isHoleCommitment(v: unknown): boolean {
  return typeof v === "string" && v.startsWith(SENTINEL);
}
/** The off-graph store key for a commitment (strip the sentinel). */
function commitmentStoreKey(commitment: string): string {
  return commitment.startsWith(SENTINEL) ? commitment.slice(SENTINEL.length) : commitment;
}
/** Blob layout: 64-byte sha256-hex header (for GCM reveal) + the AES-GCM ciphertext. */
function packBlob(hashHex: string, sealed: Uint8Array): Uint8Array {
  const hb = enc.encode(hashHex);
  const out = new Uint8Array(hb.length + sealed.length);
  out.set(hb, 0); out.set(sealed, hb.length);
  return out;
}

/**
 * Seal captured storage entries into YIELDS bindings. The plaintext is AES-256-GCM sealed under
 * `sealKey`; the on-graph commitment is the KEYED MAC under `commitmentKey`. Only the commitment lands
 * on the binding/graph — the value lives off-graph in `sealed`. FAIL-CLOSED: any value that can't be
 * sealed is dropped, never stored in plaintext.
 */
export function sealStorageHoles(
  entries: Record<string, string> | undefined,
  sealKey: Uint8Array,
  commitmentKey: Uint8Array,
  kind: StorageHoleKind = "localStorage",
): SealedStorageHole[] {
  const out: SealedStorageHole[] = [];
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    try {
      const { hash, sealed } = sealValue(enc.encode(value), sealKey);
      const graphCommitment = holeCommitment(value, commitmentKey);
      out.push({
        binding: { key, type: kind, source: kind, required: false, commitment: graphCommitment },
        sealed: packBlob(hash, sealed),
        commitment: commitmentStoreKey(graphCommitment),
      });
    } catch {
      // fail-closed: drop unsealable values — never put plaintext on the graph.
    }
  }
  return out;
}

/** A consuming op that needs storage key `key` declares this REQUIRES binding (no value). */
export function requiresStorageBinding(key: string, kind: StorageHoleKind = "localStorage"): OperationBinding {
  return { key, type: kind, source: kind, required: true };
}

/**
 * Value identity of a storage binding (key|type|source) — the producer→consumer match key.
 * Excludes `required` so a producer YIELDS (required:false) links to a consumer REQUIRES (required:true).
 */
export function storageBindingValueIdentity(b: OperationBinding): string {
  return [b.key, b.type ?? "", b.source ?? ""].join("|");
}

/** Find the producer YIELDS binding that satisfies a consumer REQUIRES binding, by value identity. */
export function holeProducedBy(
  consumerRequires: OperationBinding,
  producerYields: OperationBinding[],
): OperationBinding | undefined {
  const id = storageBindingValueIdentity(consumerRequires);
  return producerYields.find((y) => storageBindingValueIdentity(y) === id);
}

/** True if a binding is a sealed credential/storage hole (carries a commitment, no value). */
export function isSealedHoleBinding(b: OperationBinding): boolean {
  return typeof b.commitment === "string" && b.commitment.length > 0 && (b as { value?: unknown }).value === undefined;
}

/**
 * Reveal a sealed storage value — ONLY the holder's seal key opens it (wrong key keeps it sealed via
 * the GCM auth tag). The blob is self-describing (sha256-hex header + ciphertext); the commitment arg
 * is accepted for call-site symmetry. Returns the original plaintext string.
 */
export function revealStorageHole(_commitment: string, sealedBlob: Uint8Array, sealKey: Uint8Array): string {
  const hashHex = dec.decode(sealedBlob.subarray(0, 64));
  const sealed = sealedBlob.subarray(64);
  return dec.decode(revealValue(hashHex, sealed, sealKey));
}

/**
 * Promote a node's captured `page_metadata.localStorage` to SEALED yields bindings on the DAG and
 * SCRUB the plaintext off the node. After this the node carries only commitments (in `provides` and in
 * `page_metadata.localStorage`); the values move off-graph into the returned `sealed` blobs. Pure +
 * fail-closed. The caller supplies the wallet seal + commitment keys — the pure graph builder never sees them.
 */
export function bindSealedStorageHoles(
  node: SkillOperationNode,
  sealKey: Uint8Array,
  commitmentKey: Uint8Array,
): { node: SkillOperationNode; sealed: SealedStorageHole[] } {
  const ls = node.page_metadata?.localStorage;
  if (!ls || Object.keys(ls).length === 0) return { node, sealed: [] };
  const holes = sealStorageHoles(ls, sealKey, commitmentKey, "localStorage");
  if (holes.length === 0) return { node, sealed: [] };

  const seen = new Set(node.provides.map(storageBindingValueIdentity));
  const provides = [...node.provides];
  for (const h of holes) {
    const id = storageBindingValueIdentity(h.binding);
    if (!seen.has(id)) { provides.push(h.binding); seen.add(id); }
  }

  // Scrub: rewrite page_metadata.localStorage to the (sentinel+MAC) commitments — no plaintext on the node.
  const commitments: Record<string, string> = {};
  for (const h of holes) commitments[h.binding.key] = h.binding.commitment!;

  const next: SkillOperationNode = {
    ...node,
    provides,
    page_metadata: { ...(node.page_metadata ?? {}), localStorage: commitments },
  };
  return { node: next, sealed: holes };
}

/**
 * Seal every operation node's `page_metadata.localStorage` in a skill before persistence —
 * commitments onto the graph, sealed blobs into `store`. Fail-closed (a value that can't be sealed has
 * its localStorage STRIPPED, never persisted as plaintext). Idempotent (already-sealed nodes, marked by
 * the sentinel, are skipped). Never throws.
 */
export function sealSkillSnapshotHoles(
  skill: SkillManifest,
  sealKey: Uint8Array,
  commitmentKey: Uint8Array,
  store: SealedBlobStore,
): SkillManifest {
  const ops = skill.operation_graph?.operations;
  if (!ops || ops.length === 0) return skill;
  let changed = false;
  const sealedOps = ops.map((op) => {
    const ls = op.page_metadata?.localStorage;
    if (!ls || Object.keys(ls).length === 0) return op;
    if (Object.values(ls).every((v) => isHoleCommitment(v))) return op; // already sealed
    try {
      const { node, sealed } = bindSealedStorageHoles(op, sealKey, commitmentKey);
      for (const h of sealed) store.put(h.commitment, h.sealed);
      changed = true;
      return node;
    } catch {
      changed = true; // fail-closed: strip plaintext rather than persist it
      return { ...op, page_metadata: { ...(op.page_metadata ?? {}), localStorage: {} } };
    }
  });
  if (!changed) return skill;
  return { ...skill, operation_graph: { ...skill.operation_graph!, operations: sealedOps } };
}

/**
 * Resolve a node's `page_metadata.localStorage` for replay: reveal SENTINEL-marked commitments from the
 * store, pass LEGACY plaintext through unchanged (including sha256-shaped tokens — they lack the
 * sentinel), and DROP a commitment whose blob is missing or won't reveal (graceful). Never throws.
 */
export function resolveLocalStorageForReplay(
  ls: Record<string, string> | undefined,
  sealKey: Uint8Array,
  store: SealedBlobStore,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ls ?? {})) {
    if (typeof v !== "string") continue;
    if (!isHoleCommitment(v)) { out[k] = v; continue; } // legacy plaintext passthrough (sentinel-free)
    const blob = store.get(commitmentStoreKey(v));
    if (!blob) continue; // missing blob → skip (replay degrades gracefully)
    try { out[k] = revealStorageHole(v, blob, sealKey); } catch { /* wrong key / tamper → skip */ }
  }
  return out;
}
