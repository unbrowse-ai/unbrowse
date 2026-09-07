// frontend/src/lib/auth-errors.ts
// Pure, testable classification of the /v1/auth/email/start response status.
//
// The bug the user screenshotted: a transient mid-redeploy edge blip returned
// HTTP 410, and the sign-in form showed the raw "HTTP 410" — a dead-end-looking
// message for a state that clears itself on retry. The fix maps transient statuses
// (410 / 408 / 425 / 429 / 5xx) to a friendly, retryable message and 400 to an
// invalid-email message. Extracted here so the mapping is unit-testable on its own,
// not buried in a React closure.

export type AuthStartStatusKind = "ok" | "transient" | "invalid" | "other";

/** A 410 here is almost always a mid-redeploy edge-cache blip (the endpoint is live
 *  again on retry), so it belongs with the 5xx / 429 / timeout family, not a dead end. */
export function classifyAuthStartStatus(status: number): AuthStartStatusKind {
  if (status >= 200 && status < 300) return "ok";
  if (status === 410 || status === 408 || status === 425 || status === 429 || status >= 500) {
    return "transient";
  }
  if (status === 400) return "invalid";
  return "other";
}

export const TRANSIENT_AUTH_MESSAGE =
  "Sign-in is temporarily unavailable. Please try again in a moment.";
export const INVALID_EMAIL_MESSAGE = "That email address looks invalid.";
