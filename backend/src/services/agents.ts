import type { Env, AgentProfile } from "../types.js";
import { statsKV } from "./kv.js";
import { CURRENT_TOS_VERSION } from "../tos.js";

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

async function createUnkeyKey(
  rootKey: string,
  apiId: string,
  name: string
): Promise<{ keyId: string; key: string }> {
  const res = await fetch("https://api.unkey.com/v2/keys.createKey", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${rootKey}`,
    },
    body: JSON.stringify({
      apiId,
      prefix: "ubr",
      name,
      meta: { agent_name: name, created_at: new Date().toISOString() },
    }),
  });
  const json = await res.json() as { data?: { keyId: string; key: string }; error?: { message: string } };
  if (!res.ok || !json.data) {
    throw new Error(json.error?.message ?? `Unkey API error: ${res.status}`);
  }
  return json.data;
}

function useLocalAdminRegistration(env: Env): boolean {
  return env.UNKEY_ROOT_KEY === "local-test" && env.API_KEY === "local-test";
}

export async function registerAgent(
  env: Env,
  name: string,
  tosVersion: string,
  wallet?: { wallet_address?: string; wallet_provider?: string },
): Promise<{ agent_id: string; api_key: string }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 64) {
    throw new Error("Name must be 2-64 characters");
  }

  if (useLocalAdminRegistration(env)) {
    return { agent_id: "__admin__", api_key: env.API_KEY };
  }

  const data = await createUnkeyKey(env.UNKEY_ROOT_KEY, env.UNKEY_API_ID, trimmed);

  const profile: AgentProfile = {
    agent_id: data.keyId,
    name: trimmed,
    created_at: new Date().toISOString(),
    wallet_address: wallet?.wallet_address?.trim() || undefined,
    wallet_provider: wallet?.wallet_provider?.trim() || undefined,
    profile_origin: "registered",
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: tosVersion,
    tos_accepted_at: new Date().toISOString(),
    activity_dates: [],
  };
  await statsKV(env).put(`agent:${data.keyId}`, JSON.stringify(profile));

  return { agent_id: data.keyId, api_key: data.key };
}

export async function updateAgentWallet(
  env: Env,
  agentId: string,
  wallet: { wallet_address?: string; wallet_provider?: string },
): Promise<AgentProfile> {
  if (agentId === "__admin__") {
    return {
      agent_id: "__admin__",
      name: "admin",
      created_at: "",
      wallet_address: wallet.wallet_address?.trim() || undefined,
      wallet_provider: wallet.wallet_provider?.trim() || undefined,
      skills_discovered: [],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: CURRENT_TOS_VERSION,
      tos_accepted_at: new Date().toISOString(),
      activity_dates: [],
    };
  }

  return await queueAgentWrite(agentId, async () => {
    const profile = await ensureAgentProfile(env, agentId);
    profile.wallet_address = wallet.wallet_address?.trim() || undefined;
    profile.wallet_provider = wallet.wallet_provider?.trim() || undefined;
    await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
    return profile;
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
