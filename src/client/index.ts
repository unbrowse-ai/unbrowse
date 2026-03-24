import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { randomBytes } from "crypto";
import { createInterface } from "readline";
import type { AgentSkillChunkView, EndpointStats, ExecutionTrace, OrchestrationTiming, SkillManifest, ValidationResult } from "../types/index.js";

const API_URL = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
const PROFILE_NAME = sanitizeProfileName(process.env.UNBROWSE_PROFILE ?? "");
const recentLocalSkills = new Map<string, SkillManifest>();
const LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY === "1";

function scopedSkillKey(skillId: string, scopeId?: string): string {
  return scopeId ? `${scopeId}:${skillId}` : skillId;
}

function getSkillCacheDir(): string {
  return process.env.UNBROWSE_SKILL_CACHE_DIR || join(getConfigDir(), "skill-cache");
}

function getConfigDir(): string {
  if (process.env.UNBROWSE_CONFIG_DIR) return process.env.UNBROWSE_CONFIG_DIR;
  return PROFILE_NAME
    ? join(homedir(), ".unbrowse", "profiles", PROFILE_NAME)
    : join(homedir(), ".unbrowse");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function sanitizeProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function getActiveProfile(): string {
  return PROFILE_NAME || "default";
}

export function isLocalOnlyMode(): boolean {
  return LOCAL_ONLY;
}

interface UnbrowseConfig {
  api_key: string;
  agent_id: string;
  agent_name: string;
  registered_at: string;
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
}

type ApiKeySource = "env" | "config";
type ApiKeyValidationStatus = "ok" | "missing_profile" | "invalid" | "offline";

interface ApiKeyValidationResult {
  status: ApiKeyValidationStatus;
  detail?: string;
}

function loadConfig(): UnbrowseConfig | null {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch { /* corrupt file, re-register */ }
  return null;
}

function saveConfig(config: UnbrowseConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function normalizeAgentEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAgentEmail(value: string): boolean {
  return EMAIL_RE.test(normalizeAgentEmail(value));
}

export function resolveAgentEmail(preferredEmail: string | undefined): string | null {
  const normalized = normalizeAgentEmail(preferredEmail ?? "");
  return isValidAgentEmail(normalized) ? normalized : null;
}

export function buildDefaultAgentName(): string {
  return `${hostname()}-${randomBytes(3).toString("hex")}`;
}

export function resolveAgentName(preferredEmail: string | undefined, fallbackName: string): string {
  return resolveAgentEmail(preferredEmail) ?? fallbackName;
}

function isEmailVerificationFlowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Email verification required|Email not verified yet/.test(message);
}

export function getApiKey(): string {
  if (LOCAL_ONLY) return "local-only";
  // Env var takes priority, then cached config
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
  const config = loadConfig();
  if (config?.api_key) {
    process.env.UNBROWSE_API_KEY = config.api_key;
    return config.api_key;
  }
  return "";
}

const API_TIMEOUT_MS = parseInt(process.env.UNBROWSE_API_TIMEOUT ?? "8000", 10);

async function validateApiKey(key: string): Promise<ApiKeyValidationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/v1/agents/me`, {
      method: "GET",
      headers: {
        "Accept-Encoding": "gzip, deflate",
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });

    let detail = "";
    try {
      const body = await res.json() as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {}

    if (res.ok) return { status: "ok" };
    if (res.status === 404 && /agent profile not found/i.test(detail)) {
      return { status: "missing_profile", detail };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "invalid", detail: detail || `HTTP ${res.status}` };
    }
    return { status: "offline", detail: detail || `HTTP ${res.status}` };
  } catch (err) {
    return { status: "offline", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function findUsableApiKey(): Promise<{ key: string; source: ApiKeySource } | null> {
  const envKey = process.env.UNBROWSE_API_KEY?.trim() ?? "";
  const configKey = loadConfig()?.api_key?.trim() ?? "";

  if (envKey) {
    const envStatus = await validateApiKey(envKey);
    if (envStatus.status === "ok") return { key: envKey, source: "env" };
    if (envStatus.status === "offline") return { key: envKey, source: "env" };
    console.warn(`[unbrowse] Ignoring ${envStatus.status === "missing_profile" ? "stale" : "invalid"} UNBROWSE_API_KEY${envStatus.detail ? ` (${envStatus.detail})` : ""}.`);
  }

  if (configKey && configKey !== envKey) {
    const configStatus = await validateApiKey(configKey);
    if (configStatus.status === "ok") {
      process.env.UNBROWSE_API_KEY = configKey;
      return { key: configKey, source: "config" };
    }
    if (configStatus.status === "offline") {
      process.env.UNBROWSE_API_KEY = configKey;
      return { key: configKey, source: "config" };
    }
    console.warn(`[unbrowse] Saved registration is ${configStatus.status === "missing_profile" ? "stale" : "invalid"}${configStatus.detail ? ` (${configStatus.detail})` : ""}. Re-registering.`);
  }

  return null;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { noAuth?: boolean; headers?: Record<string, string> },
): Promise<T> {
  const key = opts?.noAuth ? "" : getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        // Bun + Cloudflare Brotli bug: chunked br responses hang for ~40s.
        // Force identity encoding to avoid the issue.
        "Accept-Encoding": "gzip, deflate",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(opts?.headers ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

  if (!res.ok) {
    const errData = data as { error?: string; details?: string[] };
    const msg = errData.details?.length ? `${errData.error}: ${errData.details.join("; ")}` : errData.error ?? `API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// --- ToS acceptance ---

async function promptTosAcceptance(summary: string, tosUrl: string): Promise<boolean> {
  if (process.env.UNBROWSE_TOS_ACCEPTED === "1") {
    console.log("[unbrowse] ToS accepted by user via agent.");
    return true;
  }

  // Non-interactive mode: skip the readline prompt, return false.
  // The calling agent is expected to show the ToS to the user and ask for consent,
  // then re-run with UNBROWSE_TOS_ACCEPTED=1 after the user agrees.
  if (process.env.UNBROWSE_NON_INTERACTIVE === "1") {
    console.log("[unbrowse] ToS acceptance required. Set UNBROWSE_TOS_ACCEPTED=1 after user consents.");
    console.log(`[unbrowse] ToS summary:\n${summary}`);
    console.log(`[unbrowse] Full terms: ${tosUrl}`);
    return false;
  }

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

async function promptAgentEmail(existingEmail?: string): Promise<string> {
  const envEmail = process.env.UNBROWSE_AGENT_EMAIL;
  if (envEmail) {
    const resolved = resolveAgentEmail(envEmail);
    if (resolved) return resolved;
    console.warn(`[unbrowse] Ignoring invalid UNBROWSE_AGENT_EMAIL: ${envEmail}`);
  }

  const savedEmail = resolveAgentEmail(existingEmail);
  if (savedEmail) {
    return savedEmail;
  }

  if (process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("[unbrowse] Agent email required for CLI registration. Set UNBROWSE_AGENT_EMAIL to a valid email address.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question("\nEmail for this agent: ", resolve);
      });
      const trimmed = answer.trim();
      if (isValidAgentEmail(trimmed)) return normalizeAgentEmail(trimmed);
      console.log("Please enter a valid email address.");
    }
  } finally {
    rl.close();
  }
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
    await api("POST", "/v1/agents/accept-tos", { tos_version: tosInfo.version });

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

async function registerAndPersist(
  name: string,
  tosVersion?: string | null,
): Promise<void> {
  const requestRegistration = () => api<{
    agent_id: string;
    api_key: string;
    tos_accepted_version?: string;
    tos_accepted_at?: string;
    verification_required?: false;
  } | {
    verification_required: true;
    email: string;
    expires_at: string;
    verification_sent: boolean;
  }>("POST", "/v1/agents/register", {
    name,
    ...(tosVersion ? { tos_version: tosVersion } : {}),
  }, {
    headers: { "x-unbrowse-registration-source": "cli" },
  });

  let result = await requestRegistration();
  if ("verification_required" in result && result.verification_required) {
    const sentMessage = result.verification_sent ? "We sent a verification link." : "A verification link is already pending.";
    console.log(`[unbrowse] ${sentMessage} Check ${result.email} and verify it before continuing.`);

    if (process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`[unbrowse] Email verification required. Check ${result.email}, click the verification link, then rerun the command.`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await new Promise<void>((resolve) => {
        rl.question("\nPress Enter after verifying your email: ", () => resolve());
      });
    } finally {
      rl.close();
    }

    result = await requestRegistration();
    if ("verification_required" in result && result.verification_required) {
      throw new Error(`[unbrowse] Email not verified yet for ${result.email}. Click the link in your inbox, then rerun the command.`);
    }
  }

  process.env.UNBROWSE_API_KEY = result.api_key;
  saveConfig({
    api_key: result.api_key,
    agent_id: result.agent_id,
    agent_name: name,
    registered_at: new Date().toISOString(),
    tos_accepted_version: result.tos_accepted_version ?? tosVersion ?? null,
    tos_accepted_at: result.tos_accepted_at ?? new Date().toISOString(),
  });
}

/** Auto-register with the backend if no API key is configured. Persists to ~/.unbrowse/config.json. */
export async function ensureRegistered(): Promise<void> {
  if (LOCAL_ONLY) return;
  const usableKey = await findUsableApiKey();
  if (usableKey) {
    if (usableKey.source === "config") {
      console.log("[unbrowse] Restored saved registration.");
    }
    await checkTosStatus();
    return;
  }

  const existingConfig = loadConfig();
  if (existingConfig?.tos_accepted_version && process.env.UNBROWSE_TOS_ACCEPTED !== "1") {
    const name = await promptAgentEmail(existingConfig.agent_name);
    console.log(`Registering as "${name}"...`);

    try {
      await registerAndPersist(name, existingConfig.tos_accepted_version);
      console.log(`Registered as ${name}. API key saved to ~/.unbrowse/config.json`);
      return;
    } catch (err) {
      if (isEmailVerificationFlowError(err)) {
        throw err;
      }
      console.warn(`Registration failed: ${(err as Error).message}`);
      console.warn("Falling back to live ToS lookup.");
    }
  }

  // Step 1: Fetch current ToS version from backend
  let tosInfo: { version: string; summary: string; url: string };
  try {
    tosInfo = await api<{ version: string; summary: string; url: string }>("GET", "/v1/tos/current");
  } catch {
    console.warn("[unbrowse] Cannot reach unbrowse API. Registration requires internet access.");
    console.warn("[unbrowse] Set UNBROWSE_API_KEY manually or try again when online.");
    return;
  }

  // Step 2: Prompt for ToS acceptance
  const accepted = await promptTosAcceptance(tosInfo.summary, tosInfo.url);
  if (!accepted) {
    console.log("You must accept the Terms of Service to use Unbrowse.");
    process.exit(1);
  }

  // Step 3: Register with ToS version
  const name = await promptAgentEmail(existingConfig?.agent_name);
  console.log(`Registering as "${name}"...`);

  try {
    await registerAndPersist(name, tosInfo.version);
    console.log(`Registered as ${name}. API key saved to ~/.unbrowse/config.json`);
  } catch (err) {
    if (isEmailVerificationFlowError(err)) {
      throw err;
    }
    console.warn(`Registration failed: ${(err as Error).message}`);
    console.warn("Set UNBROWSE_API_KEY manually or try again.");
    process.exit(1);
  }
}

// --- Skill CRUD ---

// Disk snapshots for explicit local harness/debug flows.
// Runtime resolve/execution should treat remote/shared skills as source of truth.

function skillCachePath(skillId: string): string {
  return join(getSkillCacheDir(), `${skillId}.json`);
}

function readSkillCache(skillId: string): SkillManifest | null {
  try {
    const raw = readFileSync(skillCachePath(skillId), "utf-8");
    return JSON.parse(raw) as SkillManifest;
  } catch { return null; }
}

function writeSkillCache(skill: SkillManifest, scopeId?: string): void {
  try {
    recentLocalSkills.set(scopedSkillKey(skill.skill_id, scopeId), skill);
    const skillCacheDir = getSkillCacheDir();
    if (!existsSync(skillCacheDir)) mkdirSync(skillCacheDir, { recursive: true });
    // Preserve local-only fields that the backend doesn't know about
    const existing = readSkillCache(skill.skill_id);
    if (existing) {
      for (const ep of skill.endpoints) {
        const cached = existing.endpoints.find(e => e.endpoint_id === ep.endpoint_id);
        if (!ep.exec_strategy && cached?.exec_strategy) {
          ep.exec_strategy = cached.exec_strategy;
        }
        if (!ep.response_schema && cached?.response_schema) {
          ep.response_schema = cached.response_schema;
        }
      }
    }
    const hasStrategy = skill.endpoints.some(e => e.exec_strategy);
    if (hasStrategy) console.log(`[cache] writing skill ${skill.skill_id} with exec_strategy`);
    writeFileSync(skillCachePath(skill.skill_id), JSON.stringify(skill), "utf-8");
  } catch { /* non-critical — best effort */ }
}

export function cachePublishedSkill(skill: SkillManifest, scopeId?: string): void {
  recentLocalSkills.set(scopedSkillKey(skill.skill_id, scopeId), skill);
  writeSkillCache(skill, scopeId);
}

export function getRecentLocalSkill(skillId: string, scopeId?: string): SkillManifest | null {
  return recentLocalSkills.get(scopedSkillKey(skillId, scopeId)) ?? recentLocalSkills.get(skillId) ?? null;
}

/**
 * Find an existing cached skill for the same domain, so re-captures update
 * the existing skill instead of creating duplicates. Preserves skill_id and
 * exec_strategy across re-captures and server restarts.
 */
function normalizeIntent(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function intentFamily(value: string | undefined): string {
  const intent = normalizeIntent(value);
  if (!intent) return "";
  if (/\b(search|find|lookup)\b/.test(intent)) return `search:${intent.replace(/\b(search|find|lookup)\b/g, "").trim()}`;
  if (/\b(get|fetch|retrieve|view)\b/.test(intent)) return `get:${intent.replace(/\b(get|fetch|retrieve|view)\b/g, "").trim()}`;
  return intent;
}

function isIntentCompatible(lhs: string | undefined, rhs: string | undefined): boolean {
  const left = normalizeIntent(lhs);
  const right = normalizeIntent(rhs);
  if (!left || !right) return false;
  if (left === right) return true;
  return intentFamily(left) === intentFamily(right);
}

function normalizeContextPath(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, "");
    return pathname || "/";
  } catch {
    return null;
  }
}

