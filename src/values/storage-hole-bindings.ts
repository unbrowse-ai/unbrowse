/**
 * storage-hole-bindings — promote captured credential/storage values (localStorage,
 * sessionStorage, cookies, headers) to first-class SEALED nodes in the requires/yields
 * operation DAG.
 *
 * "Render the structure to all, seal the value to the holder" (Luke 8:17 — the structure
 * comes to light; Heb 9 — the inner value sealed). The global graph shares the dependency
 * SHAPE (this hole exists, here is its producer→consumer edge) plus a COMMITMENT (sha256 of
 * the plaintext); the secret VALUE is sealed off-graph under the wallet (wallet-seal /
 * sealed-ledger) and revealed only locally, per-step, at execution.
 *
 * This module is the representation + sealing + binding half. The runtime chain-walker that
 * unseals per-step at execute is a separate (deeper) track; here a yields/requires binding
 * pair is all the DAG needs to link "login YIELDS this localStorage token" to "this API call
 * REQUIRES it" — without either node ever holding the secret.
 */
import { sealValue, revealValue } from "./wallet-seal.js";
import type { OperationBinding, SkillOperationNode, SkillManifest } from "../types/skill.js";
import type { SealedBlobStore } from "./sealed-blob-store.js";

const COMMITMENT_RE = /^[0-9a-f]{64}$/i;

export type StorageHoleKind = "localStorage" | "sessionStorage" | "cookie" | "header";

export interface SealedStorageHole {
  /** YIELDS binding placed on the producing op — carries the commitment, NEVER the value. */
  binding: OperationBinding;
  /** The sealed blob (value at rest), stored OFF-graph (e.g. sealed-ledger sealedStore). */
  sealed: Uint8Array;
  /** sha256 of the plaintext — the on-graph commitment (== binding.commitment). */
  commitment: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Seal captured storage entries into YIELDS bindings. The plaintext is AES-256-GCM sealed
 * under `sealKey` (32 bytes); only the commitment (sha256 of plaintext) lands on the binding/
 * graph — the value lives off-graph in `sealed`. FAIL-CLOSED: any value that can't be sealed is
 * dropped, never stored in plaintext. Returns one SealedStorageHole per sealable entry.
 */
export function sealStorageHoles(
  entries: Record<string, string> | undefined,
  sealKey: Uint8Array,
  kind: StorageHoleKind = "localStorage",
): SealedStorageHole[] {
  const out: SealedStorageHole[] = [];
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    try {
      const { hash, sealed } = sealValue(enc.encode(value), sealKey);
      out.push({
        binding: { key, type: kind, source: kind, required: false, commitment: hash },
        sealed,
        commitment: hash,
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
 * Deliberately excludes `required` so a producer YIELDS (required:false) links to a consumer
 * REQUIRES (required:true) for the same value (full bindingIdentity would split them).
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
 * Reveal a sealed storage value — ONLY the holder's seal key opens it (wrong key keeps it
 * sealed via the GCM auth tag). Returns the original plaintext string.
 */
export function revealStorageHole(commitment: string, sealed: Uint8Array, sealKey: Uint8Array): string {
  return dec.decode(revealValue(commitment, sealed, sealKey));
}

/**
 * Promote a node's captured `page_metadata.localStorage` to SEALED yields bindings on the DAG and
 * SCRUB the plaintext off the node — the integration that makes a localStorage value a first-class
 * sealed graph node. Today `page_metadata.localStorage` holds plaintext ON the node (a leak); after
 * this the node carries only commitments (in `provides`), the values move off-graph into the returned
 * `sealed` blobs (for the caller's sealed-ledger store), and `page_metadata.localStorage` is rewritten
 * to commitments. Pure + fail-closed: returns a new node; values that can't be sealed are dropped.
 * The caller (capture/persist path) supplies the wallet seal key — the pure graph builder never sees it.
 */
export function bindSealedStorageHoles(
  node: SkillOperationNode,
  sealKey: Uint8Array,
): { node: SkillOperationNode; sealed: SealedStorageHole[] } {
  const ls = node.page_metadata?.localStorage;
  if (!ls || Object.keys(ls).length === 0) return { node, sealed: [] };
  const holes = sealStorageHoles(ls, sealKey, "localStorage");
  if (holes.length === 0) return { node, sealed: [] };

  // Add yields bindings to provides, deduped by value identity.
  const seen = new Set(node.provides.map(storageBindingValueIdentity));
  const provides = [...node.provides];
  for (const h of holes) {
    const id = storageBindingValueIdentity(h.binding);
    if (!seen.has(id)) { provides.push(h.binding); seen.add(id); }
  }

  // Scrub: rewrite page_metadata.localStorage to commitments — no plaintext on the node.
  const commitments: Record<string, string> = {};
  for (const h of holes) commitments[h.binding.key] = h.commitment;

  const next: SkillOperationNode = {
    ...node,
    provides,
    page_metadata: { ...(node.page_metadata ?? {}), localStorage: commitments },
  };
  return { node: next, sealed: holes };
}

/**
 * Seal every operation node's `page_metadata.localStorage` in a skill before persistence —
 * commitments onto the graph, sealed blobs into `store`. The seal-at-persist hook (called from
 * writeSkillSnapshot). Fail-closed: a value that can't be sealed has its localStorage STRIPPED, never
 * persisted as plaintext. Idempotent (already-commitment nodes skipped). Never throws.
 */
export function sealSkillSnapshotHoles(skill: SkillManifest, sealKey: Uint8Array, store: SealedBlobStore): SkillManifest {
  const ops = skill.operation_graph?.operations;
  if (!ops || ops.length === 0) return skill;
  let changed = false;
  const sealedOps = ops.map((op) => {
    const ls = op.page_metadata?.localStorage;
    if (!ls || Object.keys(ls).length === 0) return op;
    if (Object.values(ls).every((v) => COMMITMENT_RE.test(String(v)))) return op; // already sealed
    try {
      const { node, sealed } = bindSealedStorageHoles(op, sealKey);
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
 * Resolve a node's `page_metadata.localStorage` for replay: reveal commitment-shaped values from the
 * store, pass LEGACY plaintext through unchanged, DROP a commitment whose blob is missing or won't
 * reveal (graceful — token simply not injected). Backward-compatible; never throws.
 */
export function resolveLocalStorageForReplay(
  ls: Record<string, string> | undefined,
  sealKey: Uint8Array,
  store: SealedBlobStore,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ls ?? {})) {
    if (typeof v !== "string") continue;
    if (!COMMITMENT_RE.test(v)) { out[k] = v; continue; } // legacy plaintext passthrough
    const blob = store.get(v);
    if (!blob) continue; // missing blob → skip (replay degrades gracefully)
    try { out[k] = revealStorageHole(v, blob, sealKey); } catch { /* wrong key / tamper → skip */ }
  }
  return out;
}
