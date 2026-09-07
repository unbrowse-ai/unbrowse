import { describe, expect, test } from "bun:test";
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
import { cachePublishedSkill } from "../src/client/index.js";
import type { SkillManifest } from "../src/types/index.js";
import { classifyExecutePermissionEffect, executeOperationFingerprint, isTrustedPermissionCaller, issueHostExecuteApproval } from "../src/api/routes.js";

function mutationSkill(id: string): SkillManifest {
  return {
    skill_id: id, version: "1.0.0", schema_version: "1", name: id,
    intent_signature: "delete a record", domain: "127.0.0.1:1", description: "test",
    owner_type: "agent", execution_type: "http", lifecycle: "active",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    endpoints: [{
      endpoint_id: "delete_record", method: "DELETE", url_template: "http://127.0.0.1:1/records/{id}",
      idempotency: "unsafe", verification_status: "verified", reliability_score: 1,
      last_verified_at: "2026-01-01T00:00:00Z",
      semantic: { action_kind: "delete", resource_kind: "record" },
    }],
  };
}

describe("execute permission gate transport chokepoint", () => {
  test("direct API, CLI, and MCP-shaped calls receive the same typed ask before dispatch", async () => {
    const app = await getInProcessApp();
    for (const transport of ["api", "cli", "mcp"] as const) {
      const client = `permission-${transport}`;
      const skill = mutationSkill(`permission-${transport}-skill`);
      cachePublishedSkill(skill, client);
      const response = await app.inject({
        method: "POST",
        url: `/v1/skills/${skill.skill_id}/execute`,
        headers: {
          "content-type": "application/json",
          "x-unbrowse-client-id": client,
          "x-unbrowse-contract-client": transport,
        },
        payload: JSON.stringify({ params: { endpoint_id: "delete_record", id: "victim" } }),
      });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBe("permission_required");
      expect(body.permission).toMatchObject({ decision: "ask", effect: "mutation", bypass_immune: true });
      expect(body.permission.operation_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(body.next_step).toBeUndefined();
      expect(body.next_action).toBeUndefined();
      // A connection error would prove dispatch reached the deliberately dead target.
      expect(response.body).not.toContain("ECONNREFUSED");
    }
  });

  test("a caller-asserted confirm_unsafe boolean cannot mint host authority", async () => {
    const app = await getInProcessApp();
    const client = "permission-mutation-spoof";
    const skill = mutationSkill("permission-mutation-spoof-skill");
    cachePublishedSkill(skill, client);
    const response = await app.inject({
      method: "POST", url: `/v1/skills/${skill.skill_id}/execute`,
      headers: { "content-type": "application/json", "x-unbrowse-client-id": client },
      payload: JSON.stringify({ params: { endpoint_id: "delete_record", id: "victim" }, confirm_unsafe: true }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "permission_required",
      permission: { decision: "ask", effect: "mutation", confirmation: { host_approval_token_required: true } },
    });
  });

  test("a host-issued approval is operation-bound and one-shot", async () => {
    const app = await getInProcessApp();
    const client = "permission-host-grant";
    const skill = mutationSkill("permission-host-grant-skill");
    cachePublishedSkill(skill, client);
    const params = { endpoint_id: "delete_record", id: "victim" };
    const operation_fingerprint = executeOperationFingerprint({ skillId: skill.skill_id, endpoint: skill.endpoints[0]!, params });
    const approval = issueHostExecuteApproval({ operation_fingerprint, effect: "mutation" });
    const invoke = () => app.inject({
      method: "POST", url: `/v1/skills/${skill.skill_id}/execute`,
      headers: { "content-type": "application/json", "x-unbrowse-client-id": client },
      payload: JSON.stringify({ params, confirm_unsafe: true, approval_token: approval.token }),
    });
    const first = await invoke();
    expect(first.json().error).not.toBe("permission_required");
    const second = await invoke();
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("permission_required");
  });

  test("a caller-asserted payment_verified boolean cannot mint approval", async () => {
    const app = await getInProcessApp();
    const client = "permission-payment-spoof";
    const base = mutationSkill("permission-payment-skill");
    const skill = {
      ...base,
      endpoints: [{ ...base.endpoints[0]!, method: "GET", pay_provider: { provider: "pay.sh" } }],
    } as SkillManifest;
    cachePublishedSkill(skill, client);
    const response = await app.inject({
      method: "POST",
      url: `/v1/skills/${skill.skill_id}/execute`,
      headers: { "content-type": "application/json", "x-unbrowse-client-id": client },
      payload: JSON.stringify({ params: { endpoint_id: "delete_record", id: "victim" }, payment_verified: true, confirm_unsafe: true }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "permission_required",
      permission: { decision: "ask", effect: "payment", confirmation: { verified_payment_receipt_required: true } },
    });
  });

  test("workspace trust is derived from the transport peer, never hardcoded", () => {
    expect(isTrustedPermissionCaller("127.0.0.1")).toBe(true);
    expect(isTrustedPermissionCaller("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedPermissionCaller("203.0.113.42")).toBe(false);
    expect(isTrustedPermissionCaller(undefined)).toBe(false);
  });

  test("operation fingerprints bind the exact endpoint and parameter set", () => {
    const endpoint = mutationSkill("fingerprint").endpoints[0];
    const a = executeOperationFingerprint({ skillId: "fingerprint", endpoint, params: { id: "a", nested: { y: 2, x: 1 } } });
    const reordered = executeOperationFingerprint({ skillId: "fingerprint", endpoint, params: { nested: { x: 1, y: 2 }, id: "a" } });
    const b = executeOperationFingerprint({ skillId: "fingerprint", endpoint, params: { id: "b", nested: { x: 1, y: 2 } } });
    expect(a).toBe(reordered);
    expect(a).not.toBe(b);
  });

  test("effect classifier prioritizes paid/auth/challenge/publication/hook over HTTP mutation", () => {
    const base = mutationSkill("effects").endpoints[0];
    expect(classifyExecutePermissionEffect({ ...base, pay_provider: { provider: "pay.sh" } } as any)).toBe("payment");
    expect(classifyExecutePermissionEffect({ ...base, semantic: { action_kind: "login", resource_kind: "session" } })).toBe("authentication");
    expect(classifyExecutePermissionEffect({ ...base, semantic: { action_kind: "captcha", resource_kind: "challenge" } })).toBe("challenge");
    expect(classifyExecutePermissionEffect({ ...base, semantic: { action_kind: "publish", resource_kind: "article" } })).toBe("publication");
    expect(classifyExecutePermissionEffect({ ...base, semantic: { action_kind: "webhook", resource_kind: "hook" } })).toBe("hook");
    expect(classifyExecutePermissionEffect(base, true)).toBe("read");
  });
});
