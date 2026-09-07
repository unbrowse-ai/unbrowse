// Hono middleware: the exec-token gate (anti-reverse-engineering Wave 2).
//
// Wave 1 (services/exec-token.ts + routes/session.ts) shipped the mint +
// verify primitives. Wave 2 wires verification onto the marketplace
// routes so a CLI that cannot acquire a token loses the index.
//
// ROLLOUT SAFETY -- this ships in OBSERVE mode by default:
//
//   - Default (EXEC_TOKEN_ENFORCE unset / != "1"): the middleware
//     verifies the X-Unbrowse-Session header and emits a
//     `[exec-token]` evidence line, but NEVER blocks the request.
//     Existing CLIs in the wild (which do not yet send the header)
//     keep working untouched while we observe how many real callers
//     send a valid token.
//   - Enforce (EXEC_TOKEN_ENFORCE="1"): a missing / invalid token
//     returns 401 with a typed error_code + actionable next_step.
//
// The flip to enforce is a one-line wrangler var change, made only
// after the observe-mode logs confirm real CLIs send valid tokens.
// Same staged-rollout shape as the staging-first release gate.
//
// The middleware runs AFTER auth middleware (optionalAuth / bearerAuth)
// so `c.get("agent_id")` is populated; the token is agent-bound and
// verification needs the caller's agent_id.

import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { verifyExecToken } from "../services/exec-token.js";

export const EXEC_TOKEN_HEADER = "X-Unbrowse-Session";

function enforceEnabled(env: Pick<Env, "EXEC_TOKEN_ENFORCE">): boolean {
  const v = env.EXEC_TOKEN_ENFORCE;
  return v === "1" || v === "true";
}

/**
 * Gate a route on a valid exec-token. Mount AFTER the auth middleware.
 *
 * Observe mode: logs `[exec-token]` evidence, calls next() regardless.
 * Enforce mode: 401 on missing/invalid token.
 *
 * Anonymous callers (no agent_id) are exempt in BOTH modes -- the
 * public website's anonymous discovery path must keep working without
 * an API key, and an anonymous caller has no agent_id to bind a token
 * to. The gate's job is to bind AUTHENTICATED programmatic callers
 * (agents running the CLI / SDK / MCP) to a CI-signed build.
 */
export function execTokenGate() {
  return async (
    c: Context<{ Bindings: Env; Variables: { agent_id?: string } }>,
    next: Next,
  ) => {
    const agentId = c.get("agent_id");
    // Anonymous + admin are exempt.
    if (!agentId || agentId === "__admin__") {
      return next();
    }

    const token = c.req.header(EXEC_TOKEN_HEADER);
    const result = await verifyExecToken(c.env, token, agentId);
    const enforce = enforceEnabled(c.env);

    if (result.ok) {
      console.log(`[exec-token] ok agent=${agentId} build=${result.build_sha} path=${c.req.path}`);
      return next();
    }

    // result not ok
    console.log(
      `[exec-token] ${enforce ? "BLOCK" : "observe"} agent=${agentId} ` +
      `error=${result.error_code} path=${c.req.path}`,
    );

    if (!enforce) {
      // Observe mode: surface the evidence, do not block.
      return next();
    }

    // Enforce mode: fail closed with an actionable error.
    const status = result.error_code === "secret_unconfigured" ? 500 : 401;
    return c.json(
      {
        error: "exec_token_required",
        error_code: result.error_code,
        reason: result.reason,
        next_step:
          result.error_code === "missing_token"
            ? "mint a session token: POST /v1/session/exec-token with your build_sha + deployed_at, then resend with the X-Unbrowse-Session header"
            : "run `unbrowse update` to get a current CI-signed build; reverse-engineered or stale binaries cannot pass this gate",
      },
      status,
    );
  };
}
