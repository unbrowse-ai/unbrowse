// Centralized recovery hook for backend responses that say "your key is no longer valid".
//
// Why this lives here, not in each page: the 2026-05-18 ALL_KEYS_REVOKED rotation
// returned a 401 with `error: "all_keys_rotated"` from every authed endpoint. Without
// a shared detector, every page that calls a Bearer-protected route silently rendered
// raw JSON or empty state. This module is the single place the body shape is parsed,
// and every Bearer call site forwards through it.
//
// Contract: detectAuthInvalidFromBody(status, body) returns a recovery message when
// the response is an auth-invalid signal. Callers SHOULD dispatchAuthInvalid(message)
// from a non-throwing path before any throw or setState that hides the response.

const EVENT_NAME = "unbrowse:auth-invalid";

export type AuthInvalidDetail = {
  message: string;
  rotation_url?: string;
};

type AuthInvalidBody = {
  error?: unknown;
  message?: unknown;
  rotation_url?: unknown;
  code?: unknown;
};

const ROTATION_ERROR_CODES = new Set([
  "all_keys_rotated",
  "key_rotated",
  "key_revoked",
  "all_keys_revoked",
]);

const DEFAULT_MESSAGE =
  "Your API key is no longer valid. Sign in to mint a new one.";

export function detectAuthInvalidFromBody(
  status: number,
  body: unknown,
): AuthInvalidDetail | null {
  if (status !== 401) return null;
  if (!body || typeof body !== "object") return null;
  const b = body as AuthInvalidBody;
  const errorStr = typeof b.error === "string" ? b.error : "";
  const codeStr = typeof b.code === "string" ? b.code : "";
  const messageStr = typeof b.message === "string" ? b.message : "";
  const hit =
    ROTATION_ERROR_CODES.has(errorStr) ||
    ROTATION_ERROR_CODES.has(codeStr) ||
    /\ball[_ ]keys[_ ](rotated|revoked)\b/i.test(messageStr);
  if (!hit) return null;
  return {
    message: messageStr || DEFAULT_MESSAGE,
    rotation_url:
      typeof b.rotation_url === "string" ? b.rotation_url : undefined,
  };
}

export function dispatchAuthInvalid(detail: AuthInvalidDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<AuthInvalidDetail>(EVENT_NAME, { detail }));
  } catch {
    // CustomEvent unavailable in non-browser test envs; the listener won't fire either.
  }
}

export function subscribeAuthInvalid(
  handler: (detail: AuthInvalidDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (ev: Event) => {
    const ce = ev as CustomEvent<AuthInvalidDetail>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

// Convenience for callers that have a Response and want to inspect+forward+throw
// in one step. Returns `true` when the response was an auth-invalid signal so the
// caller can short-circuit its normal error rendering.
export async function checkAuthInvalidResponse(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  let body: unknown = null;
  try {
    // Clone so the caller can still read the body itself.
    body = await res.clone().json();
  } catch {
    return false;
  }
  const hit = detectAuthInvalidFromBody(res.status, body);
  if (!hit) return false;
  dispatchAuthInvalid(hit);
  return true;
}

export const AUTH_INVALID_EVENT_NAME = EVENT_NAME;
