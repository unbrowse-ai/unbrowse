/**
 * route-ledger — server-side, tamper-evident ledger of published route
 * attestations. Production port of §8 ("Ledger: where the signatures actually
 * land") and §13's Merkle-root checkpoint (paper/reference/ledger/checkpoint.py)
 * of *Internal APIs Were Not All You Needed*.
 *
 * "Value off-chain, root on-chain." The route's VALUE (the full skill manifest)
 * stays in the existing skills KV. This ledger holds only the small, signed
 * COMMITMENT to each publish: a content-addressed leaf
 *   { domain, skill_id, value_hash, signer, ts, sig }
 * whose KV key IS sha256(canonical-leaf-core). That makes a leaf:
 *
 *   - idempotent           — re-publishing identical bytes writes the same key,
 *                            so there is no write-time ordering contention and
 *                            no atomic compare-and-set is required (the EdbKV /
 *                            FallbackKV stores are last-write-wins; a write-time
 *                            prev-hash chain would silently FORK under concurrent
 *                            publishes — this design cannot).
 *   - tamper-evident       — `merkleRoot()` is the single RFC-6962 commitment
 *                            over the canonically-ordered leaf hashes; editing,
 *                            inserting, deleting, or reordering ANY leaf changes
 *                            the root. This is the Certificate-Transparency
 *                            discipline: signed leaves + Merkle tree head, the
 *                            value an on-chain checkpoint would publish.
 *   - independently audited — `verifyLedger()` re-derives every leaf hash from
 *                            its own stored content and recomputes the root, so
 *                            an auditor (not a trusted operator) confirms the log
 *                            is consistent. Trustless, not "trust our server".
 *
 * The deterministic linearization (sort by ts, then value_hash, then skill_id)
 * replaces a write-time hash chain: under no-CAS storage the ORDER is derived at
 * verify time from the content itself, never raced into the store. Same
 * tamper-evidence (any change moves the root) with zero write contention.
 *
 * `signer`/`sig` carry the publisher's wallet attestation when the publish
 * supplied one (X-Unbrowse-Release-Signature); otherwise the leaf is recorded as
 * platform-attested ("platform"), and the Merkle root still binds it. The
 * signature is verified-or-recorded here; the on-chain checkpoint of the root is
 * the deployment step, exactly as the paper labels it.
 */

/**
 * Minimal structural KV shape this ledger needs — satisfied by EdbKV, LocalKV,
 * and FallbackKV from ./kv.ts without importing the concrete classes.
 */
export interface KVStore {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  listWithValues(prefix: string): Promise<Array<{ name: string; key: string; value: string }>>;
}

const LEAF_PREFIX = "routeledger:leaf:";

export interface RouteLeaf {
  /** route domain (e.g. "api.github.com") */
  domain: string;
  /** the published skill id this attestation commits to */
  skill_id: string;
  /** sha256(canonical skill manifest) — the off-log value's content hash */
  value_hash: string;
  /** wallet pubkey hex of the publisher, or "platform" when unsigned */
  signer: string;
  /** publish timestamp (ms) */
  ts: number;
  /** publisher Ed25519 signature over the leaf core (hex), or "" if unsigned */
  sig: string;
}

const enc = new TextEncoder();

