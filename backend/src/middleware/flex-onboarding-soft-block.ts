/**
 * Flex onboarding soft-block middleware (Day 4 / Genesis Luminaries, v6.16.0).
 *
 * Soft-blocks existing v6.15-era agents who registered without Flex onboarding.
 * Free routes (health, search-read-only) skip this middleware entirely.
 * Priced routes call this BEFORE the x402 gate, so the 402 with
 * X-Flex-Onboarding-Required fires before any payment terms are built.
 *
 * Admin (`__admin__`) bypasses the block — its profile is synthetic.
 *
 * Acceptance criteria: P0.3 in docs/x402-routing-plan-v6.16.md.
 */

import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import {
  checkFlexOnboarding,
  buildFlexOnboardingRequired402,
} from "./flex-onboarding-required.js";
import { getAgent } from "../services/agents.js";

// Context shape is intentionally permissive — different priced routes carry
// different Variables (skills.ts has agent_id+user_id, search.ts has just
// agent_id). Hono Context generics are invariant; we only read agent_id +
// c.env + emit headers/json which exist on every Context<{Bindings: Env}>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SoftBlockContext = Context<{ Bindings: Env; Variables: any }>;

export function flexOnboardingSoftBlock() {
  return async (c: SoftBlockContext, next: Next) => {
    const agentId = c.get("agent_id") as string | undefined;

    // No agent identity yet — earlier auth middleware will reject or admit.
    // Don't block here; anonymous priced calls hit the standard 402.
    if (!agentId) return next();

    // Admin shortcut bypasses Flex onboarding (synthetic profile, no real
    // wallet/escrow/session-key). The existing admin-key path already grants
    // access; this middleware must not 402 the admin.
    if (agentId === "__admin__") return next();

    const profile = await getAgent(c.env, agentId).catch(() => null);
    // Profile not yet materialised (race, KV miss). Don't soft-block —
    // let the route's own auth handle the missing-profile case.
    if (!profile) return next();

    const status = checkFlexOnboarding(profile);
    if (status.ready) return next();

    const resp = buildFlexOnboardingRequired402(status.missing);
    for (const [k, v] of Object.entries(resp.headers)) {
      c.header(k, v);
    }
    return c.json(resp.body, 402);
  };
}

/**
 * Inline variant for routes structured as free-function handlers (not method-
 * chained middleware). Returns a Response on block, undefined on admit.
 *
 *   const blockResp = await checkFlexOnboardingOrBlock(c);
 *   if (blockResp) return blockResp;
 */
export async function checkFlexOnboardingOrBlock(
  c: SoftBlockContext,
): Promise<Response | undefined> {
  const agentId = c.get("agent_id") as string | undefined;
  if (!agentId || agentId === "__admin__") return undefined;

  const profile = await getAgent(c.env, agentId).catch(() => null);
  if (!profile) return undefined;

  const status = checkFlexOnboarding(profile);
  if (status.ready) return undefined;

  const resp = buildFlexOnboardingRequired402(status.missing);
  for (const [k, v] of Object.entries(resp.headers)) {
    c.header(k, v);
  }
  return c.json(resp.body, 402);
}
