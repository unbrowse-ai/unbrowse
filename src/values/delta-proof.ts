/**
 * delta-proof — the bounded-delta VALIDITY proof (plan node 2,
 * internal/zk-delta-contribution-plan.md).
 *
 * A poisoning contributor wants to inject an over-broad route-delta (claiming many
 * endpoints / an oversized schema) to capture settlement it never earned. The defence is
 * the verifiable-federated-learning "proof-of-bounded-update" analogue: commit to the
 * delta's CLAIM-COUNT n (how many endpoints / params it asserts) and prove, in zero
 * knowledge, that n ≤ B — WITHOUT revealing n. An honest delta (n ≤ B) proves; an
 * oversized one (n > B) has no true branch and cannot forge the proof (fails closed).
 *
 * Construction: a Pedersen commitment C = g^n · h^r over the same RFC-3526 group 14 as
 * zk-binding (h is a nothing-up-my-sleeve generator with unknown dlog base g — a hashed
 * value SQUARED into the QR subgroup), and a textbook-sound Cramer–Damgård–Schoenmakers
 * 1-of-(B+1) OR-proof that C opens to some i ∈ [0,B]. The Fiat–Shamir challenge binds the
 * delta's shape pointer + wallet root + B, so a proof is non-transferable to another
 * delta or wallet (domain separation). n and the blinding r never appear in the output.
 */
import { GROUP, modPow, groupRandomScalar, groupSha256Big } from "./zk-binding.js";
import { sha256hex } from "./content-address.js";
import type { RouteDelta } from "./route-delta.js";

const { P, G, Q } = GROUP;

/** Nothing-up-my-sleeve second generator: a hash squared into the order-Q subgroup, so
 *  h is a quadratic residue (order | Q) and nobody knows dlog_g(h) — Pedersen-binding. */
const H = modPow(groupSha256Big(new TextEncoder().encode("unbrowse/delta-proof/H/v1")), 2n, P);
/** g^{-1} mod p via Fermat (p prime) → lets us form g^{-i} = (g^{-1})^i. */
const G_INV = modPow(G, P - 2n, P);

const hex = (b: bigint): string => b.toString(16);
const unhex = (s: string): bigint => BigInt("0x" + s);
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

/** A bounded-claim validity proof: the Pedersen commitment + the OR-proof branches. */
export interface DeltaValidityProof {
  C: string;       // Pedersen commitment to the claim-count (hex)
  B: number;       // the public bound proven (n ≤ B)
  ts: string[];    // per-branch commitments t_i (hex), length B+1
  ss: string[];    // per-branch responses s_i (hex)
  es: string[];    // per-branch challenges e_i (hex); Σ e_i ≡ FS-challenge (mod q)
}

/** Pedersen commit to claim-count n with blinding r: C = g^n · h^r mod p. */
function commit(n: bigint, r: bigint): bigint {
  return mod(modPow(G, n, P) * modPow(H, r, P), P);
}

/** Domain-separating context: this proof is bound to THIS delta's shape + wallet + bound. */
function deltaCtx(shape: string, walletRoot: string, B: number): Uint8Array {
  return new TextEncoder().encode(sha256hex(`${shape}|${walletRoot}|B=${B}`));
}

/** The Fiat–Shamir challenge over the statement and all branch commitments. */
function fsChallenge(C: bigint, ts: bigint[], ctx: Uint8Array, B: number): bigint {
  const blob = `${P}|${G}|${H}|${C}|B=${B}|${ts.map((t) => t.toString()).join(",")}|`;
  return mod(groupSha256Big(Buffer.concat([Buffer.from(blob), Buffer.from(ctx)])), Q);
}

/**
 * Prove the committed claim-count n is in [0,B], bound to `ctx`. Throws if n ∉ [0,B] —
 * an honest prover has no true OR-branch outside the bound (that is the fail-closed
 * property, surfaced as a refusal rather than a forgeable proof).
 */
