/**
 * delta-bound — the bounded-delta VALIDITY claim.
 *
 * A poisoning contributor wants to inject an over-broad route-delta (claiming many
 * endpoints / an oversized schema) to capture settlement it never earned. The defence
 * is a wallet-signed, delta-bound claim of the delta's CLAIM-COUNT n, checked against
 * the public bound B at the admission gate. An honest delta (n ≤ B) signs the claim;
 * an oversized one has no signable statement inside the bound (prove refuses — fails
 * closed), and a forged/edited claim fails the wallet signature.
 *
 * This replaces the former Pedersen + CDS OR-proof ("zk" delta-proof): the claim-count
 * n now rides in the clear. n is contribution METADATA (how many endpoints a delta
 * asserts), not user data — no user-privacy property is lost by revealing it. The
 * signature domain binds shape pointer + wallet root + n + B, so a claim is
 * non-transferable to another delta, wallet, count, or bound.
 */
import { signBytes } from "./signer.js";
import { verifyEd25519 } from "./cred-binding.js";
import type { RouteDelta } from "./route-delta.js";

/** A bounded-claim validity statement: the count, the bound, the wallet signature. */
export interface DeltaBoundClaim {
  /** The delta's claim-count, in the clear. */
  n: number;
  /** The public bound the gate enforces (n ≤ B). */
  B: number;
  /** Wallet Ed25519 signature (hex) over the domain-separated claim statement. */
  sig: string;
}

/** Canonical signed statement — binds THIS delta's shape + wallet + count + bound. */
function claimStatement(shape: string, walletRoot: string, n: number, B: number): Uint8Array {
  return new TextEncoder().encode(`unbrowse/delta-bound/v2|${shape}|${walletRoot}|n=${n}|B=${B}`);
}

/**
 * Produce a validity claim for a delta: assert its claim-count `n` is within bound `B`,
 * signed by the ambient wallet (which must be the delta's `walletRoot`). Throws if
 * n ∉ [0,B] — an out-of-bound count has no signable statement (fails closed, surfaced
 * as a refusal rather than a forgeable claim).
 */
export async function proveDeltaBound(delta: RouteDelta, n: number, B = 16): Promise<DeltaBoundClaim> {
  if (!Number.isInteger(n) || n < 0 || n > B) {
    throw new Error(`delta-bound: claim-count ${n} outside bound [0,${B}] — cannot claim (fails closed)`);
  }
  const { signature } = await signBytes(claimStatement(delta.shape, delta.walletRoot, n, B));
  return { n, B, sig: Buffer.from(signature).toString("hex") };
}

/** Verify a delta's validity claim: the count is an integer within the bound and the
 *  delta's OWN wallet signed exactly this statement (shape + root + n + B). Any
 *  tamper, wrong bound, count, wallet, or delta ⇒ false. */
export function verifyDeltaBound(delta: RouteDelta, claim: DeltaBoundClaim): boolean {
  try {
    const { n, B, sig } = claim;
    if (!Number.isInteger(n) || !Number.isInteger(B) || B < 0 || n < 0 || n > B) return false;
    return verifyEd25519(
      Buffer.from(delta.walletRoot, "hex"),
      claimStatement(delta.shape, delta.walletRoot, n, B),
      Buffer.from(sig, "hex"),
    );
  } catch {
    return false;
  }
}

/** Exposed for the witness: the statement builder, to exercise tamper cases. */
export const __test = { claimStatement };
