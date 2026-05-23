// Backend test: exec-token gate middleware (Wave 2).
//
// Locks the observe-vs-enforce contract:
//   1. Anonymous callers (no agent_id) pass in BOTH modes.
//   2. __admin__ passes in BOTH modes.
//   3. Observe mode (EXEC_TOKEN_ENFORCE unset): a missing/invalid token
//      does NOT block -- next() is called.
//   4. Enforce mode (EXEC_TOKEN_ENFORCE=1): a missing token returns 401.
//   5. Enforce mode: a valid token passes.

import { describe, test, expect } from "bun:test";
import { execTokenGate, EXEC_TOKEN_HEADER } from "../src/middleware/exec-token.ts";
import { issueExecToken } from "../src/services/exec-token.ts";

const SECRET = "test-release-signing-secret-32chars-fixture";

function makeEnv(enforce: boolean): any {
  return {
    RELEASE_MANIFEST_SIGNING_SECRET: SECRET,
    UNBROWSE_BUILD_SHA: "abc1234567890abcdef1234567890abcdef12345",
    UNBROWSE_DEPLOYED_AT: "2026-05-22T03:45:00Z",
    EXEC_TOKEN_ENFORCE: enforce ? "1" : undefined,
    STATS_KV: { get: async () => null, put: async () => {} },
  };
}

// Minimal Hono-Context stub sufficient for the middleware.
function makeCtx(env: any, agentId: string | undefined, token?: string) {
  let jsonStatus = 200;
  let jsonBody: any = null;
  return {
    ctx: {
      env,
      get: (k: string) => (k === "agent_id" ? agentId : undefined),
      req: {
        path: "/v1/search",
        header: (h: string) => (h === EXEC_TOKEN_HEADER ? token : undefined),
      },
      json: (body: any, status?: number) => {
        jsonBody = body;
        jsonStatus = status ?? 200;
        return { __json: true };
      },
    },
    result: () => ({ jsonStatus, jsonBody }),
  };
}

describe("exec-token gate middleware (Wave 2)", () => {
  test("anonymous caller passes in observe mode", async () => {
    const { ctx } = makeCtx(makeEnv(false), undefined);
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test("anonymous caller passes in enforce mode", async () => {
    const { ctx } = makeCtx(makeEnv(true), undefined);
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test("__admin__ passes in enforce mode", async () => {
    const { ctx } = makeCtx(makeEnv(true), "__admin__");
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test("observe mode: missing token does NOT block", async () => {
    const { ctx } = makeCtx(makeEnv(false), "agent_1");
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  test("enforce mode: missing token returns 401", async () => {
    const { ctx, result } = makeCtx(makeEnv(true), "agent_1");
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(false);
    const { jsonStatus, jsonBody } = result();
    expect(jsonStatus).toBe(401);
    expect(jsonBody.error).toBe("exec_token_required");
    expect(jsonBody.error_code).toBe("missing_token");
  });

  test("enforce mode: a valid token passes", async () => {
    const env = makeEnv(true);
    const issued = await issueExecToken(env, {
      agent_id: "agent_valid",
      build_sha: env.UNBROWSE_BUILD_SHA,
      deployed_at: env.UNBROWSE_DEPLOYED_AT,
    });
    if (!issued.ok) throw new Error("issue failed");
    const { ctx, result } = makeCtx(env, "agent_valid", issued.token);
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(result().jsonBody).toBeNull();
  });

  test("enforce mode: a token issued for a DIFFERENT agent is rejected", async () => {
    const env = makeEnv(true);
    const issued = await issueExecToken(env, {
      agent_id: "agent_one",
      build_sha: env.UNBROWSE_BUILD_SHA,
      deployed_at: env.UNBROWSE_DEPLOYED_AT,
    });
    if (!issued.ok) throw new Error("issue failed");
    const { ctx, result } = makeCtx(env, "agent_TWO", issued.token);
    let nexted = false;
    await execTokenGate()(ctx as any, async () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(result().jsonStatus).toBe(401);
    expect(result().jsonBody.error_code).toBe("agent_mismatch");
  });
});
