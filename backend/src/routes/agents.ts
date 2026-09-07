import { Hono } from "hono";
import type { Env } from "../types.js";
import { registerAgent, getAgent, listAgents, acceptTos, updateAgentWallet } from "../services/agents.js";
import { bearerAuthNoTos } from "../middleware/auth.js";
import { setKeyFunding } from "../services/keys.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { checkFlexOnboarding } from "../middleware/flex-onboarding-required.js";

// Public agent routes — no auth required
export const publicAgentRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 10 registrations per 5 minutes per IP
publicAgentRoutes.use("/agents/register", rateLimit({ limit: 10, window: 300, prefix: "register" }));

// GET /v1/tos/current — public, returns current ToS version info
publicAgentRoutes.get("/tos/current", (c) => {
  c.header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600");
  return c.json({
    version: CURRENT_TOS_VERSION,
    summary: TOS_SUMMARY,
    url: "https://unbrowse.ai/terms",
  });
});

// POST /v1/agents/register — self-register and get an API key.
// v6.16.0 (P0.2): requires complete Flex onboarding (wallet + escrow + session key)
// in addition to ToS acceptance. Local-admin dev mode (API_KEY === "local-test")
// short-circuits before the Flex check because the admin profile is synthetic.
publicAgentRoutes.post("/agents/register", async (c) => {
  const {
    name,
    tos_version,
    wallet_address,
    wallet_provider,
    flex_escrow_address,
    flex_session_key_address,
    flex_facilitator,
    landing_token,
  } = await c.req.json<{
    name: string;
    tos_version?: string;
    wallet_address?: string;
    wallet_provider?: string;
    flex_escrow_address?: string;
    flex_session_key_address?: string;
    flex_facilitator?: string;
    landing_token?: string;
  }>();
  if (!name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!tos_version) {
    return c.json({
      error: "tos_acceptance_required",
      message: "You must accept the Terms of Service to register.",
      current_tos_version: CURRENT_TOS_VERSION,
      tos_summary: TOS_SUMMARY,
      tos_url: "https://unbrowse.ai/terms",
    }, 400);
  }
  if (tos_version !== CURRENT_TOS_VERSION) {
    return c.json({
      error: "tos_version_mismatch",
      message: `You accepted ToS version "${tos_version}" but current is "${CURRENT_TOS_VERSION}".`,
      current_tos_version: CURRENT_TOS_VERSION,
    }, 400);
  }

  // Local-admin dev shortcut: when API_KEY=local-test, registerAgent returns
  // the synthetic __admin__ profile. This is dev-only and bypasses Flex
  // onboarding because __admin__ has no real wallet/escrow/session-key.
  const isLocalAdmin = c.env.API_KEY === "local-test";

  // P0.2: Flex onboarding gate. All three fields (wallet + escrow + session
  // key) must be present for the AgentProfile to be considered ready. The
  // admin dev shortcut is the only bypass.
  if (!isLocalAdmin) {
    const flexStatus = checkFlexOnboarding({
      wallet_address,
      flex_escrow_address,
      flex_session_key_address,
    });
    if (!flexStatus.ready) {
      return c.json({
        error: "flex_onboarding_incomplete",
        missing: flexStatus.missing,
        remediation: "Run `unbrowse setup` or pair via /account",
      }, 400);
    }
  }

  try {
    const result = await registerAgent(
      c.env,
      name,
      tos_version,
      {
        wallet_address,
        wallet_provider,
        flex_escrow_address,
        flex_session_key_address,
        flex_facilitator,
      },
      { landing_token },
    );
    return c.json(result, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already taken")) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

// POST /v1/agents/register-anon — L1 anonymous agent registration.
// Wallet-first identity principle (P-61a63170): the minimum identity to
// participate is an agent_id. Email is L3 upgrade, wallet+Flex onboarding
// is L2 upgrade for earnings. This route skips the Flex gate so a brand-
// new agent can mint a key in one call, then upgrade later via
// POST /v1/agents/wallet or the magic-link flow.
// Rate-limited to 10/IP/5min via the same /agents/register prefix.
publicAgentRoutes.use("/agents/register-anon", rateLimit({ limit: 10, window: 300, prefix: "register-anon" }));
publicAgentRoutes.post("/agents/register-anon", async (c) => {
  const body = await c.req.json<{
    name?: string;
    tos_version?: string;
    landing_token?: string;
  }>().catch(() => ({} as { name?: string; tos_version?: string; landing_token?: string }));

  // Auto-generate a name when not supplied so the L1 flow is one POST with
  // an empty body. The name is human-readable but throwaway — the agent_id
  // is the only stable identifier. Format mirrors the existing test pattern
  // `anon-{random}` (per tests/cli-register-anon-backcompat.test.ts).
  const name = body.name?.trim() || `anon-${Math.random().toString(36).slice(2, 10)}`;
  const tosVersion = body.tos_version?.trim() || CURRENT_TOS_VERSION;

  try {
    const result = await registerAgent(
      c.env,
      name,
      tosVersion,
      {},
      body.landing_token ? { landing_token: body.landing_token } : undefined,
    );
    return c.json({
      ...result,
      tier: "l1_anon",
      upgrade_hints: {
        attach_wallet: "POST /v1/agents/wallet with Bearer ${api_key} once you have a Solana wallet to start earning from indexed routes.",
        attach_email: "POST /v1/auth/email/start to bind an email for recovery and human-readable identity.",
        website: "https://unbrowse.ai/dashboard — manage the upgrade path visually.",
      },
    }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// POST /v1/agents/wallet — claim payout wallet for existing authenticated agent
publicAgentRoutes.post("/agents/wallet", bearerAuthNoTos, async (c) => {
  const agentId = c.get("agent_id");
  const { wallet_address, wallet_provider } = await c.req.json<{
    wallet_address?: string;
    wallet_provider?: string;
  }>();

  try {
    const result = await updateAgentWallet(c.env, agentId, { wallet_address, wallet_provider });
    // WRAP the api_key with the wallet (L6 api-key-wrapping-x402). Updating the agent
    // profile alone is not enough — without this binding the key is unfunded and the
    // agent's published routes pay out to nobody (the L1->L2 upgrade silently earned
    // zero). Binding here makes "the api_key wraps the wallet" actually true.
    if (typeof wallet_address === "string" && wallet_address.trim().length >= 8 && agentId !== "__admin__") {
      await setKeyFunding(c.env, agentId, { kind: "wallet", wallet: wallet_address.trim() }).catch((err) => {
        console.warn(`[wallet] setKeyFunding failed for ${agentId}: ${(err as Error).message}`);
      });
    }
    return c.json({ ok: true, status: result.status });
  } catch (err) {
    if ((err as Error).message === "wallet_already_claimed") {
      return c.json({ error: "wallet_already_claimed" }, 409);
    }
    return c.json({ error: (err as Error).message }, 400);
  }
});

// POST /v1/agents/accept-tos — re-accept updated ToS (uses bearerAuthNoTos to avoid circular block)
publicAgentRoutes.post("/agents/accept-tos", bearerAuthNoTos, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    return c.json({ ok: true });
  }

  const { tos_version } = await c.req.json<{ tos_version: string }>();
  if (!tos_version || tos_version !== CURRENT_TOS_VERSION) {
    return c.json({
      error: "tos_version_mismatch",
      message: `Expected ToS version "${CURRENT_TOS_VERSION}".`,
      current_tos_version: CURRENT_TOS_VERSION,
    }, 400);
  }

  try {
    await acceptTos(c.env, agentId, tos_version);
    return c.json({ ok: true, tos_accepted_version: tos_version });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// GET /v1/agents/me — authenticated agent's own profile (uses bearerAuthNoTos so agents with outdated ToS can still check their profile)
publicAgentRoutes.get("/agents/me", bearerAuthNoTos, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    return c.json({
      agent_id: "__admin__",
      name: "admin",
      created_at: "",
      wallet_address: null,
      wallet_provider: null,
      skills_discovered: [],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: null,
      tos_accepted_at: null,
    });
  }
  const profile = await getAgent(c.env, agentId);
  if (!profile) {
    return c.json({ error: "Agent profile not found" }, 404);
  }
  return c.json(profile);
});

// GET /v1/agents — list recent agents (public profiles)
publicAgentRoutes.get("/agents", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  const { agents } = await getOrSetHttpCache(c.env, `agents:list:${limit}`, 30, async () => ({
    agents: await listAgents(c.env, limit),
  }));
  c.header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=120");
  return c.json({ agents });
});

// GET /v1/agents/:id — public agent profile
publicAgentRoutes.get("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const payload = await getOrSetHttpCache(c.env, `agents:profile:${id}`, 30, async () => {
    const profile = await getAgent(c.env, id);
    if (!profile) return { error: "Agent not found" as const };
    return { profile };
  });
  if ("error" in payload) return c.json({ error: payload.error }, 404);
  c.header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=120");
  return c.json(payload.profile);
});
