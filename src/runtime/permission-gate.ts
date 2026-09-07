import { randomBytes } from "node:crypto";

export type PermissionDecision =
  | { decision: "allow"; reason: string; approval_id?: string }
  | { decision: "ask"; reason: string; bypass_immune: boolean }
  | { decision: "deny"; reason: string };

export type PermissionEffect =
  | "read"
  | "mutation"
  | "payment"
  | "publication"
  | "authentication"
  | "challenge"
  | "hook";

export interface PermissionRequest {
  operation_fingerprint: string;
  effect: PermissionEffect;
  method?: string;
  workspace_trusted: boolean;
  approval_token?: string;
  rules?: {
    deny?: boolean;
    ask?: boolean;
    allow?: boolean;
    reason?: string;
  };
}

interface ApprovalGrant {
  id: string;
  token: string;
  operation_fingerprint: string;
  effect: PermissionEffect;
  expires_at_ms: number;
  uses_remaining: number;
  claimed: boolean;
}

export interface ApprovalIssueInput {
  operation_fingerprint: string;
  effect: PermissionEffect;
  ttl_ms?: number;
  max_uses?: number;
}

export interface PermissionContext {
  issueApproval(input: ApprovalIssueInput): { id: string; token: string; expires_at_ms: number; max_uses: number };
  evaluate(request: PermissionRequest): PermissionDecision;
  revoke(token: string): boolean;
  pendingApprovalCount(): number;
}

const HUMAN_GATED_EFFECTS = new Set<PermissionEffect>([
  "mutation",
  "payment",
  "publication",
  "authentication",
  "challenge",
]);

function requiresTrustedWorkspace(effect: PermissionEffect): boolean {
  return effect === "hook" || effect === "publication" || effect === "mutation";
}

/**
 * Single per-invocation permission chokepoint. Deny beats ask beats allow;
 * operation-bound approvals cannot override explicit denials or trust gates.
 */
export function createPermissionContext(now: () => number = Date.now): PermissionContext {
  const approvals = new Map<string, ApprovalGrant>();

  function issueApproval(input: ApprovalIssueInput) {
    if (!input.operation_fingerprint.trim()) throw new Error("approval_operation_fingerprint_required");
    const ttl = Math.max(1, Math.min(input.ttl_ms ?? 60_000, 10 * 60_000));
    const maxUses = Math.max(1, Math.min(input.max_uses ?? 1, 10));
    const id = `approval_${randomBytes(8).toString("hex")}`;
    const token = `${id}.${randomBytes(24).toString("base64url")}`;
    const grant: ApprovalGrant = {
      id,
      token,
      operation_fingerprint: input.operation_fingerprint,
      effect: input.effect,
      expires_at_ms: now() + ttl,
      uses_remaining: maxUses,
      claimed: false,
    };
    approvals.set(token, grant);
    return { id, token, expires_at_ms: grant.expires_at_ms, max_uses: maxUses };
  }

  function claimApproval(request: PermissionRequest): ApprovalGrant | undefined {
    if (!request.approval_token) return undefined;
    const grant = approvals.get(request.approval_token);
    if (!grant) return undefined;
    // Claim and decrement synchronously before returning. Concurrent async callers
    // cannot both observe an unused one-shot grant.
    if (grant.claimed || grant.expires_at_ms <= now() || grant.uses_remaining <= 0) {
      approvals.delete(request.approval_token);
      return undefined;
    }
    if (grant.operation_fingerprint !== request.operation_fingerprint || grant.effect !== request.effect) return undefined;
    grant.claimed = true;
    grant.uses_remaining -= 1;
    if (grant.uses_remaining <= 0) approvals.delete(request.approval_token);
    else grant.claimed = false;
    return grant;
  }

  function evaluate(request: PermissionRequest): PermissionDecision {
    if (!request.operation_fingerprint.trim()) return { decision: "deny", reason: "operation_fingerprint_required" };
    if (request.rules?.deny) return { decision: "deny", reason: request.rules.reason ?? "explicit_policy_deny" };
    if (!request.workspace_trusted && requiresTrustedWorkspace(request.effect)) {
      return { decision: "deny", reason: "workspace_not_trusted" };
    }

    const mustAsk = request.rules?.ask === true || HUMAN_GATED_EFFECTS.has(request.effect);
    if (mustAsk) {
      const grant = claimApproval(request);
      if (grant) return { decision: "allow", reason: "operation_bound_approval", approval_id: grant.id };
      return {
        decision: "ask",
        reason: request.rules?.reason ?? `${request.effect}_approval_required`,
        bypass_immune: true,
      };
    }

    if (request.effect === "hook") {
      return request.rules?.allow
        ? { decision: "allow", reason: "trusted_hook_policy" }
        : { decision: "ask", reason: "hook_approval_required", bypass_immune: true };
    }
    if (request.effect === "read") return { decision: "allow", reason: "read_only_invocation" };
    if (request.rules?.allow) return { decision: "allow", reason: request.rules.reason ?? "explicit_policy_allow" };
    return { decision: "ask", reason: "permission_default_ask", bypass_immune: false };
  }

  const context: PermissionContext = {
    issueApproval,
    evaluate,
    revoke(token: string) { return approvals.delete(token); },
    pendingApprovalCount() { return approvals.size; },
  };
  return Object.freeze(context);
}
