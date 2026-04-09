import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { randomBytes, createHash } from "crypto";
import { createInterface } from "readline";
import type { AgentSkillChunkView, EndpointStats, ExecutionTrace, OrchestrationTiming, SkillManifest, ValidationResult } from "../types/index.js";
import { ensureCascadeSplitForSkill } from "../payments/cascade.js";
import { attributeLifecycle } from "../runtime/lifecycle.js";
import type { LifecycleEvent } from "../runtime/lifecycle.js";
import { detectHostEnvironment } from "../runtime/browser-host.js";

const API_URL = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
const PROFILE_NAME = sanitizeProfileName(process.env.UNBROWSE_PROFILE ?? "");
const recentLocalSkills = new Map<string, SkillManifest>();
const LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY === "1";

function decodeBase64Json(value: string): unknown {
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
      const binary = globalThis.atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return JSON.parse(new TextDecoder("utf-8").decode(bytes));
    }
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function isX402Error(err: unknown): err is Error & { x402: true; terms?: unknown; status?: number } {
  return !!err && typeof err === "object" && (err as { x402?: unknown }).x402 === true;
}

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

function getInstallTelemetryPath(): string {
  return join(getConfigDir(), "install-state.json");
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
  wallet_address?: string;
  wallet_provider?: string;
}

interface InstallTelemetryState {
  install_id: string;
  first_seen_at: string;
  cli_first_seen_reported_at?: string;
}

type TelemetryHostType = "cli" | "codex" | "openclaw" | "mcp" | "native" | "unknown";
type InstallTelemetrySource = "host" | "setup" | "cli-first-seen";
type FunnelTelemetrySource = "host" | "setup" | "cli-first-seen" | "cli" | "agent" | "server";

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

function loadInstallTelemetryState(): InstallTelemetryState | null {
  try {
    const statePath = getInstallTelemetryPath();
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, "utf-8")) as InstallTelemetryState;
    }
  } catch {}
  return null;
}

