import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { randomBytes } from "crypto";
import { createInterface } from "readline";
import type { EndpointStats, ExecutionTrace, SkillManifest, ValidationResult } from "../types/index.js";

const API_URL = "https://beta-api.unbrowse.ai";
const CONFIG_DIR = join(homedir(), ".unbrowse");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface UnbrowseConfig {
  api_key: string;
  agent_id: string;
  agent_name: string;
  registered_at: string;
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
}

function loadConfig(): UnbrowseConfig | null {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* corrupt file, re-register */ }
  return null;
}

function saveConfig(config: UnbrowseConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getApiKey(): string {
  // Env var takes priority, then cached config
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
  const config = loadConfig();
  if (config?.api_key) {
    process.env.UNBROWSE_API_KEY = config.api_key;
    return config.api_key;
  }
  return "";
}

async function api<T = unknown>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
  const key = getApiKey();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth && key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T & { error?: string };
  try {
    data = await res.json() as T & { error?: string };
  } catch {
    // Backend returned a non-JSON response (e.g. CF Worker error page)
    throw new Error(`API error ${res.status} from ${path}`);
  }

  // Handle ToS update required — tell user to restart
  if (res.status === 403 && (data as Record<string, unknown>).error === "tos_update_required") {
    console.warn("\n[unbrowse] The Terms of Service have been updated.");
    console.warn("[unbrowse] Please restart the unbrowse service to accept the new terms.");
    throw new Error("ToS update required. Restart unbrowse to accept new terms.");
  }

  if (!res.ok) throw new Error((data as { error?: string }).error ?? `API HTTP ${res.status}`);
  return data;
}

// --- ToS acceptance ---