function skillMatchesContextPath(skill: SkillManifest, contextUrl?: string): boolean {
  const contextPath = normalizeContextPath(contextUrl);
  if (!contextPath) return true;
  for (const endpoint of skill.endpoints) {
    const triggerPath = normalizeContextPath(endpoint.trigger_url);
    if (triggerPath === contextPath) return true;
    const templatePath = normalizeContextPath(endpoint.url_template);
    if (templatePath === contextPath) return true;
  }
  return false;
}

export function findExistingSkillForDomain(domain: string, intent?: string, contextUrl?: string): SkillManifest | null {
  try {
    const skillCacheDir = getSkillCacheDir();
    if (!existsSync(skillCacheDir)) return null;
    const files = readdirSync(skillCacheDir);
    let compatible: SkillManifest | null = null;
    let fallback: SkillManifest | null = null;
    let pathCompatible: SkillManifest | null = null;
    let pathFallback: SkillManifest | null = null;
    for (const f of files) {
      if (!f.endsWith(".json") || f === "browser-capture.json") continue;
      try {
        const raw = readFileSync(join(skillCacheDir, f), "utf-8");
        const skill = JSON.parse(raw) as SkillManifest;
        if (skill.domain === domain && skill.execution_type === "http") {
          if (!fallback) fallback = skill;
          if (skillMatchesContextPath(skill, contextUrl) && !pathFallback) {
            pathFallback = skill;
          }
          const intentCompatible =
            isIntentCompatible(skill.intent_signature, intent) ||
            (skill.intents ?? []).some((candidate) => isIntentCompatible(candidate, intent));
          if (intentCompatible) {
            compatible = skill;
            if (skillMatchesContextPath(skill, contextUrl)) {
              pathCompatible = skill;
              break;
            }
          }
        }
      } catch { /* skip corrupt files */ }
    }
    if (contextUrl && normalizeContextPath(contextUrl)) {
      if (intent && normalizeIntent(intent)) return pathCompatible;
      return pathFallback;
    }
    if (intent && normalizeIntent(intent)) return compatible;
    return compatible ?? fallback;
  } catch { /* cache dir doesn't exist */ }
  return null;
}