function saveInstallTelemetryState(state: InstallTelemetryState): void {
  const configDir = getConfigDir();
  const statePath = getInstallTelemetryPath();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function createInstallTelemetryState(): InstallTelemetryState {
  return {
    install_id: `install_${randomBytes(8).toString("hex")}`,
    first_seen_at: new Date().toISOString(),
  };
}

function getOrCreateInstallTelemetryState(): InstallTelemetryState {
  const existing = loadInstallTelemetryState();
  if (existing?.install_id) return existing;
  const created = createInstallTelemetryState();
  saveInstallTelemetryState(created);
  return created;
}

export function getInstallId(): string {
  return getOrCreateInstallTelemetryState().install_id;
}

export function detectTelemetryHostType(): TelemetryHostType {
  switch (detectHostEnvironment()) {
    case "openai":
      return "codex";
    case "openclaw":
      return "openclaw";
    case "mcp":
      return "mcp";
    case "native":
      return "native";
    case "unknown":
    default:
      return "cli";
  }
}

async function postTelemetry(path: string, body: Record<string, unknown>): Promise<boolean> {
  if (LOCAL_ONLY) return false;

  try {
    const key = getApiKey();
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureCliInstallTracked(hostType = detectTelemetryHostType()): Promise<void> {
  const state = getOrCreateInstallTelemetryState();
  if (state.cli_first_seen_reported_at) return;

  const createdAt = new Date().toISOString();
  const ok = await postTelemetry("/v1/telemetry/install", {
    install_id: state.install_id,
    source: "cli-first-seen",
    host_type: hostType,
    skill: "unbrowse",
    status: "installed",
    created_at: createdAt,
    properties: {
      profile: getActiveProfile(),
      first_seen_at: state.first_seen_at,
    },
  });

  if (!ok) return;
  state.cli_first_seen_reported_at = createdAt;
  saveInstallTelemetryState(state);
}

export async function recordInstallTelemetryEvent(
  source: InstallTelemetrySource,
  options?: {
    hostType?: TelemetryHostType;
    status?: string;
    createdAt?: string;
    properties?: Record<string, unknown>;
    skill?: string;
    skillVersion?: string;
  },
): Promise<void> {
  const createdAt = options?.createdAt ?? new Date().toISOString();
  await postTelemetry("/v1/telemetry/install", {
    install_id: getInstallId(),
    source,
    host_type: options?.hostType ?? detectTelemetryHostType(),
    skill: options?.skill ?? "unbrowse",
    skill_version: options?.skillVersion,
    status: options?.status ?? "installed",
    created_at: createdAt,
    properties: options?.properties,
  });
}

export async function recordFunnelTelemetryEvent(
  name: string,
  options?: {
    source?: FunnelTelemetrySource;
    hostType?: TelemetryHostType;
    createdAt?: string;
    sessionId?: string;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const createdAt = options?.createdAt ?? new Date().toISOString();
  await postTelemetry("/v1/telemetry/events", {
    install_id: getInstallId(),
    session_id: options?.sessionId,
    name,
    source: options?.source ?? "cli",
    host_type: options?.hostType ?? detectTelemetryHostType(),
    created_at: createdAt,
    properties: options?.properties,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function normalizeAgentEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAgentEmail(value: string): boolean {
  return EMAIL_RE.test(normalizeAgentEmail(value));
}

export function buildDefaultAgentName(): string {
  return `${hostname()}-${randomBytes(3).toString("hex")}`;
}

export function resolveAgentName(preferredEmail: string | undefined, fallbackName: string): string {
  const normalized = normalizeAgentEmail(preferredEmail ?? "");
  return isValidAgentEmail(normalized) ? normalized : fallbackName;
}

export function getLocalWalletContext(): { wallet_address?: string; wallet_provider?: string } {
  const lobsterWallet = process.env.LOBSTER_WALLET_ADDRESS?.trim();
  if (lobsterWallet) {
    return { wallet_address: lobsterWallet, wallet_provider: "lobster.cash" };
  }

  const genericWallet = process.env.AGENT_WALLET_ADDRESS?.trim();
  if (genericWallet) {
    return {
      wallet_address: genericWallet,
      wallet_provider: process.env.AGENT_WALLET_PROVIDER?.trim() || undefined,
    };
  }

  return {};
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

/**
* Derive a stable, privacy-safe indexer identifier from the raw API key.
 * Returns a hex SHA-256 hash, or "" for empty / local-only keys.
 */
export function hashApiKey(key: string): string {
  if (!key || key === "local-only") return "";
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Return the locally registered agent_id, or null if not registered.
 * Used as the default indexer_id for Tier 1 attribution when the skill
 * manifest doesn't already carry one.
 */
export function getAgentId(): string | null {
  const config = loadConfig();
  return config?.agent_id ?? null;
}

const API_TIMEOUT_MS = parseInt(process.env.UNBROWSE_API_TIMEOUT ?? "8000", 10);
const PUBLISH_TIMEOUT_MS = parseInt(process.env.UNBROWSE_PUBLISH_TIMEOUT ?? "30000", 10);

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

async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { noAuth?: boolean; timeoutMs?: number },
): Promise<{ data: T; headers: Headers }> {
  const key = opts?.noAuth ? "" : getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? API_TIMEOUT_MS);
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

  // Handle x402 payment required — surface payment terms to the caller
  if (res.status === 402) {
    const paymentRequired = res.headers.get("PAYMENT-REQUIRED");
    const legacyPaymentTerms = res.headers.get("X-Payment-Required");
    const terms = paymentRequired
      ? decodeBase64Json(paymentRequired)
      : legacyPaymentTerms
        ? JSON.parse(legacyPaymentTerms)
        : (data as Record<string, unknown>).terms;
    const err = new Error(`Payment required: ${(data as Record<string, unknown>).error ?? "This skill requires payment"}`);
    (err as Error & { x402: boolean; terms: unknown; status: number }).x402 = true;
    (err as Error & { terms: unknown }).terms = terms;
    (err as Error & { status: number }).status = 402;
    throw err;
  }

  if (!res.ok) {
    const errData = data as { error?: string; details?: string[] };
    const msg = errData.details?.length ? `${errData.error}: ${errData.details.join("; ")}` : errData.error ?? `API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { data: data as T, headers: res.headers };
}

async function api<T = unknown>(method: string, path: string, body?: unknown, opts?: { noAuth?: boolean; timeoutMs?: number }): Promise<T> {
  const { data } = await apiRequest<T>(method, path, body, opts);
  return data;
}

// --- ToS acceptance ---

async function promptTosAcceptance(summary: string, tosUrl: string): Promise<boolean> {
  // Non-interactive mode: skip the readline prompt, return false.
  // The calling agent is expected to show the ToS to the user and ask for consent,
  // then re-run with UNBROWSE_TOS_ACCEPTED=1 after the user agrees.
  if (process.env.UNBROWSE_NON_INTERACTIVE === "1") {
    if (process.env.UNBROWSE_TOS_ACCEPTED === "1") {
      console.log("[unbrowse] ToS accepted by user via agent.");
      return true;
    }
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

async function promptAgentEmail(defaultName: string): Promise<string> {
  const envEmail = process.env.UNBROWSE_AGENT_EMAIL;
  if (envEmail) {
    const resolved = resolveAgentName(envEmail, defaultName);
    if (resolved !== defaultName) return resolved;
    console.warn(`[unbrowse] Ignoring invalid UNBROWSE_AGENT_EMAIL: ${envEmail}`);
  }

  if (process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultName;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question("\nEmail for this agent (leave blank to use a local device id): ", resolve);
      });
      const trimmed = answer.trim();
      if (!trimmed) return defaultName;
      if (isValidAgentEmail(trimmed)) return normalizeAgentEmail(trimmed);
      console.log("Please enter a valid email address or press Enter to skip.");
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

/** Auto-register with the backend if no API key is configured. Persists to ~/.unbrowse/config.json. */
export async function ensureRegistered(options?: { promptForEmail?: boolean }): Promise<void> {
  if (LOCAL_ONLY) return;
  const usableKey = await findUsableApiKey();
  if (usableKey) {
    if (usableKey.source === "config") {
      console.log("[unbrowse] Restored saved registration.");
    }
    await checkTosStatus();
    try {
      const profile = await getMyProfile();
      const wallet = getLocalWalletContext();
      if (wallet.wallet_address && profile.wallet_address !== wallet.wallet_address) {
        await syncAgentWallet(wallet);
      }
    } catch { /* non-fatal */ }
    return;
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
  const fallbackName = buildDefaultAgentName();
  const name = options?.promptForEmail ? await promptAgentEmail(fallbackName) : resolveAgentName(process.env.UNBROWSE_AGENT_EMAIL, fallbackName);
  console.log(`Registering as "${name}"...`);

  try {
    const wallet = getLocalWalletContext();
    const { agent_id, api_key } = await api<{ agent_id: string; api_key: string }>(
      "POST", "/v1/agents/register", { name, tos_version: tosInfo.version, ...wallet }
    );

    process.env.UNBROWSE_API_KEY = api_key;
    saveConfig({
      api_key,
      agent_id,
      agent_name: name,
      registered_at: new Date().toISOString(),
      tos_accepted_version: tosInfo.version,
      tos_accepted_at: new Date().toISOString(),
      ...wallet,
    });

    await recordFunnelTelemetryEvent("registration_succeeded", {
      source: "cli",
      properties: {
        prompt_for_email: options?.promptForEmail === true,
      },
    });

    console.log(`Registered as ${name}. API key saved to ~/.unbrowse/config.json`);
  } catch (err) {
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

export function findExistingSkillForDomain(domain: string, intent?: string): SkillManifest | null {
  try {
    const skillCacheDir = getSkillCacheDir();
    if (!existsSync(skillCacheDir)) return null;
    const files = readdirSync(skillCacheDir);
    let compatible: SkillManifest | null = null;
    let fallback: SkillManifest | null = null;
    for (const f of files) {
      if (!f.endsWith(".json") || f === "browser-capture.json") continue;
      try {
        const raw = readFileSync(join(skillCacheDir, f), "utf-8");
        const skill = JSON.parse(raw) as SkillManifest;
        if (skill.domain === domain && skill.execution_type === "http") {
          if (!fallback) fallback = skill;
          if (isIntentCompatible(skill.intent_signature, intent) || (skill.intents ?? []).some((candidate) => isIntentCompatible(candidate, intent))) {
            compatible = skill;
            break;
          }
        }
      } catch { /* skip corrupt files */ }
    }
    if (intent && normalizeIntent(intent)) return compatible;
    return compatible ?? fallback;
  } catch { /* cache dir doesn't exist */ }
  return null;
}

export async function getSkill(skillId: string, scopeId?: string): Promise<SkillManifest | null> {
  const recent = getRecentLocalSkill(skillId, scopeId ?? process.env.UNBROWSE_CLIENT_ID);
  if (recent) return recent;
  if (LOCAL_ONLY) {
    return readSkillCache(skillId);
  }
  try {
    const skill = await api<SkillManifest>("GET", `/v1/skills/${skillId}`, undefined, { noAuth: true });
    writeSkillCache(skill, scopeId);
    return skill;
  } catch {
    return null;
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
  const wallet = getLocalWalletContext();
  const published = await api<SkillManifest & { warnings: string[] }>("POST", "/v1/skills", {
    ...draft,
    ...(wallet.wallet_address ? wallet : {}),
  }, { timeoutMs: PUBLISH_TIMEOUT_MS });

  const cascade = await ensureCascadeSplitForSkill(published).catch((err) => ({
    warning: `cascade_split_failed:${(err as Error).message}`,
  }));
  const warnings = [...(published.warnings ?? [])];
  if (cascade.warning) warnings.push(cascade.warning);

  if (cascade.split_config && cascade.split_config !== published.split_config) {
    const updated = await api<SkillManifest>("PATCH", `/v1/skills/${published.skill_id}`, {
      split_config: cascade.split_config,
    });
    return {
      ...updated,
      warnings,
    };
  }

  return { ...published, warnings };
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
  actual_cost_uc?: number;
}> {
  if (LOCAL_ONLY) return { domain_results: [], global_results: [], skipped_global: false };
  try {
    const { data, headers } = await apiRequest<{
      domain_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
      global_results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
      skipped_global: boolean;
    }>("POST", "/v1/search/resolve", {
      intent,
      domain,
      domain_k: domainK,
      global_k: globalK,
    });
    const actualCostHeader = headers.get("X-Unbrowse-Cost-Uc");
    const actualCostUc = actualCostHeader && /^\d+$/.test(actualCostHeader)
      ? Number(actualCostHeader)
      : undefined;
    return actualCostUc != null ? { ...data, actual_cost_uc: actualCostUc } : data;
  } catch (err) {
    if (isX402Error(err)) throw err;
    const [domain_results, global_results] = await Promise.all([
      domain
        ? searchIntentInDomain(intent, domain, domainK).catch((fallbackErr) => {
            if (isX402Error(fallbackErr)) throw fallbackErr;
            return [] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
          })
        : Promise.resolve([] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>),
      searchIntent(intent, globalK).catch((fallbackErr) => {
        if (isX402Error(fallbackErr)) throw fallbackErr;
        return [] as Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
      }),
    ]);
    return { domain_results, global_results, skipped_global: false };
  }
}

// --- Stats ---

/** Execution payload sent to POST /v1/stats/execution */
export interface ExecutionPayload {
  skill_id: string;
  endpoint_id: string;
  trace: Omit<ExecutionTrace, "result">;
  indexer_id?: string;
}

export interface AnalyticsSessionPayload {
  session_id: string;
  started_at: string;
  completed_at?: string;
  trace_version?: string;
  api_calls: number;
  discovery_queries?: number;
  cached_skill_calls?: number;
  fresh_index_calls?: number;
  browser_mode?: "default" | "replaced" | "manual" | "unknown";
  success?: boolean;
  source?: string;
  time_saved_ms?: number;
  time_saved_pct?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  cost_saved_uc?: number;
}

/**
 * Build the POST body for /v1/stats/execution.
 * Pure function — no I/O, fully testable.
 *
 * Derives indexer_id from:
 *   1. Explicit override (opts.indexer_id)
 *   2. skill.indexer_id (set by the backend at publish time)
 *   3. undefined (backend will fall back to its own lookup)
 */
export function buildExecutionPayload(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace,
  skill?: Pick<SkillManifest, "indexer_id"> | null,
  opts?: { indexer_id?: string },
): ExecutionPayload {
  const { result: _result, ...metadata } = trace;
  const indexer_id = opts?.indexer_id ?? skill?.indexer_id ?? (hashApiKey(getApiKey()) || undefined);
  const payload: ExecutionPayload = {
    skill_id: skillId,
    endpoint_id: endpointId,
    trace: metadata,
  };
  if (indexer_id) payload.indexer_id = indexer_id;
  return payload;
}
export async function recordExecution(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace,
  skill?: Pick<SkillManifest, "indexer_id"> | null,
): Promise<void> {
  if (LOCAL_ONLY) return;
  const payload = buildExecutionPayload(skillId, endpointId, trace, skill);
  await api("POST", "/v1/stats/execution", payload);
}

export async function recordAnalyticsSession(payload: AnalyticsSessionPayload): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("POST", "/v1/analytics/sessions", payload);
}

/** Record a payment transaction for a paid skill execution. Fire-and-forget. */
export async function recordTransaction(params: {
  transaction_id: string;
  consumer_id: string;
  creator_id?: string;
  skill_id: string;
  endpoint_id?: string;
  price_usd: number;
  payment_proof?: string;
}): Promise<void> {
  if (LOCAL_ONLY) return;
  await api("POST", "/v1/transactions", params);
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
  const lifecycleSource: LifecycleEvent["source"] =
    timing.source === "marketplace" ? "marketplace"
    : timing.source === "live-capture" ? "live-capture"
    : "cache";
  const now = new Date().toISOString();
  const events: LifecycleEvent[] = [];
  if (timing.search_ms > 0) {
    events.push({ phase: "discover", skill_id: timing.skill_id ?? "", timestamp: now, duration_ms: timing.search_ms, source: lifecycleSource });
  }
  if (timing.get_skill_ms > 0) {
    events.push({ phase: "resolve", skill_id: timing.skill_id ?? "", timestamp: now, duration_ms: timing.get_skill_ms, source: lifecycleSource });
  }
  if (timing.execute_ms > 0) {
    events.push({ phase: "execute", skill_id: timing.skill_id ?? "", timestamp: now, duration_ms: timing.execute_ms, source: lifecycleSource });
  }
  const phaseTotals = Object.fromEntries(attributeLifecycle(events));
  await api("POST", "/v1/stats/perf", { ...timing, phase_totals_ms: phaseTotals });
}

// --- Validation ---

export async function validateManifest(manifest: unknown): Promise<ValidationResult> {
  if (LOCAL_ONLY) return { valid: true, hardErrors: [], softWarnings: [] };
  return api<ValidationResult>("POST", "/v1/validate", manifest);
}

// --- Graph Edge Publishing ---

/**
 * Publish operation graph edges to the dedicated graph endpoint.
 * Fire-and-forget: logs errors but does not throw.
 */
export async function publishGraphEdges(
  domain: string,
  node: { endpoint_id: string; method: string; url_template: string },
  edges: Array<{ target_endpoint_id: string; kind: string; confidence: number }>
): Promise<void> {
  if (LOCAL_ONLY) return;
  try {
    await api("POST", "/v1/graph/edges", { domain, node, edges });
  } catch (err) {
    console.error(`[graph] failed to publish edges for ${domain}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-file GitHub issues from accumulated agent errors
// ---------------------------------------------------------------------------

export interface AutoFilePayload {
  skill_id: string;
  endpoint_id: string;
  domain: string;
  intent: string;
  url?: string;
  error: string;
  failure_count: number;
  first_seen: string;
  last_seen: string;
  kuri_version: string;
}

/**
 * Auto-file a GitHub issue via the backend. Fire-and-forget — failures
 * are logged but never thrown.
 */
export async function autoFileIssue(payload: AutoFilePayload): Promise<void> {
  if (isLocalOnlyMode()) {
    console.log(`[auto-file] skipped (local-only mode): ${payload.skill_id}:${payload.endpoint_id}`);
    return;
  }
  try {
    await api("POST", "/v1/issues/auto-file", payload);
    console.log(`[auto-file] issue filed for ${payload.skill_id}:${payload.endpoint_id} (${payload.failure_count} failures)`);
  } catch (err) {
    console.warn(`[auto-file] failed: ${(err as Error).message}`);
  }
}

// --- Cross-Agent Discovery Diagnostics ---

/**
 * Diagnostic function: polls marketplace search to verify a skill is discoverable.
 * Not called in production flow -- used for verifying cross-agent discovery within 60s.
 */
export async function verifyMarketplaceDiscovery(
  skillId: string,
  intent: string,
  maxWaitMs = 60000
): Promise<{ found: boolean; latency_ms: number }> {
  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < maxWaitMs) {
    try {
      const results = await searchIntent(intent, 10);
      for (const result of results) {
        const meta = result.metadata ?? {};
        let foundId: string | undefined;
        // Check metadata.skill_id directly
        if (typeof meta.skill_id === "string") {
          foundId = meta.skill_id;
        }
        // Try parsing metadata.content as JSON for skill_id
        if (!foundId && typeof meta.content === "string") {
          try {
            const parsed = JSON.parse(meta.content);
            if (typeof parsed.skill_id === "string") foundId = parsed.skill_id;
          } catch { /* not JSON */ }
        }
        if (foundId === skillId) {
          return { found: true, latency_ms: Date.now() - start };
        }
      }
    } catch { /* search failed, retry */ }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { found: false, latency_ms: Date.now() - start };
}

// --- Agent Registration ---

export async function registerAgent(
  name: string,
  wallet: { wallet_address?: string; wallet_provider?: string } = getLocalWalletContext(),
): Promise<{ agent_id: string; api_key: string }> {
  return api<{ agent_id: string; api_key: string }>("POST", "/v1/agents/register", { name, ...wallet });
}

export async function getAgent(agentId: string): Promise<{
  agent_id: string;
  name: string;
  created_at: string;
  wallet_address?: string | null;
  wallet_provider?: string | null;
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
} | null> {
  try {
    return await api("GET", `/v1/agents/${agentId}`);
  } catch {
    return null;
  }
}

export async function getMyProfile(): Promise<{
  agent_id: string;
  name: string;
  created_at: string;
  wallet_address?: string | null;
  wallet_provider?: string | null;
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
}> {
  return api("GET", "/v1/agents/me", undefined);
}

export async function syncAgentWallet(wallet = getLocalWalletContext()): Promise<void> {
  if (!wallet.wallet_address) return;
  await api("POST", "/v1/agents/wallet", wallet);
  const config = loadConfig();
  if (!config) return;
  saveConfig({ ...config, ...wallet });
}


// --- Transaction Visibility ---

/** Get consumer payment history for an agent. */
export async function getTransactionHistory(agentId: string): Promise<{
  ledger: {
    agent_id: string;
    total_spent_uc: number;
    total_spent_usd: number;
    transaction_count: number;
    first_transaction_at: string;
    last_transaction_at: string;
  } | null;
  transactions: Array<{
    transaction_id: string;
    consumer_id: string;
    creator_id: string;
    skill_id: string;
    price_usd: number;
    price_uc: number;
    status: string;
    created_at: string;
  }>;
}> {
  return api("GET", `/v1/transactions/consumer/${agentId}`);
}

/** Get creator earnings history for an agent/indexer. */
export async function getCreatorEarnings(agentId: string): Promise<{
  ledger: {
    agent_id: string;
    total_earned_uc: number;
    total_earned_usd: number;
    total_fees_uc: number;
    transaction_count: number;
    first_transaction_at: string;
    last_transaction_at: string;
  } | null;
  transactions: Array<{
    transaction_id: string;
    consumer_id: string;
    creator_id: string;
    skill_id: string;
    price_usd: number;
    creator_payout_uc: number;
    status: string;
    created_at: string;
  }>;
}> {
  return api("GET", `/v1/transactions/creator/${agentId}`);
}

/** Set the base price for a skill (requires auth as skill owner). */
export async function setSkillPrice(skillId: string, priceUsd: number): Promise<unknown> {
  return api("PATCH", `/v1/skills/${skillId}`, { base_price_usd: priceUsd });
}

export async function setSkillSplitConfig(skillId: string, splitConfig: string | null): Promise<unknown> {
  return api("PATCH", `/v1/skills/${skillId}`, { split_config: splitConfig });
}
