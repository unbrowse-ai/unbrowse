import { describe, expect, test } from "bun:test";
import { createPermissionContext } from "../src/runtime/permission-gate.js";

describe("central per-call permission gate", () => {
  test("deny beats an otherwise valid approval", () => {
    const context = createPermissionContext();
    const approval = context.issueApproval({ operation_fingerprint: "op-a", effect: "mutation" });
    const decision = context.evaluate({
      operation_fingerprint: "op-a",
      effect: "mutation",
      workspace_trusted: true,
      approval_token: approval.token,
      rules: { deny: true, allow: true, reason: "protected_route" },
    });
    expect(decision).toEqual({ decision: "deny", reason: "protected_route" });
    // A denied attempt must not consume the approval before policy changes.
    expect(context.pendingApprovalCount()).toBe(1);
  });

  test("reads allow by default while sensitive effects are bypass-immune asks", () => {
    const context = createPermissionContext();
    expect(context.evaluate({ operation_fingerprint: "read-a", effect: "read", workspace_trusted: true }))
      .toEqual({ decision: "allow", reason: "read_only_invocation" });
    for (const effect of ["mutation", "payment", "publication", "authentication", "challenge"] as const) {
      expect(context.evaluate({ operation_fingerprint: `op-${effect}`, effect, workspace_trusted: true }))
        .toMatchObject({ decision: "ask", bypass_immune: true });
    }
  });

  test("approval is bound to operation and effect and is single-use by default", () => {
    const context = createPermissionContext();
    const approval = context.issueApproval({ operation_fingerprint: "op-a", effect: "publication" });
    expect(context.evaluate({
      operation_fingerprint: "op-b", effect: "publication", workspace_trusted: true, approval_token: approval.token,
    }).decision).toBe("ask");
    expect(context.evaluate({
      operation_fingerprint: "op-a", effect: "mutation", workspace_trusted: true, approval_token: approval.token,
    }).decision).toBe("ask");
    expect(context.evaluate({
      operation_fingerprint: "op-a", effect: "publication", workspace_trusted: true, approval_token: approval.token,
    }).decision).toBe("allow");
    expect(context.evaluate({
      operation_fingerprint: "op-a", effect: "publication", workspace_trusted: true, approval_token: approval.token,
    }).decision).toBe("ask");
  });

  test("expired and revoked approvals fail closed", () => {
    let now = 1_000;
    const context = createPermissionContext(() => now);
    const expired = context.issueApproval({ operation_fingerprint: "op-a", effect: "payment", ttl_ms: 10 });
    now = 1_011;
    expect(context.evaluate({
      operation_fingerprint: "op-a", effect: "payment", workspace_trusted: true, approval_token: expired.token,
    }).decision).toBe("ask");
    const revoked = context.issueApproval({ operation_fingerprint: "op-b", effect: "payment" });
    expect(context.revoke(revoked.token)).toBe(true);
    expect(context.evaluate({
      operation_fingerprint: "op-b", effect: "payment", workspace_trusted: true, approval_token: revoked.token,
    }).decision).toBe("ask");
  });

  test("untrusted workspaces deny mutations, publication, and hooks before approval", () => {
    const context = createPermissionContext();
    for (const effect of ["mutation", "publication", "hook"] as const) {
      const approval = context.issueApproval({ operation_fingerprint: `op-${effect}`, effect });
      expect(context.evaluate({
        operation_fingerprint: `op-${effect}`, effect, workspace_trusted: false, approval_token: approval.token,
      })).toEqual({ decision: "deny", reason: "workspace_not_trusted" });
    }
  });

  test("context service object is frozen", () => {
    const context = createPermissionContext();
    expect(Object.isFrozen(context)).toBe(true);
  });
});
