import { getConfiguredApiOrigin } from "./api-base";

export interface AccountMe {
  user_id: string;
  email: string;
  created_at: string;
  verified_at: string | null;
  keys_count: number;
  skills_count: number;
  // Flex onboarding (v6.16+). All optional/null for back-compat with older
  // backends that don't return these fields yet. Frontend treats null/missing
  // as "not yet completed" for that onboarding step.
  wallet_address?: string | null;
  wallet_provider?: string | null;
  flex_escrow_address?: string | null;
  flex_session_key_address?: string | null;
  flex_facilitator?: string | null;
}

export type KeyFunding =
  | { kind: "wallet"; wallet: string; bound_at: string }
  | { kind: "credit"; budget_uc: number; bound_at: string };

export interface AccountKey {
  keyId: string;
  name: string;
  created_at: string | null;
  revoked_at: string | null;
  funding: KeyFunding | null;
}

/** Returned once by create/rotate -- the only time the plaintext key exists. */
export interface CreatedKey {
  keyId: string;
  key: string;
  name: string;
  created_at: string;
  rotated_from?: string;
  message: string;
}

export interface AccountSkill {
  skill_id: string;
  domain: string;
  visibility?: "public" | "private";
  endpoints?: Array<{ endpoint_id: string }>;
  [k: string]: unknown;
}

export interface AccountPreferences {
  share_pointers: boolean;
}

export interface SyncedDomain {
  domain: string;
  last_sync: string;
  cookie_count: number;
}

export interface SponsorStatus {
  enabled: boolean;
  cap_daily_usd: number;
  spent_today_usd: number;
  remaining_today_usd: number;
  global_cap_daily_usd: number;
  global_spent_today_usd: number;
}

export interface CreditBalance {
  agent_id: string;
  granted_uc: number;
  earned_uc: number;
  consumed_uc: number;
  balance_uc: number;
  is_self_sustaining: boolean;
}

/** User-level credit balance (D1b, wave 3 -- Stripe-tier grants). */
export interface UserCreditBalance {
  user_id: string;
  granted_uc: number;
  earned_uc: number;
  consumed_uc: number;
  balance_uc: number;
  created_at: string;
  updated_at: string;
}

export interface BillingMeNone {
  status: "none";
}

export interface BillingMeSubscription {
  status: string;
  quota?: number;
  subscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  overageAllowed?: boolean;
  [k: string]: unknown;
}

export type BillingMe = BillingMeNone | BillingMeSubscription;

export class AccountClientError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountClientError";
    this.status = status;
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText;
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      return j.message ?? j.error ?? text;
    } catch {
      return text;
    }
  } catch {
    return res.statusText;
  }
}

async function authed<T>(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<T> {
  const origin = getConfiguredApiOrigin();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new AccountClientError(res.status, await readErrorBody(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function fetchMe(apiKey: string): Promise<AccountMe> {
  return authed<AccountMe>("GET", "/v1/account/me", apiKey);
}

export async function fetchKeys(apiKey: string): Promise<AccountKey[]> {
  const r = await authed<{ keys: AccountKey[] }>("GET", "/v1/account/keys", apiKey);
  return Array.isArray(r.keys) ? r.keys : [];
}

export async function createKey(apiKey: string, name: string): Promise<CreatedKey> {
  return authed<CreatedKey>("POST", "/v1/account/keys", apiKey, { name });
}

export async function revokeKey(apiKey: string, keyId: string): Promise<void> {
  await authed<{ ok: boolean }>("DELETE", `/v1/account/keys/${encodeURIComponent(keyId)}`, apiKey);
}

export async function rotateKey(apiKey: string, keyId: string): Promise<CreatedKey> {
  return authed<CreatedKey>("POST", `/v1/account/keys/${encodeURIComponent(keyId)}/rotate`, apiKey);
}

export async function bindKeyFunding(
  apiKey: string,
  keyId: string,
  funding: { kind: "wallet"; wallet: string } | { kind: "credit"; budget_uc: number },
): Promise<KeyFunding> {
  const r = await authed<{ funding: KeyFunding }>(
    "POST",
    `/v1/account/keys/${encodeURIComponent(keyId)}/funding`,
    apiKey,
    funding,
  );
  return r.funding;
}

export async function unbindKeyFunding(apiKey: string, keyId: string): Promise<void> {
  await authed<{ ok: boolean }>(
    "DELETE",
    `/v1/account/keys/${encodeURIComponent(keyId)}/funding`,
    apiKey,
  );
}

export async function fetchSkills(apiKey: string): Promise<AccountSkill[]> {
  const r = await authed<{ skills: AccountSkill[] }>("GET", "/v1/account/skills", apiKey);
  return Array.isArray(r.skills) ? r.skills : [];
}

export async function patchSkillVisibility(
  apiKey: string,
  skillId: string,
  visibility: "public" | "private",
): Promise<{ skill_id: string; visibility: "public" | "private" }> {
  return authed<{ skill_id: string; visibility: "public" | "private" }>(
    "PATCH",
    `/v1/account/skills/${encodeURIComponent(skillId)}`,
    apiKey,
    { visibility },
  );
}

export async function listSyncedCookieDomains(apiKey: string): Promise<SyncedDomain[]> {
  const r = await authed<{ domains: SyncedDomain[] }>("GET", "/v1/account/cookies", apiKey);
  return Array.isArray(r.domains) ? r.domains : [];
}

export async function deleteSyncedCookieDomain(apiKey: string, domain: string): Promise<void> {
  await authed<{ ok: boolean }>(
    "DELETE",
    `/v1/account/cookies/${encodeURIComponent(domain)}`,
    apiKey,
  );
}

export async function purgeCookieVault(apiKey: string): Promise<{ purged_domains: number }> {
  return authed<{ ok: boolean; purged_domains: number }>(
    "DELETE",
    "/v1/account/cookies",
    apiKey,
  );
}

export async function fetchSponsorStatus(apiKey: string): Promise<SponsorStatus> {
  return authed<SponsorStatus>("GET", "/v1/account/sponsor-status", apiKey);
}

/** User-level credit balance (D1b, wave 3). Stripe-tier grants land here. */
export async function fetchUserCredits(apiKey: string): Promise<UserCreditBalance> {
  return authed<UserCreditBalance>("GET", "/v1/account/credits", apiKey);
}

/** Credits are feature-gated: a 404 means "not enabled", not an error. */
export async function fetchCreditBalance(apiKey: string): Promise<CreditBalance | null> {
  try {
    return await authed<CreditBalance>("GET", "/v1/credits/balance", apiKey);
  } catch (err) {
    if (err instanceof AccountClientError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchPreferences(apiKey: string): Promise<AccountPreferences> {
  return authed<AccountPreferences>("GET", "/v1/account/preferences", apiKey);
}

export async function fetchBillingMe(apiKey: string): Promise<BillingMe> {
  return authed<BillingMe>("GET", "/v1/billing/me", apiKey);
}

export async function patchPreferences(
  apiKey: string,
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  return authed<AccountPreferences>("PATCH", "/v1/account/preferences", apiKey, patch);
}
