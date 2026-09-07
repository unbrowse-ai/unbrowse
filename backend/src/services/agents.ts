import type { Env, AgentProfile } from "../types.js";
import { statsKV } from "./kv.js";
import { CURRENT_TOS_VERSION } from "../tos.js";
import { grantCredits } from "./credits.js";
import { createLocalKey } from "./keys.js";
import { linkAgentViaToken, variantForInstall, bumpCohortStage } from "./attribution-link.js";
import { resolveLandingHomepageToken } from "./landing-experiments.js";

const MAX_ACTIVITY_DAYS = 90;
const agentWriteQueue = new Map<string, Promise<void>>();

function dateKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function normalizeActivityDates(dates: string[] | undefined): string[] {
  return Array.from(new Set((dates ?? []).filter(Boolean))).sort().slice(-MAX_ACTIVITY_DAYS);
}

async function queueAgentWrite<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const previous = agentWriteQueue.get(agentId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tracked = run.then(() => undefined, () => undefined);
  agentWriteQueue.set(agentId, tracked);
  try {
    return await run;
  } finally {
    if (agentWriteQueue.get(agentId) === tracked) {
      agentWriteQueue.delete(agentId);
    }
  }
}

async function mutateAgentProfile(
  env: Env,
  agentId: string,
  mutate: (profile: AgentProfile) => void | Promise<void>,
): Promise<void> {
  if (agentId === "__admin__") return;
  await queueAgentWrite(agentId, async () => {
    const profile = await ensureAgentProfile(env, agentId);
    await mutate(profile);
    profile.activity_dates = normalizeActivityDates(profile.activity_dates);
    await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
  });
}

function recoveredAgentName(agentId: string): string {
  return `recovered-${agentId.slice(-8)}`;
}

function walletLookupKey(walletAddress: string): string {
  return `wallet:${walletAddress}`;
}

export function normalizeWalletAddress(walletAddress: string): string {
  return walletAddress.trim();
}

export async function ensureAgentProfile(
  env: Env,
  agentId: string,
  seed?: Partial<Pick<AgentProfile, "name" | "created_at" | "tos_accepted_version" | "tos_accepted_at">>,
): Promise<AgentProfile> {
  const existing = await getAgent(env, agentId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const profile: AgentProfile = {
    agent_id: agentId,
    name: seed?.name?.trim() || recoveredAgentName(agentId),
    created_at: seed?.created_at || now,
    profile_origin: "recovered",
    recovered_at: now,
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: seed?.tos_accepted_version ?? CURRENT_TOS_VERSION,
    tos_accepted_at: seed?.tos_accepted_at ?? now,
    activity_dates: [],
  };
  await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
  return profile;
}

function useLocalAdminRegistration(env: Env): boolean {
  return env.API_KEY === "local-test";
}

export async function registerAgent(
  env: Env,
  name: string,
  tosVersion: string,
  wallet?: {
    wallet_address?: string;
    wallet_provider?: string;
    flex_escrow_address?: string;
    flex_session_key_address?: string;
    flex_facilitator?: string;
  },
  attribution?: { landing_token?: string },
): Promise<{ agent_id: string; api_key: string }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 64) {
    throw new Error("Name must be 2-64 characters");
  }

  const normalizedWallet = normalizeWalletAddress(wallet?.wallet_address ?? "");
  if (normalizedWallet) {
    const claimedBy = await getAgentIdByWallet(env, normalizedWallet);
    if (claimedBy) {
      throw new Error("wallet_already_claimed");
    }
  }

  if (useLocalAdminRegistration(env)) {
    return { agent_id: "__admin__", api_key: env.API_KEY };
  }

  const data = await createLocalKey(env, trimmed);

  const profile: AgentProfile = {
    agent_id: data.keyId,
    name: trimmed,
    created_at: new Date().toISOString(),
    wallet_address: normalizedWallet || undefined,
    wallet_provider: wallet?.wallet_provider?.trim() || undefined,
    flex_escrow_address: wallet?.flex_escrow_address?.trim() || undefined,
    flex_session_key_address: wallet?.flex_session_key_address?.trim() || undefined,
    flex_facilitator: wallet?.flex_facilitator?.trim() || undefined,
    profile_origin: "registered",
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: tosVersion,
    tos_accepted_at: new Date().toISOString(),
    activity_dates: [],
    ...(attribution?.landing_token ? { landing_token: attribution.landing_token } : {}),
  };
  await statsKV(env).put(`agent:${data.keyId}`, JSON.stringify(profile));
  // Funnel keystone (closes Step-1 break ①): decode the landing token → token_id, then
  // bind agent → install_id (the link install time wrote). Lets usage + revenue be
  // re-attributed to the acquisition cohort. Best-effort + idempotent — registration must
  // NEVER fail on attribution wiring.
  if (attribution?.landing_token) {
    try {
      const claims = await resolveLandingHomepageToken(env, attribution.landing_token);
      if (claims?.token_id) {
        const installId = await linkAgentViaToken(env, data.keyId, claims.token_id);
        if (installId) {
          const variant = (await variantForInstall(env, installId)) || "(unattributed)";
          await bumpCohortStage(env, variant, "registered", installId);
        }
      }
    } catch {
      /* attribution is best-effort; never block registration */
    }
  }
  if (normalizedWallet) {
    await statsKV(env).put(walletLookupKey(normalizedWallet), data.keyId);
  }

  // Grant welcome credits from subsidy pool (best-effort, don't fail registration)
  if (env.CREDITS_ENABLED === "1") {
    try {
      await grantCredits(env, data.keyId);
    } catch {
      // Pool may not be initialized yet — that's fine
    }
  }

  return { agent_id: data.keyId, api_key: data.key };
}