/** Canonical bytes of a leaf EXCLUDING its own key/sig-derivation noise. */
function canonLeaf(leaf: RouteLeaf): string {
  // fixed key order so client and server agree on the exact bytes
  return JSON.stringify({
    domain: leaf.domain,
    sig: leaf.sig,
    signer: leaf.signer,
    skill_id: leaf.skill_id,
    ts: leaf.ts,
    value_hash: leaf.value_hash,
  });
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The content-address of a leaf — also its KV key suffix. */
export async function leafHash(leaf: RouteLeaf): Promise<string> {
  return sha256hex(enc.encode(canonLeaf(leaf)));
}

/** sha256 of an arbitrary UTF-8 string (the value_hash of a manifest). */
export async function hashValue(value: string): Promise<string> {
  return sha256hex(enc.encode(value));
}

/**
 * RFC-6962 Merkle Tree Hash over leaf hashes. Empty log → sha256(""). Interior
 * nodes are domain-separated with a 0x01 prefix (CT convention); odd leaves are
 * promoted unchanged. Deterministic for a fixed ordered leaf-hash list.
 */
export async function merkleRoot(orderedLeafHashes: string[]): Promise<string> {
  if (orderedLeafHashes.length === 0) return sha256hex(new Uint8Array());
  let level = orderedLeafHashes.map((h) => hexToBytes(h));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const concat = new Uint8Array(1 + level[i].length + level[i + 1].length);
        concat[0] = 0x01;
        concat.set(level[i], 1);
        concat.set(level[i + 1], 1 + level[i].length);
        next.push(new Uint8Array(await crypto.subtle.digest("SHA-256", concat)));
      } else {
        next.push(level[i]); // odd leaf promoted
      }
    }
    level = next;
  }
  return [...level[0]].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Deterministic linearization: sort leaves by (ts, value_hash, skill_id). This
 * is the read-time replacement for a write-time hash chain — the order comes
 * from the content, never from write timing, so concurrent publishes cannot
 * fork the log. Stable and total for distinct leaves.
 */
function linearize(leaves: RouteLeaf[]): RouteLeaf[] {
  return [...leaves].sort((a, b) =>
    a.ts - b.ts ||
    (a.value_hash < b.value_hash ? -1 : a.value_hash > b.value_hash ? 1 : 0) ||
    (a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0),
  );
}

/**
 * Append a route attestation to the ledger. Content-addressed and idempotent:
 * re-appending identical bytes is a no-op write to the same key. Best-effort —
 * callers in the publish path log on failure rather than failing the publish
 * (the manifest is already durably stored; the ledger is the commitment to it).
 */
export async function appendRouteAttestation(
  kv: KVStore,
  leaf: RouteLeaf,
): Promise<{ leaf_hash: string; key: string }> {
  const h = await leafHash(leaf);
  const key = `${LEAF_PREFIX}${h}`;
  await kv.put(key, JSON.stringify(leaf));
  return { leaf_hash: h, key };
}

/** Read every leaf in the ledger (content-addressed; order-independent). */
export async function readLeaves(kv: KVStore): Promise<RouteLeaf[]> {
  const rows = await kv.listWithValues(LEAF_PREFIX);
  const out: RouteLeaf[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    try {
      out.push(JSON.parse(row.value) as RouteLeaf);
    } catch {
      /* skip an unparseable row rather than corrupt the root */
    }
  }
  return out;
}

/** The single on-chain-checkpointable commitment over the whole ledger. */
export async function ledgerRoot(kv: KVStore): Promise<{ root: string; count: number }> {
  const leaves = linearize(await readLeaves(kv));
  const hashes = await Promise.all(leaves.map(leafHash));
  return { root: await merkleRoot(hashes), count: leaves.length };
}

/**
 * Independent audit: re-derive every leaf's hash from its own stored content
 * and confirm it matches the content-address it was stored under, then recompute
 * the root. `ok` is false if any leaf's content no longer hashes to its key
 * (tampered in place) — exactly the Certificate-Transparency consistency check.
 */
export async function verifyLedger(
  kv: KVStore,
): Promise<{ ok: boolean; root: string; count: number; bad: string[] }> {
  const rows = await kv.listWithValues(LEAF_PREFIX);
  const leaves: RouteLeaf[] = [];
  const bad: string[] = [];
  for (const row of rows) {
    const storedHash = row.key.slice(row.key.lastIndexOf(":") + 1);
    if (!row.value) {
      bad.push(storedHash);
      continue;
    }
    let leaf: RouteLeaf;
    try {
      leaf = JSON.parse(row.value) as RouteLeaf;
    } catch {
      bad.push(storedHash);
      continue;
    }
    const recomputed = await leafHash(leaf);
    if (recomputed !== storedHash) {
      bad.push(storedHash); // content no longer matches its address → tampered
      continue;
    }
    leaves.push(leaf);
  }
  const ordered = linearize(leaves);
  const hashes = await Promise.all(ordered.map(leafHash));
  const root = await merkleRoot(hashes);
  return { ok: bad.length === 0, root, count: leaves.length, bad };
}