export async function getSkill(skillId: string, scopeId?: string): Promise<SkillManifest | null> {
  const recent = getRecentLocalSkill(skillId, scopeId ?? process.env.UNBROWSE_CLIENT_ID);
  if (recent) return recent;
  const cached = readSkillCache(skillId);
  if (LOCAL_ONLY) {
    return cached;
  }
  try {
    const skill = await api<SkillManifest>("GET", `/v1/skills/${skillId}`, undefined, { noAuth: true });
    writeSkillCache(skill, scopeId);
    return skill;
  } catch {
    return cached;
  }
}

export async function getSkillChunk(
  skillId: string,
  opts?: {
    intent?: string;
    operation_id?: string;
    known_bindings?: Record<string, unknown>;
    max_operations?: number;
  }
): Promise<AgentSkillChunkView> {
  if (LOCAL_ONLY) throw new Error("local-only mode does not support remote chunk fetch");
  return api("POST", `/v1/skills/${skillId}/chunk`, opts ?? {});
}

export async function listSkills(): Promise<SkillManifest[]> {
  if (LOCAL_ONLY) {
    try {
      if (!existsSync(SKILL_CACHE_DIR)) return [];
      return readdirSync(SKILL_CACHE_DIR)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
          try { return JSON.parse(readFileSync(join(SKILL_CACHE_DIR, file), "utf-8")) as SkillManifest; }
          catch { return null; }
        })
        .filter((skill): skill is SkillManifest => !!skill);
    } catch {
      return [];
    }
  }
  const data = await api<{ skills: SkillManifest[] }>("GET", "/v1/skills");
  return data.skills;
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest & { warnings: string[] }> {
  if (!draft.endpoints || draft.endpoints.length === 0) {
    const now = new Date().toISOString();
    return {
      ...draft,
      skill_id: draft.skill_id ?? "local-empty-skill",
      version: draft.version ?? "1.0.0",
      created_at: now,
      updated_at: now,
      warnings: ["skipped_publish_empty_endpoints"],
    } as SkillManifest & { warnings: string[] };
  }
  if (LOCAL_ONLY) throw new Error("local-only mode");
  return api("POST", "/v1/skills", draft);
}