function orProveInRange(n: number, r: bigint, C: bigint, B: number, ctx: Uint8Array): DeltaValidityProof {
  if (!Number.isInteger(n) || n < 0 || n > B) {
    throw new Error(`delta-proof: claim-count ${n} outside bound [0,${B}] — cannot prove (fails closed)`);
  }
  const j = n; // the true branch
  const Y = (i: number): bigint => mod(C * modPow(G_INV, BigInt(i), P), P); // C·g^{-i} = h^{r} at i=j
  const ts: bigint[] = new Array(B + 1);
  const ss: bigint[] = new Array(B + 1);
  const es: bigint[] = new Array(B + 1);

  // Simulate every false branch i≠j: pick random e_i,s_i; t_i = h^{s_i}·Y_i^{-e_i}.
  let eSum = 0n;
  for (let i = 0; i <= B; i++) {
    if (i === j) continue;
    const ei = groupRandomScalar();
    const si = groupRandomScalar();
    const yiNegE = modPow(modPow(Y(i), ei, P), P - 2n, P); // Y_i^{-e_i}
    ts[i] = mod(modPow(H, si, P) * yiNegE, P);
    es[i] = ei; ss[i] = si;
    eSum = mod(eSum + ei, Q);
  }
  // True branch j: honest Schnorr commitment first.
  const k = groupRandomScalar();
  ts[j] = modPow(H, k, P);
  // Bind the whole statement, then split the challenge so Σ e_i ≡ e.
  const e = fsChallenge(C, ts, ctx, B);
  es[j] = mod(e - eSum, Q);
  ss[j] = mod(k + es[j] * r, Q); // s_j = k + e_j·r  (Y_j = h^r, we know r)

  return {
    C: hex(C), B,
    ts: ts.map(hex), ss: ss.map(hex), es: es.map(hex),
  };
}

/** Verify the bounded-claim proof against `ctx`: every branch equation holds and the
 *  branch challenges sum to the Fiat–Shamir challenge (so ≥1 branch is a real opening in
 *  [0,B]). Any tamper, wrong bound, or wrong ctx ⇒ false. */
function orVerifyInRange(proof: DeltaValidityProof, ctx: Uint8Array): boolean {
  try {
    const { B } = proof;
    if (proof.ts.length !== B + 1 || proof.ss.length !== B + 1 || proof.es.length !== B + 1) return false;
    const C = unhex(proof.C);
    const ts = proof.ts.map(unhex);
    const ss = proof.ss.map(unhex);
    const es = proof.es.map(unhex);
    const e = fsChallenge(C, ts, ctx, B);
    let eSum = 0n;
    for (let i = 0; i <= B; i++) {
      const Yi = mod(C * modPow(G_INV, BigInt(i), P), P);     // C·g^{-i}
      const lhs = modPow(H, ss[i], P);                        // h^{s_i}
      const rhs = mod(ts[i] * modPow(Yi, es[i], P), P);       // t_i · Y_i^{e_i}
      if (lhs !== rhs) return false;
      eSum = mod(eSum + es[i], Q);
    }
    return eSum === e;
  } catch {
    return false;
  }
}

/**
 * Produce a validity proof for a delta: prove its claim-count `n` is within bound `B`,
 * bound to the delta's shape + wallet root. The count and blinding never leave this call.
 */
export function proveDeltaValidity(delta: RouteDelta, n: number, B = 16): DeltaValidityProof {
  const r = groupRandomScalar();
  const C = commit(BigInt(n), r);
  const ctx = deltaCtx(delta.shape, delta.walletRoot, B);
  return orProveInRange(n, r, C, B, ctx);
}

/** Verify a delta's validity proof: the claim-count is within the proven bound and the
 *  proof is bound to exactly this delta (shape + wallet root). */
export function verifyDeltaValidity(delta: RouteDelta, proof: DeltaValidityProof): boolean {
  const ctx = deltaCtx(delta.shape, delta.walletRoot, proof.B);
  return orVerifyInRange(proof, ctx);
}

/** Exposed for the witness: commit + the raw OR-prover, to exercise the fail-closed path. */
export const __test = { commit, orProveInRange, orVerifyInRange, deltaCtx, H, G_INV };