export async function getAgentIdByWallet(env: Env, walletAddress: string): Promise<string | null> {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return null;
  return await statsKV(env).get(walletLookupKey(normalized)) as string | null;
}

export async function updateAgentWallet(
  env: Env,
  agentId: string,
  wallet: { wallet_address?: string; wallet_provider?: string },
): Promise<{ profile: AgentProfile; status: "claimed" | "already_claimed" }> {
  const normalizedWallet = normalizeWalletAddress(wallet.wallet_address ?? "");
  if (!normalizedWallet) {
    throw new Error("wallet_address is required");
  }

  if (agentId === "__admin__") {
    return {
      profile: {
        agent_id: "__admin__",
        name: "admin",
        created_at: "",
        wallet_address: normalizedWallet,
        wallet_provider: wallet.wallet_provider?.trim() || undefined,
        skills_discovered: [],
        total_executions: 0,
        total_feedback_given: 0,
        tos_accepted_version: CURRENT_TOS_VERSION,
        tos_accepted_at: new Date().toISOString(),
        activity_dates: [],
      },
      status: "already_claimed",
    };
  }

  return await queueAgentWrite(agentId, async () => {
    const profile = await ensureAgentProfile(env, agentId);
    const existingWallet = normalizeWalletAddress(profile.wallet_address ?? "");
    const indexedAgentId = await getAgentIdByWallet(env, normalizedWallet);

    if (indexedAgentId && indexedAgentId !== agentId) {
      throw new Error("wallet_already_claimed");
    }
    if (existingWallet && existingWallet !== normalizedWallet) {
      throw new Error("wallet_already_claimed");
    }

    const status: "claimed" | "already_claimed" =
      existingWallet === normalizedWallet || indexedAgentId === agentId ? "already_claimed" : "claimed";

    if (!existingWallet) {
      profile.wallet_address = normalizedWallet;
    }
    if (wallet.wallet_provider?.trim()) {
      profile.wallet_provider = wallet.wallet_provider.trim();
    }

    await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
    if (!indexedAgentId) {
      await statsKV(env).put(walletLookupKey(normalizedWallet), agentId);
    }
    return { profile, status };
  });
}

