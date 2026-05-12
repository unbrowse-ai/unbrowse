import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, hostname, release as osRelease } from "os";
import { randomBytes, createHash } from "crypto";
import { createInterface } from "readline";
import { execSync } from "child_process";
import type {
  AgentSkillChunkView,
  EndpointStats,
  ExecutionTrace,
  OrchestrationTiming,
  RoutingTelemetryEvent,
  SkillManifest,
  ValidationResult,
} from "../types/index.js";
import {
  CODE_HASH,
  DEFAULT_BACKEND_URL,
  DEFAULT_PROFILE,
  GIT_SHA,
  PACKAGE_VERSION,
  RELEASE_MANIFEST_BASE64,
  RELEASE_MANIFEST_SIGNATURE,
  TRACE_VERSION,
} from "../version.js";
import { ensureCascadeSplitForSkill } from "../payments/cascade.js";
import { getWalletContext } from "../payments/wallet.js";
import { attributeLifecycle } from "../runtime/lifecycle.js";
import type { LifecycleEvent } from "../runtime/lifecycle.js";
import { detectHostEnvironment } from "../runtime/browser-host.js";
import {
  decodeTelemetryAttribution,
  mergeTelemetryAttribution,
  mergeTelemetryProperties,
  type TelemetryAttribution,
} from "../telemetry-attribution.js";

const API_URL = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;
const PROFILE_NAME = sanitizeProfileName(process.env.UNBROWSE_PROFILE ?? DEFAULT_PROFILE ?? "");
const recentLocalSkills = new Map<string, SkillManifest>();
const LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY === "1";

export function buildReleaseAttestationHeaders(
  manifestBase64: string,
  signature: string,
): Record<string, string> {
  const manifest = manifestBase64.trim();
  const sig = signature.trim();
  if (!manifest || !sig) return {};
  return {
    "X-Unbrowse-Release-Manifest": manifest,
    "X-Unbrowse-Release-Signature": sig,
  };
}

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

