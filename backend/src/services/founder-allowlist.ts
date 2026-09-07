/**
 * Founder email allowlist — entitlement bypass.
 *
 * Contract: 900714e4 (D7.A) — when an authenticated user's verified email
 * matches one of the founder addresses below, the entitlement service grants
 * unlimited credits server-side. The bypass lives in the entitlement service
 * (debitUserCredits / getUserCreditBalance) so every consumer (LLM chat
 * completions, the /v1/credits/balance surface, future paid-skill executes)
 * inherits it for free — no client-side band-aid, no per-route patch
 * (CLAUDE.md C-G08 "fix the root cause, never the band-aid").
 */

import type { Env } from "../types.js";
import { getUserById } from "./accounts.js";

/** Verified emails that receive unlimited credits. Lowercase. */
const FOUNDER_EMAILS: ReadonlySet<string> = new Set([
  "lewis@getfoundry.app",
  "foundry@getfoundry.app",
]);

/** Synthetic balance reported for founders. JSON-safe; larger than any
 * realistic debit so a single call never wraps. */
export const FOUNDER_BALANCE_UC = Number.MAX_SAFE_INTEGER;

/**
 * Returns true when the user_id maps to a verified founder email.
 *
 * "Verified" means `verified_at` is set on the UserRecord — the same gate
 * the rest of the account surface uses for verified-only behavior. An
 * unverified founder email does NOT receive the bypass (otherwise anyone
 * could sign up with a typo and try to claim it).
 */
export async function isFounderUser(env: Env, user_id: string | undefined | null): Promise<boolean> {
  if (!user_id) return false;
  try {
    const user = await getUserById(env, user_id);
    if (!user) return false;
    if (!user.verified_at) return false;
    return FOUNDER_EMAILS.has(user.email.trim().toLowerCase());
  } catch {
    return false;
  }
}