export async function deprecateSkill(skillId: string): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("DELETE", `/v1/skills/${skillId}`, undefined);
}

export async function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: string
): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("PATCH", `/v1/skills/${skillId}/endpoints/${endpointId}`, { score, status });
}

export async function updateEndpointSchema(
  skillId: string,
  endpointId: string,
  schema: import("../types/index.js").ResponseSchema
): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("PATCH", `/v1/skills/${skillId}/endpoints/${endpointId}`, { response_schema: schema });
}

export async function getEndpointSchema(
  skillId: string,
  endpointId: string
): Promise<unknown | null> {
  if (LOCAL_ONLY) return null;
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
  if (LOCAL_ONLY) return [];
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
  if (LOCAL_ONLY) return [];
  const data = await api<{ results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> }>(
    "POST", "/v1/search/domain", { intent, domain, k }
  );
  return data.results;
}

export async function searchIntentResolve(
  intent: string,
  domain?: string,
  domainK = 5,
  globalK = 10,
): Promise<{
  domain_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
  global_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
  skipped_global: boolean;
}> {
  if (LOCAL_ONLY) return { domain_results: [], global_results: [], skipped_global: false };
  try {
    return await api<{
      domain_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
      global_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
      skipped_global: boolean;
    }>("POST", "/v1/search/resolve", {
      intent,
      domain,
      domain_k: domainK,
      global_k: globalK,
    });
  } catch {
    const [domain_results, global_results] = await Promise.all([
      domain
        ? searchIntentInDomain(intent, domain, domainK).catch(() => [] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>)
        : Promise.resolve([] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>),
      searchIntent(intent, globalK).catch(() => [] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>),
    ]);
    return { domain_results, global_results, skipped_global: false };
  }
}