function getLandingToken(): string | undefined {
  // 1. Prefer env var (set during npm install or manual invocation)
  const envToken = process.env.UNBROWSE_LANDING_TOKEN?.trim();
  if (envToken) return envToken;

  // 2. Fall back to file persisted by postinstall.mjs
  //    This bridges the gap: postinstall writes the token during npm install,
  //    and the CLI reads it back on first invocation (e.g. `unbrowse setup`).
  //    One-shot: delete after reading so it doesn't leak into future sessions.
  try {
    const attributionPath = join(homedir(), ".unbrowse", "landing-attribution.json");
    if (existsSync(attributionPath)) {
      const raw = readFileSync(attributionPath, "utf8");
      const data = JSON.parse(raw);
      const fileToken = typeof data.landing_token === "string" ? data.landing_token.trim() : undefined;

      // Also restore UNBROWSE_ATTRIBUTION_B64 into env so readInstallAttributionFromEnv() picks it up
      if (typeof data.attribution_b64 === "string" && !process.env.UNBROWSE_ATTRIBUTION_B64) {
        process.env.UNBROWSE_ATTRIBUTION_B64 = data.attribution_b64;
      }

      // Delete the file — one-shot consumption
      try { unlinkSync(attributionPath); } catch { /* best-effort */ }

      if (fileToken) return fileToken;
    }
  } catch { /* best-effort — never block CLI startup */ }

  return undefined;
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

export interface UnbrowseConfig {
  api_key: string;
  agent_id: string;
  agent_name: string;
  registered_at: string;
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
  email?: string;
  user_id?: string;
  wallet_address?: string;
  wallet_provider?: string;
  ignore_env_api_key?: boolean;
}

interface InstallTelemetryState {
  install_id: string;
  first_seen_at: string;
  cli_first_seen_reported_at?: string;
  attribution?: TelemetryAttribution;
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

export function loadConfig(): UnbrowseConfig | null {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch { /* corrupt file, re-register */ }
  return null;
}

export function resetLocalRegistration(): { removed: boolean; config_path: string } {
  const configPath = getConfigPath();
  try {
    if (!existsSync(configPath)) return { removed: false, config_path: configPath };
    unlinkSync(configPath);
    return { removed: true, config_path: configPath };
  } catch {
    return { removed: false, config_path: configPath };
  }
}

export function saveConfig(config: UnbrowseConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

interface DashboardPairingRecord {
  token: string;
  created_at: string;
  expires_at: string;
}

function getPairingDir(): string {
  return join(getConfigDir(), "pairing");
}

function safePairingToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function createDashboardPairingToken(ttlMs = 120_000): DashboardPairingRecord {
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  const record: DashboardPairingRecord = {
    token,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  const dir = getPairingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${token}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export function consumeDashboardPairingToken(token: string): (DashboardPairingRecord & { config: UnbrowseConfig }) | null {
  const safe = safePairingToken(token);
  if (!safe || safe !== token) return null;
  const file = join(getPairingDir(), `${safe}.json`);
  try {
    if (!existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, "utf-8")) as DashboardPairingRecord;
    try { unlinkSync(file); } catch { /* best effort */ }
    if (!record.expires_at || Date.parse(record.expires_at) < Date.now()) return null;
    const config = loadConfig();
    if (!config?.api_key || !config.agent_id) return null;
    return { ...record, config };
  } catch {
    try { unlinkSync(file); } catch { /* best effort */ }
    return null;
  }
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

function readInstallAttributionFromEnv(): TelemetryAttribution | undefined {
  return decodeTelemetryAttribution(process.env.UNBROWSE_ATTRIBUTION_B64);
}

function getOrCreateInstallTelemetryState(): InstallTelemetryState {
  const existing = loadInstallTelemetryState();
  const incomingAttribution = readInstallAttributionFromEnv();

  if (existing?.install_id) {
    const mergedAttribution = mergeTelemetryAttribution(existing.attribution, incomingAttribution);
    if (JSON.stringify(mergedAttribution ?? null) !== JSON.stringify(existing.attribution ?? null)) {
      const nextState: InstallTelemetryState = {
        ...existing,
        attribution: mergedAttribution,
      };
      saveInstallTelemetryState(nextState);
      return nextState;
    }
    return existing;
  }

  const created = createInstallTelemetryState();
  const nextState: InstallTelemetryState = {
    ...created,
    attribution: incomingAttribution,
  };
  saveInstallTelemetryState(nextState);
  return nextState;
}

export function getInstallId(): string {
  return getOrCreateInstallTelemetryState().install_id;
}

export function getTelemetryAttribution(): TelemetryAttribution | undefined {
  return getOrCreateInstallTelemetryState().attribution;
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
  const landingToken = getLandingToken();
  const ok = await postTelemetry("/v1/telemetry/install", {
    install_id: state.install_id,
    landing_token: landingToken,
    source: "cli-first-seen",
    host_type: hostType,
    skill: "unbrowse",
    status: "installed",
    created_at: createdAt,
    properties: mergeTelemetryProperties({
      profile: getActiveProfile(),
      first_seen_at: state.first_seen_at,
    }, state.attribution),
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
  const landingToken = getLandingToken();
  await postTelemetry("/v1/telemetry/install", {
    install_id: getInstallId(),
    landing_token: landingToken,
    source,
    host_type: options?.hostType ?? detectTelemetryHostType(),
    skill: options?.skill ?? "unbrowse",
    skill_version: options?.skillVersion,
    status: options?.status ?? "installed",
    created_at: createdAt,
    properties: mergeTelemetryProperties({ ...getRuntimeContext(), ...options?.properties }, getTelemetryAttribution()),
  });
}

function getRuntimeContext(): Record<string, unknown> {
  return {
    cli_version: PACKAGE_VERSION,
    code_hash: CODE_HASH,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: osRelease(),
  };
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
  const landingToken = getLandingToken();
  await postTelemetry("/v1/telemetry/events", {
    install_id: getInstallId(),
    session_id: options?.sessionId,
    landing_token: landingToken,
    name,
    source: options?.source ?? "cli",
    host_type: options?.hostType ?? detectTelemetryHostType(),
    created_at: createdAt,
    properties: mergeTelemetryProperties({ ...getRuntimeContext(), ...options?.properties }, getTelemetryAttribution()),
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
  return getWalletContext();
}

export function getApiKey(): string {
  if (LOCAL_ONLY) return "local-only";
  const config = loadConfig();
  if (config?.ignore_env_api_key && config.api_key) {
    process.env.UNBROWSE_API_KEY = config.api_key;
    return config.api_key;
  }
  // Env var takes priority, then cached config
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
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
  opts?: { noAuth?: boolean; timeoutMs?: number; skipAutoUpdate?: boolean; extraHeaders?: Record<string, string> },
): Promise<{ data: T; headers: Headers }> {
  const key = opts?.noAuth ? "" : getApiKey();
  const releaseAttestationHeaders = buildReleaseAttestationHeaders(
    RELEASE_MANIFEST_BASE64,
    RELEASE_MANIFEST_SIGNATURE,
  );
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
        "X-Unbrowse-Trace-Version": TRACE_VERSION,
        "X-Unbrowse-Code-Hash": CODE_HASH,
        "X-Unbrowse-Git-Sha": GIT_SHA,
        ...releaseAttestationHeaders,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(opts?.extraHeaders ?? {}),
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

  // Handle 426 — client outdated or verification failed. Auto-update, restart, and retry once.
  if (res.status === 426 && !opts?.skipAutoUpdate) {
    const errCode = (data as Record<string, unknown>).error;
    if (errCode === "client_update_required" || errCode === "client_verification_failed") {
      console.warn(`\n[unbrowse] Server requires a client update (${errCode}).`);
      console.warn("[unbrowse] Attempting automatic update...");
      try {
        const updateCmd = process.env.UNBROWSE_UPDATE_COMMAND || "curl -fsSL https://unbrowse.ai/install.sh | bash";
        execSync(updateCmd, { stdio: "inherit", timeout: 120_000 });
        console.warn("[unbrowse] Update installed. Restarting server...");
        // Kill stale server processes so the new binary takes over
        try { execSync("pkill -9 -f 'unbrowse|kuri'", { stdio: "ignore", timeout: 5_000 }); } catch { /* may not match */ }
        // Brief pause for process cleanup
        await new Promise((r) => setTimeout(r, 2_000));
        console.warn("[unbrowse] Retrying request with updated client...");
        return apiRequest<T>(method, path, body, { ...opts, skipAutoUpdate: true });
      } catch (updateErr) {
        console.warn(`[unbrowse] Auto-update failed: ${(updateErr as Error).message}`);
        const cmd = (data as Record<string, unknown>).update_command ?? "curl -fsSL https://unbrowse.ai/install.sh | bash";
        console.warn(`[unbrowse] Please update manually: ${cmd}`);
        throw new Error(`Client update required. Run: ${cmd}`);
      }
    }
  }

  // Handle x402 payment required — attempt lobster pay-and-retry before surfacing
  if (res.status === 402) {
    const paymentRequired = res.headers.get("PAYMENT-REQUIRED");
    const legacyPaymentTerms = res.headers.get("X-Payment-Required");
    const terms = paymentRequired
      ? decodeBase64Json(paymentRequired)
      : legacyPaymentTerms
        ? JSON.parse(legacyPaymentTerms)
        : (data as Record<string, unknown>).terms;

    // Try lobster.cash automatic payment before throwing
    try {
      const { isLobsterAvailable, payAndRetry } = await import("../payments/lobster-pay.js");
      if (isLobsterAvailable()) {
        const fullUrl = `${API_URL}${path}`;
        const paidResult = await payAndRetry<T>(fullUrl, {
          body,
          headers: {
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip, deflate",
            ...releaseAttestationHeaders,
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
        });
        if (paidResult) {
          return { data: paidResult.data, headers: new Headers() };
        }
      }
    } catch (payErr) {
      console.warn(`[x402] lobster pay-and-retry failed: ${(payErr as Error).message}`);
    }

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

async function api<T = unknown>(method: string, path: string, body?: unknown, opts?: { noAuth?: boolean; timeoutMs?: number; extraHeaders?: Record<string, string> }): Promise<T> {
  const { data } = await apiRequest<T>(method, path, body, opts);
  return data;
}

// --- Install attribution ---

function parseInstallAttribution(): { landing_token?: string } {
  const token = process.env.UNBROWSE_LANDING_TOKEN;
  if (token && token.length < 2048) return { landing_token: token };
  return {};
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

async function checkTosStatus(options?: { exitOnFailure?: boolean }): Promise<boolean> {
  const exitOnFailure = options?.exitOnFailure ?? true;
  const config = loadConfig();

  let tosInfo: { version: string; summary: string; url: string };
  try {
    tosInfo = await api<{ version: string; summary: string; url: string }>("GET", "/v1/tos/current");
  } catch {
    // Offline — allow usage with whatever ToS was previously accepted.
    // Backend will enforce on next actual API call anyway.
    return true;
  }

  if (config?.tos_accepted_version === tosInfo.version) {
    return true; // Already accepted current version
  }

  // Need re-acceptance
  console.log("\nThe Unbrowse Terms of Service have been updated.");
  const accepted = await promptTosAcceptance(tosInfo.summary, tosInfo.url);
  if (!accepted) {
    console.log("You must accept the updated Terms of Service to continue using Unbrowse.");
    if (exitOnFailure) process.exit(1);
    return false;
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
  return true;
}

/** Auto-register with the backend if no API key is configured. Persists to ~/.unbrowse/config.json. */
export async function ensureRegistered(options?: { promptForEmail?: boolean; exitOnFailure?: boolean }): Promise<void> {
  if (LOCAL_ONLY) return;
  // Harness/server mode: skip ToS prompts entirely
  if (process.env.UNBROWSE_SKIP_TOS_CHECK === "1") {
    console.log("[unbrowse] ToS check skipped (non-interactive/server mode)");
    return;
  }
  const exitOnFailure = options?.exitOnFailure ?? true;
  const usableKey = await findUsableApiKey();
  if (usableKey) {
    if (usableKey.source === "config") {
      console.log("[unbrowse] Restored saved registration.");
    }
    const accepted = await checkTosStatus({ exitOnFailure });
    if (!accepted) return;
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
    if (exitOnFailure) process.exit(1);
    return;
  }

  // Step 3: Register with ToS version
  const fallbackName = buildDefaultAgentName();
  const name = options?.promptForEmail ? await promptAgentEmail(fallbackName) : resolveAgentName(process.env.UNBROWSE_AGENT_EMAIL, fallbackName);
  console.log(`Registering as "${name}"...`);

  try {
    const wallet = getLocalWalletContext();
    const attribution = parseInstallAttribution();
    let registeredWallet = wallet;
    let registration: { agent_id: string; api_key: string };
    try {
      registration = await api<{ agent_id: string; api_key: string }>(
        "POST", "/v1/agents/register", { name, tos_version: tosInfo.version, ...wallet, ...attribution }
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!wallet.wallet_address || !msg.includes("wallet_already_claimed")) throw err;
      console.warn("[unbrowse] Wallet is already claimed by another agent. Registering this CLI without a payout wallet; sign in by email or run `unbrowse register --email ... --reset` to recover that account.");
      registeredWallet = {};
      registration = await api<{ agent_id: string; api_key: string }>(
        "POST", "/v1/agents/register", { name, tos_version: tosInfo.version, ...attribution }
      );
    }
    const { agent_id, api_key } = registration;

    process.env.UNBROWSE_API_KEY = api_key;
    saveConfig({
      api_key,
      agent_id,
      agent_name: name,
      registered_at: new Date().toISOString(),
      tos_accepted_version: tosInfo.version,
      tos_accepted_at: new Date().toISOString(),
      ...(process.env.UNBROWSE_IGNORE_ENV_API_KEY === "1" ? { ignore_env_api_key: true } : {}),
      ...registeredWallet,
    });

    await recordFunnelTelemetryEvent("registration_succeeded", {
      source: "cli",
      properties: {
        prompt_for_email: options?.promptForEmail === true,
      },
    });

    console.log(`Registered as ${name}. API key saved to ~/.unbrowse/config.json`);
    console.log(`\nYou have $2.00 in free credits — start resolving to use them.`);
    console.log(`As you browse, you earn credits when other agents use your indexed routes.`);
    console.log(`Run \`unbrowse earnings\` anytime to check your balance.`);
  } catch (err) {
    console.warn(`Registration failed: ${(err as Error).message}`);
    console.warn("Set UNBROWSE_API_KEY manually or try again.");
    if (exitOnFailure) process.exit(1);
  }
}

export interface MagicRegisterResult {
  api_key: string;
  agent_id: string;
  email: string;
  user_id: string;
}

/**
 * Email magic-link register flow. Posts /v1/auth/email/start, opens the verify
 * URL in the user's default browser, then polls /v1/auth/email/poll until the
 * user clicks the link. Returns the new api_key + user_id, or throws on
 * timeout / backend error. Does NOT persist to ~/.unbrowse/config.json — the
 * caller (CLI) is responsible for saveConfig.
 */
export async function magicRegister(opts: {
  email: string;
  openBrowser?: (verifyUrl: string) => void | Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  returnUrl?: string;
}): Promise<MagicRegisterResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 1_500;

  // 1. Start: mint a magic token, send the email.
  const startRes = await fetch(`${API_URL}/v1/auth/email/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
    body: JSON.stringify({ email: opts.email, return_url: opts.returnUrl }),
  });
  if (startRes.status === 503) {
    throw new Error(
      "Backend RESEND_API_KEY not set — magic-link signup unavailable. Use anon `unbrowse register` (no --email).",
    );
  }
  let startData: { token?: string; error?: string; message?: string };
  try {
    startData = await startRes.json() as typeof startData;
  } catch {
    throw new Error(`Magic-link start failed: HTTP ${startRes.status}`);
  }
  if (startRes.status === 400) {
    throw new Error(startData.error ?? "invalid_email");
  }
  if (!startRes.ok || !startData.token) {
    const msg = startData.error ?? `HTTP ${startRes.status}`;
    throw new Error(`Magic-link start failed: ${msg}`);
  }
  const token = startData.token;

  // 2. Open the verify URL in the user's browser (best-effort).
  const verifyUrl = `${API_URL}/v1/auth/email/verify?cli=1&token=${encodeURIComponent(token)}`;
  if (opts.openBrowser) {
    try { await opts.openBrowser(verifyUrl); } catch { /* best-effort */ }
  } else {
    try {
      const cmd = process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
      execSync(`${cmd} ${JSON.stringify(verifyUrl)}`, { stdio: "ignore", timeout: 5_000 });
    } catch { /* best-effort */ }
  }

  // 3. Poll until verified (or expired / timeout).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollRes = await fetch(
      `${API_URL}/v1/auth/email/poll?token=${encodeURIComponent(token)}`,
      {
        method: "GET",
        headers: { "Accept-Encoding": "gzip, deflate" },
      },
    );
    let pollData: {
      status?: string;
      api_key?: string;
      agent_id?: string;
      user_id?: string;
      email?: string;
    };
    try {
      pollData = await pollRes.json() as typeof pollData;
    } catch {
      throw new Error(`Magic-link poll failed: HTTP ${pollRes.status}`);
    }
    if (pollData.status === "verified") {
      if (!pollData.api_key || !pollData.agent_id || !pollData.user_id || !pollData.email) {
        throw new Error("Magic-link poll returned verified without api_key/agent_id/user_id/email.");
      }
      return {
        api_key: pollData.api_key,
        agent_id: pollData.agent_id,
        email: pollData.email,
        user_id: pollData.user_id,
      };
    }
    if (pollData.status === "expired" || pollRes.status === 410) {
      throw new Error("Magic link expired. Re-run `unbrowse register --email …`.");
    }
    if (pollData.status === "pending") continue;
    if (!pollRes.ok) {
      throw new Error(`Magic-link poll failed: HTTP ${pollRes.status}`);
    }
  }
  throw new Error(`Magic-link timed out after ${Math.round(timeoutMs / 1000)}s. Check your inbox and re-run.`);
}

let backgroundRegistrationPromise: Promise<void> | null = null;

export function startBackgroundRegistration(options?: { promptForEmail?: boolean }): Promise<void> {
  if (LOCAL_ONLY) return Promise.resolve();
  if (backgroundRegistrationPromise) return backgroundRegistrationPromise;
  backgroundRegistrationPromise = ensureRegistered({
    promptForEmail: options?.promptForEmail,
    exitOnFailure: false,
  })
    .catch((err) => {
      console.warn(`[unbrowse] Background registration failed: ${(err as Error).message}`);
    })
    .finally(() => {
      backgroundRegistrationPromise = null;
    });
  return backgroundRegistrationPromise;
}

export async function waitForBackgroundRegistration(timeoutMs = 0): Promise<void> {
  if (!backgroundRegistrationPromise) return;
  if (timeoutMs <= 0) {
    await backgroundRegistrationPromise;
    return;
  }
  await Promise.race([
    backgroundRegistrationPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
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
        if (!ep.response_schema && cached?.response_schema) {
          ep.response_schema = cached.response_schema;
        }
      }
    }
    writeFileSync(skillCachePath(skill.skill_id), JSON.stringify(skill), "utf-8");
  } catch { /* non-critical — best effort */ }
}

export function cachePublishedSkill(skill: SkillManifest, scopeId?: string): void {
  recentLocalSkills.set(scopedSkillKey(skill.skill_id, scopeId), skill);
  writeSkillCache(skill, scopeId);
}

/**
 * Evict a single endpoint from the cached SkillManifest after the runtime sees a
 * hard "this endpoint is gone" signal (HTTP 404/410, stale_endpoint, etc.). Keeps
 * the skill manifest itself alive so other endpoints under the same skill remain
 * callable. Returns true if an endpoint was removed.
 *
 * Without this, the local route cache keeps serving a dead endpoint until TTL
 * expiry, even after the backend auto-deprecates it. Two-layer fix: the backend
 * marks it disabled (so resolve stops returning it for OTHER clients), and the
 * client evicts it (so THIS client stops trying it on subsequent resolves).
 */
export function evictCachedEndpoint(skillId: string, endpointId: string, scopeId?: string): boolean {
  try {
    const skill = getRecentLocalSkill(skillId, scopeId);
    if (!skill || !Array.isArray(skill.endpoints)) return false;
    const before = skill.endpoints.length;
    const next = skill.endpoints.filter((e) => e.endpoint_id !== endpointId);
    if (next.length === before) return false;
    const updated: SkillManifest = { ...skill, endpoints: next };
    recentLocalSkills.set(scopedSkillKey(skillId, scopeId), updated);
    // Persist so a process restart doesn't resurrect the dead endpoint.
    try {
      const skillCacheDir = getSkillCacheDir();
      if (!existsSync(skillCacheDir)) mkdirSync(skillCacheDir, { recursive: true });
      writeFileSync(skillCachePath(skillId), JSON.stringify(updated), "utf-8");
    } catch { /* best-effort */ }
    return true;
  } catch { return false; }
}


export function getRecentLocalSkill(skillId: string, scopeId?: string): SkillManifest | null {
  // 1. In-memory recent map (per-process; cleared on restart).
  const inMemory = recentLocalSkills.get(scopedSkillKey(skillId, scopeId)) ?? recentLocalSkills.get(skillId);
  if (inMemory) return inMemory;
  // 2. On-disk cache fallback. Captures write to skill-cache/<id>.json — without
  //    this fallback, mutations like publish/index/feedback hit "Skill not found"
  //    after a server restart even though the manifest is still on disk in the
  //    profile-bound cache dir.
  const onDisk = readSkillCache(skillId);
  if (onDisk) {
    recentLocalSkills.set(scopedSkillKey(skillId, scopeId), onDisk);
    return onDisk;
  }
  return null;
}

/**
 * Find an existing cached skill for the same domain, so re-captures update
 * the existing skill instead of creating duplicates. Preserves skill_id
 * across re-captures and server restarts.
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
    try {
      const skills = await listSkills();
      const listed = skills.find((skill) => skill.skill_id === skillId) ?? null;
      if (listed) {
        writeSkillCache(listed, scopeId);
      }
      return listed;
    } catch {
      return null;
    }
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
  const proofCount = (draft.endpoints ?? []).filter(e => e.zk_proof).length;
  const proofHeaders: Record<string, string> = {};
  if (proofCount > 0) {
    proofHeaders["X-Unbrowse-Zk-Proof-Count"] = String(proofCount);
  }
  const published = await api<SkillManifest & { warnings: string[] }>("POST", "/v1/skills", {
    ...draft,
    ...(wallet.wallet_address ? wallet : {}),
  }, { timeoutMs: PUBLISH_TIMEOUT_MS, extraHeaders: proofHeaders });

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
  exa_results?: Array<{ url: string; title?: string; score: number; highlights?: string[] }>;
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
  await api("POST", "/v1/analytics/sessions", {
    ...getTelemetryAttribution(),
    ...payload,
  });
}

export async function recordRoutingTelemetry(events: RoutingTelemetryEvent[]): Promise<void> {
  if (LOCAL_ONLY || events.length === 0) return;
  await postTelemetry("/v1/telemetry/routing", { events });
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

export interface AccountPreferences {
  share_pointers: boolean;
}

/**
 * Fetch the account-level share_pointers preference from the backend.
 * Returns null when the current api key is anonymous (backend responds with
 * 403 `account_required`) or when the endpoint is not available (404).
 * Other transport errors propagate so callers can decide.
 */
export async function fetchAccountPreferences(): Promise<AccountPreferences | null> {
  try {
    const data = await api<Partial<AccountPreferences>>("GET", "/v1/account/preferences", undefined);
    return { share_pointers: !!data?.share_pointers };
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("account_required") || msg.includes("HTTP 403") || msg.includes("HTTP 404")) {
      return null;
    }
    throw err;
  }
}

/**
 * Push a partial preferences patch up to the backend. Caller should already
 * know the current api key is account-bound; throws on non-2xx (including
 * 403 account_required for anonymous keys).
 */
export async function pushAccountPreferences(
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  const data = await api<Partial<AccountPreferences>>("PATCH", "/v1/account/preferences", patch);
  return { share_pointers: !!data?.share_pointers };
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

/** Fetch the full flywheel pulse from the analytics backend. */
export async function getFlywheelPulse(): Promise<{
  funnel: {
    installs_7d: number; registrations_7d: number; first_resolve_7d: number; repeat_users_7d: number;
    installs_30d: number; registrations_30d: number; first_resolve_30d: number; repeat_users_30d: number;
  };
  credits: {
    pool_remaining_uc: number; pool_total_granted_uc: number;
    agents_subsidized: number; agents_self_sustaining: number;
    avg_time_to_self_sustaining_hours: number;
  };
  index: {
    total_endpoints: number; total_domains: number;
    new_endpoints_7d: number; marketplace_hit_rate: number;
  };
  economics: {
    total_revenue_uc: number; total_earned_by_agents_uc: number;
    revenue_per_install_uc: number; ltv_per_agent_uc: number;
  };
  conversion: {
    install_to_register: number; register_to_first_resolve: number;
    first_resolve_to_repeat: number; overall_activation: number;
  };
  timestamp: string;
}> {
  return api("GET", "/v1/analytics/flywheel");
}