async function promptTosAcceptance(summary: string, tosUrl: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n" + "=".repeat(60));
  console.log("UNBROWSE TERMS OF SERVICE");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));

  return new Promise<boolean>((resolve) => {
    rl.question("\nDo you accept the Terms of Service? (y/n): ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function checkTosStatus(): Promise<void> {
  const config = loadConfig();

  let tosInfo: { version: string; summary: string; url: string };
  try {
    tosInfo = await api<{ version: string; summary: string; url: string }>("GET", "/v1/tos/current");
  } catch {
    // Offline — allow usage with whatever ToS was previously accepted.
    // Backend will enforce on next actual API call anyway.
    return;
  }

  if (config?.tos_accepted_version === tosInfo.version) {
    return; // Already accepted current version
  }

  // Need re-acceptance
  console.log("\nThe Unbrowse Terms of Service have been updated.");
  const accepted = await promptTosAcceptance(tosInfo.summary, tosInfo.url);
  if (!accepted) {
    console.log("You must accept the updated Terms of Service to continue using Unbrowse.");
    process.exit(1);
  }

  // Call accept-tos endpoint
  try {
    await api("POST", "/v1/agents/accept-tos", { tos_version: tosInfo.version }, true);

    // Update local config
    if (config) {
      config.tos_accepted_version = tosInfo.version;
      config.tos_accepted_at = new Date().toISOString();
      saveConfig(config);
    }
    console.log("Terms of Service accepted.");
  } catch (err) {
    console.warn(`Failed to record ToS acceptance: ${(err as Error).message}`);
    // Don't block — backend will enforce on next call
  }
}

/** Auto-register with the backend if no API key is configured. Persists to ~/.unbrowse/config.json. */
export async function ensureRegistered(): Promise<void> {
  if (getApiKey()) {
    // Already have a key — check if ToS re-acceptance is needed
    await checkTosStatus();
    return;
  }

  // Step 1: Fetch current ToS version from backend
  let tosInfo: { version: string; summary: string; url: string };
  try {
    tosInfo = await api<{ version: string; summary: string; url: string }>("GET", "/v1/tos/current");
  } catch {
    console.warn("Cannot reach unbrowse API. Registration requires internet access.");
    console.warn("Set UNBROWSE_API_KEY manually or try again when online.");
    return;
  }

  // Step 2: Prompt for ToS acceptance
  const accepted = await promptTosAcceptance(tosInfo.summary, tosInfo.url);
  if (!accepted) {
    console.log("You must accept the Terms of Service to use Unbrowse.");
    process.exit(1);
  }

  // Step 3: Register with ToS version
  const name = `${hostname()}-${randomBytes(3).toString("hex")}`;
  console.log(`Registering as "${name}"...`);

  try {
    const { agent_id, api_key } = await api<{ agent_id: string; api_key: string }>(
      "POST", "/v1/agents/register", { name, tos_version: tosInfo.version }
    );

    process.env.UNBROWSE_API_KEY = api_key;
    saveConfig({
      api_key,
      agent_id,
      agent_name: name,
      registered_at: new Date().toISOString(),
      tos_accepted_version: tosInfo.version,
      tos_accepted_at: new Date().toISOString(),
    });

    console.log("Registered! API key cached in ~/.unbrowse/config.json");
  } catch (err) {
    console.warn(`Registration failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// --- Skill CRUD ---

export async function getSkill(skillId: string): Promise<SkillManifest | null> {
  try {
    return await api<SkillManifest>("GET", `/v1/skills/${skillId}`);
  } catch {
    return null;
  }
}

export async function listSkills(): Promise<SkillManifest[]> {
  const data = await api<{ skills: SkillManifest[] }>("GET", "/v1/skills");
  return data.skills;
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<{ skill_id: string; version: string; warnings: string[] }> {
  return api("POST", "/v1/skills", draft, true);
}

export async function deprecateSkill(skillId: string): Promise<void> {
  await api("DELETE", `/v1/skills/${skillId}`, undefined, true);
}

export async function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: string
): Promise<void> {
  await api("PATCH", `/v1/skills/${skillId}/endpoints/${endpointId}`, { score, status }, true);
}

export async function getEndpointSchema(
  skillId: string,
  endpointId: string
): Promise<unknown | null> {
  try {
    return await api("GET", `/v1/skills/${skillId}/endpoints/${endpointId}/schema`);
  } catch {
    return null;
  }
}

// --- Search ---

export async function searchIntent(
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const data = await api<{ results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> }>(
    "POST", "/v1/search", { intent, k }
  );
  return data.results;
}

export async function searchIntentInDomain(
  intent: string,
  domain: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const data = await api<{ results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> }>(
    "POST", "/v1/search/domain", { intent, domain, k }
  );
  return data.results;
}

// --- Stats ---

export async function recordExecution(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace
): Promise<void> {
  // Strip actual API response data — only send metadata for scoring
  const { result: _result, ...metadata } = trace;
  await api("POST", "/v1/stats/execution", {
    skill_id: skillId,
    endpoint_id: endpointId,
    trace: metadata,
  }, true);
}

export async function recordFeedback(
  skillId: string,
  endpointId: string,
  rating: number
): Promise<number> {
  const data = await api<{ avg_rating: number }>("POST", "/v1/stats/feedback", {
    skill_id: skillId,
    endpoint_id: endpointId,
    rating,
  }, true);
  return data.avg_rating;
}

// --- Validation ---

export async function validateManifest(manifest: unknown): Promise<ValidationResult> {
  return api<ValidationResult>("POST", "/v1/validate", manifest);
}

// --- Agent Registration ---

export async function registerAgent(name: string): Promise<{ agent_id: string; api_key: string }> {
  return api<{ agent_id: string; api_key: string }>("POST", "/v1/agents/register", { name });
}

export async function getAgent(agentId: string): Promise<{ agent_id: string; name: string; created_at: string; skills_discovered: string[]; total_executions: number; total_feedback_given: number } | null> {
  try {
    return await api("GET", `/v1/agents/${agentId}`);
  } catch {
    return null;
  }
}

export async function getMyProfile(): Promise<{ agent_id: string; name: string; created_at: string; skills_discovered: string[]; total_executions: number; total_feedback_given: number }> {
  return api("GET", "/v1/agents/me", undefined, true);
}
