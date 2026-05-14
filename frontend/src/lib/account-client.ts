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

export interface AccountKey {
  keyId: string;
}

export interface AccountSkill {
  skill_id: string;
  domain: string;
  endpoints?: Array<{ endpoint_id: string }>;
  [k: string]: unknown;
}

export interface AccountPreferences {
  share_pointers: boolean;
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
    return text && text.length > 0 ? text : res.statusText;
  } catch {
    return res.statusText;
  }
}

async function authedGet<T>(path: string, apiKey: string): Promise<T> {
  const origin = getConfiguredApiOrigin();
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AccountClientError(res.status, `HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function fetchMe(apiKey: string): Promise<AccountMe> {
  return authedGet<AccountMe>("/v1/account/me", apiKey);
}

export async function fetchKeys(apiKey: string): Promise<AccountKey[]> {
  return authedGet<AccountKey[]>("/v1/account/keys", apiKey);
}

export async function fetchSkills(apiKey: string): Promise<AccountSkill[]> {
  return authedGet<AccountSkill[]>("/v1/account/skills", apiKey);
}

export async function fetchPreferences(
  apiKey: string,
): Promise<AccountPreferences> {
  return authedGet<AccountPreferences>("/v1/account/preferences", apiKey);
}

export async function fetchBillingMe(apiKey: string): Promise<BillingMe> {
  return authedGet<BillingMe>("/v1/billing/me", apiKey);
}

export async function patchPreferences(
  apiKey: string,
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  const origin = getConfiguredApiOrigin();
  const res = await fetch(`${origin}/v1/account/preferences`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new AccountClientError(res.status, `HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as AccountPreferences;
}