// --- Stats ---

export async function recordExecution(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace
): Promise<void> {
  if (LOCAL_ONLY) return;
  // Strip actual API response data — only send metadata for scoring
  const { result: _result, ...metadata } = trace;
  await api("POST", "/v1/stats/execution", {
    skill_id: skillId,
    endpoint_id: endpointId,
    trace: metadata,
  });
}

export async function recordFeedback(
  skillId: string,
  endpointId: string,
  rating: number
): Promise<number> {
  if (LOCAL_ONLY) return rating;
  const data = await api<{ avg_rating: number }>("POST", "/v1/stats/feedback", {
    skill_id: skillId,
    endpoint_id: endpointId,
    rating,
  });
  return data.avg_rating;
}

// --- Diagnostics ---

export async function recordDiagnostics(
  skillId: string,
  endpointId: string,
  diagnostics: Record<string, unknown>
): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("POST", "/v1/stats/diagnostics", {
    skill_id: skillId,
    endpoint_id: endpointId,
    ...diagnostics,
  });
}

// --- Orchestration Perf ---

export async function recordOrchestrationPerf(timing: OrchestrationTiming): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("POST", "/v1/stats/perf", timing);
}

// --- Validation ---

export async function validateManifest(manifest: unknown): Promise<ValidationResult> {
  if (LOCAL_ONLY) return { valid: true, hardErrors: [], softWarnings: [] };
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
  return api("GET", "/v1/agents/me", undefined);
}
