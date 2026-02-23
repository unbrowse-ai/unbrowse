import type { Env, AgentProfile } from "../types.js";
import { statsKV } from "./kv.js";

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

export async function registerAgent(
  env: Env,
  name: string
): Promise<{ agent_id: string; api_key: string }> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 64) {
    throw new Error("Name must be 2-64 characters");
  }

  const data = await createUnkeyKey(env.UNKEY_ROOT_KEY, env.UNKEY_API_ID, trimmed);

  const profile: AgentProfile = {
    agent_id: data.keyId,
    name: trimmed,
    created_at: new Date().toISOString(),
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
  };
  await statsKV(env).put(`agent:${data.keyId}`, JSON.stringify(profile));

  return { agent_id: data.keyId, api_key: data.key };
}
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 64) {
    throw new Error("Name must be 2-64 characters");
  }

  const data = await createUnkeyKey(env.UNKEY_ROOT_KEY, env.UNKEY_API_ID, trimmed);

  // Store agent profile in STATS_KV
  const profile: AgentProfile = {
    agent_id: data.keyId,
    name: trimmed,
    created_at: new Date().toISOString(),
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
  };
  await env.STATS_KV.put(`agent:${data.keyId}`, JSON.stringify(profile));

  return { agent_id: data.keyId, api_key: data.key };
}

export async function getAgent(env: Env, agentId: string): Promise<AgentProfile | null> {
  return await statsKV(env).get(`agent:${agentId}`, "json") as AgentProfile | null;
}

export async function listAgents(env: Env, limit = 20): Promise<AgentProfile[]> {
  const kv = statsKV(env);
  const result = await kv.list({ prefix: "agent:", limit });
  const profiles = await Promise.all(result.keys.map((k) => kv.get(k.name, "json")));
  return profiles.filter(Boolean) as AgentProfile[];
}

export async function incrementAgentExecutions(env: Env, agentId: string): Promise<void> {
  if (agentId === "__admin__") return;
  const profile = await getAgent(env, agentId);
  if (!profile) return;
  profile.total_executions++;
  await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
}

export async function incrementAgentFeedback(env: Env, agentId: string): Promise<void> {
  if (agentId === "__admin__") return;
  const profile = await getAgent(env, agentId);
  if (!profile) return;
  profile.total_feedback_given++;
  await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
}

export async function addSkillDiscovered(env: Env, agentId: string, skillId: string): Promise<void> {
  if (agentId === "__admin__") return;
  const profile = await getAgent(env, agentId);
  if (!profile) return;
  if (!profile.skills_discovered.includes(skillId)) {
    profile.skills_discovered.push(skillId);
    await statsKV(env).put(`agent:${agentId}`, JSON.stringify(profile));
  }
}

export async function countAgents(env: Env): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const result = await statsKV(env).list({ prefix: "agent:", limit: 1000, cursor });
    count += result.keys.length;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return count;
}
