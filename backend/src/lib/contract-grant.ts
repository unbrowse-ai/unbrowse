/**
 * contract-grant (backend copy) — the SAME native ed25519 grant + RBAC permission primitive as
 * src/values/contract-grant.ts, plus `isVisibleByGrant`: the read-guard the live contract-read path
 * calls so a cross-identity read is ENFORCED. A separate copy ON PURPOSE (the backend is its own
 * CF-worker deploy artifact; cannot import the CLI's src/). Pure, fail-CLOSED.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface ContractGrant {
  granter: string;
  grantee: string; // identity | "lineage:<root>" | "role:<R>" | "*"
  scope: string; // "contract:<id>" | "skill:*" | "role:<R>" | "*"
  signature: string;
  expires?: number | null;
  revoked?: boolean;
}

export function canonicalGrant(g: Pick<ContractGrant, "granter" | "grantee" | "scope" | "expires">): string {
  return `grant ${g.granter} ${g.grantee} ${g.scope} ${g.expires ?? "never"}`;
}

export function ed25519Verify(msg: string, sigHex: string, granterPubSpkiHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(granterPubSpkiHex, "hex"), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(msg, "utf8"), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

export function scopeMatches(grantScope: string, requested: string): boolean {
  if (grantScope === "*" || grantScope === requested) return true;
  if (grantScope.endsWith(":*")) return requested.startsWith(grantScope.slice(0, -1));
  return false;
}

export function granteeMatches(grantee: string, reader: string, readerLineage: string[] = []): boolean {
  if (grantee === "*" || grantee === reader) return true;
  if (grantee.startsWith("lineage:")) {
    const root = grantee.slice("lineage:".length);
    return reader === root || readerLineage.includes(root);
  }
  return false;
}

function liveGrant(g: ContractGrant, nowMs: number, verify: (m: string, s: string, p: string) => boolean): boolean {
  if (g.revoked) return false;
  if (g.expires != null && nowMs > g.expires) return false;
  return verify(canonicalGrant(g), g.signature, g.granter);
}

/** RBAC: roles assigned to `reader` BY `granter` (signed "role:<R>" grants — no self-assign). */
export function rolesOf(
  reader: string,
  granter: string,
  grants: ContractGrant[],
  nowMs: number,
  verify: (m: string, s: string, p: string) => boolean = ed25519Verify,
): string[] {
  const roles: string[] = [];
  for (const g of grants) {
    if (g.granter !== granter || g.grantee !== reader || !g.scope.startsWith("role:")) continue;
    if (liveGrant(g, nowMs, verify)) roles.push(g.scope.slice("role:".length));
  }
  return roles;
}

export interface CanReadResult {
  allowed: boolean;
  reason: string;
  grant?: ContractGrant;
}

export function canRead(opts: {
  reader: string;
  readerLineage?: string[];
  requestedScope: string;
  grants: ContractGrant[];
  nowMs: number;
  verify?: (m: string, s: string, p: string) => boolean;
}): CanReadResult {
  const verify = opts.verify ?? ed25519Verify;
  let sawCandidate = false;
  for (const g of opts.grants) {
    if (g.scope.startsWith("role:")) continue; // a role-assignment is not itself a read grant
    const matchesGrantee = g.grantee.startsWith("role:")
      ? rolesOf(opts.reader, g.granter, opts.grants, opts.nowMs, verify).includes(g.grantee.slice("role:".length))
      : granteeMatches(g.grantee, opts.reader, opts.readerLineage);
    if (!matchesGrantee) continue;
    sawCandidate = true;
    if (!scopeMatches(g.scope, opts.requestedScope)) continue;
    if (g.revoked) return { allowed: false, reason: "revoked", grant: g };
    if (g.expires != null && opts.nowMs > g.expires) return { allowed: false, reason: "expired", grant: g };
    if (!verify(canonicalGrant(g), g.signature, g.granter)) return { allowed: false, reason: "bad_signature", grant: g };
    return { allowed: true, reason: "granted", grant: g };
  }
  return { allowed: false, reason: sawCandidate ? "scope_mismatch" : "no_grant" };
}

/** A ledger row that MIGHT carry a capability grant. */
export interface MaybeGrantRow {
  event?: string;
  granter?: string;
  grantee?: string;
  scope?: string;
  signature?: string;
  expires?: number | null;
  revoked?: boolean;
}

/**
 * The READ-GUARD wired into the live contract read: is `caller` allowed to read `contractId` via a
 * capability grant carried in the contract's own rows? Fail-CLOSED: no caller / no valid grant /
 * forged signature → false. Used ADDITIVELY with the lineage check (it only WIDENS access).
 */
export function isVisibleByGrant(
  caller: string | null | undefined,
  contractId: string,
  rows: MaybeGrantRow[],
  nowMs: number = Date.now(),
  verify: (m: string, s: string, p: string) => boolean = ed25519Verify,
): boolean {
  if (!caller) return false;
  const grants: ContractGrant[] = rows
    .filter((r) => r.event === "capability_granted" && !!r.granter && !!r.grantee && !!r.scope && !!r.signature)
    .map((r) => ({
      granter: r.granter as string,
      grantee: r.grantee as string,
      scope: r.scope as string,
      signature: r.signature as string,
      expires: r.expires ?? null,
      revoked: r.revoked,
    }));
  if (grants.length === 0) return false;
  return canRead({ reader: caller, requestedScope: `contract:${contractId}`, grants, nowMs, verify }).allowed;
}

/** The decision a surface gets when it opts into the grant policy (coverage auditable + why). */
export interface VisibilityDecision {
  surface: string;
  visible: boolean;
  via: "base" | "grant" | "denied";
}

/** grantGate — the OPT-IN permission policy any layer/surface adopts (superpattern: one guard, opted
 *  into per surface). base allow → via base; base deny → grants WIDEN (additive, no lockout); fail-closed. */
export function grantGate(opts: {
  surface: string;
  baseAllowed: boolean;
  caller: string | null | undefined;
  contractId: string;
  rows: MaybeGrantRow[];
  nowMs?: number;
}): VisibilityDecision {
  if (opts.baseAllowed) return { surface: opts.surface, visible: true, via: "base" };
  const grantOk = isVisibleByGrant(opts.caller, opts.contractId, opts.rows, opts.nowMs ?? Date.now());
  return { surface: opts.surface, visible: grantOk, via: grantOk ? "grant" : "denied" };
}