/**
 * Update only the wallet_provider field on an agent profile. Used by the
 * payment-provider choice prompt (`unbrowse setup` Wave 1) to sync the
 * CLI-chosen rail up to the backend without requiring a wallet_address.
 *
 * Different shape from updateAgentWallet because the user may be picking
 * a provider (e.g. pay.sh) BEFORE they have a wallet to bind. For pay.sh
 * + lobster.cash the wallet lives inside the provider's own CLI, not in
 * the agent record. For external_solana + privy_embedded the wallet
 * binding flows through updateAgentWallet on a separate path (Wave 3
 * of wire-privy-authentication-end-to-end-for-unbrows wired that for
 * Privy via POST /v1/auth/privy/start).
 *
 * Accepts any string for forward-compat — the CLI validates the choice
 * before calling. Storing "skip" is meaningful (the user explicitly
 * picked free tier; we should not nag them about wallet setup).
 */
export async function updateAgentPaymentProvider(
  env: Env,
  agentId: string,
  provider: string,
): Promise<{ profile: AgentProfile }> {
  const cleaned = (provider ?? "").trim();
  if (!cleaned) throw new Error("provider is required");
  if (agentId === "__admin__") {
    return {
      profile: {
        agent_id: "__admin__",
        name: "admin",
        created_at: "",
        wallet_provider: cleaned,
        skills_discovered: [],
        total_executions: 0,
        total_feedback_given: 0,
        tos_accepted_version: CURRENT_TOS_VERSION,
        tos_accepted_at: new Date().toISOString(),
        activity_dates: [],
      },
    };
  }
  return await queueAgentWrite(agentId, async () => {
    const profile = await ensureAgentProfile(env, agentId);
    profile.wallet_provider = cleaned;
    await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
    return { profile };
  });
}

export async function acceptTos(env: Env, agentId: string, tosVersion: string): Promise<void> {
  const profile = await getAgent(env, agentId);
  if (!profile) throw new Error("Agent not found");
  profile.tos_accepted_version = tosVersion;
  profile.tos_accepted_at = new Date().toISOString();
  await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
}

export async function getAgent(env: Env, agentId: string): Promise<AgentProfile | null> {
  return await statsKV(env).get(`agent:${agentId}`, "json") as AgentProfile | null;
}

export async function listAgents(env: Env, limit = 20): Promise<AgentProfile[]> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries.slice(0, limit).map(e => JSON.parse(e.value) as AgentProfile);
}

export async function incrementAgentExecutions(env: Env, agentId: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateAgentProfile(env, agentId, (profile) => {
    profile.total_executions++;
    if (!profile.first_execution_at) profile.first_execution_at = now;
    profile.last_active_at = now;
  });
}

export async function incrementAgentFeedback(env: Env, agentId: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateAgentProfile(env, agentId, (profile) => {
    profile.total_feedback_given++;
    profile.last_active_at = now;
  });
}

export async function addSkillDiscovered(env: Env, agentId: string, skillId: string): Promise<void> {
  await mutateAgentProfile(env, agentId, (profile) => {
    if (!profile.skills_discovered.includes(skillId)) {
      profile.skills_discovered.push(skillId);
    }
  });
}

export async function recordAgentExecution(env: Env, agentId: string): Promise<void> {
  const now = new Date().toISOString();
  const today = dateKey(now);
  await mutateAgentProfile(env, agentId, (profile) => {
    profile.total_executions++;
    if (!profile.first_execution_at) profile.first_execution_at = now;
    profile.last_active_at = now;
    profile.activity_dates = normalizeActivityDates([...(profile.activity_dates ?? []), today]);
  });
}

export async function recordAgentFeedback(env: Env, agentId: string): Promise<void> {
  const now = new Date().toISOString();
  const today = dateKey(now);
  await mutateAgentProfile(env, agentId, (profile) => {
    profile.total_feedback_given++;
    profile.last_active_at = now;
    profile.activity_dates = normalizeActivityDates([...(profile.activity_dates ?? []), today]);
  });
}

export async function recordAgentActivity(env: Env, agentId: string, at = new Date()): Promise<void> {
  const now = at.toISOString();
  const today = dateKey(at);
  await mutateAgentProfile(env, agentId, (profile) => {
    profile.last_active_at = now;
    profile.activity_dates = normalizeActivityDates([...(profile.activity_dates ?? []), today]);
  });
}

export async function countAgents(env: Env): Promise<number> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries.length;
}
