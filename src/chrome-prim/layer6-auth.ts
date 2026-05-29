/**
 * Chrome-prim Layer 6 — Auth-bridging layer (lifted from src/kuri/stateless/ 2026-05-28).
 * Gen 18:25 — same lift discipline.
 *
 * Contract: 75dd360f
 *
 * A contract-neuron primitive that takes (target_host, browser_profile_hint)
 * and emits a cookie_jar_pointer with metadata.
 *
 * The pointer body (raw cookies) is only resolved server-side or inside the
 * trusted local capture process; agent-side context only sees the metadata.
 * Future: this is the natural seam to wire through covenant's gated_echo +
 * reveal kinds — cookies become substrate-local blobs surfaced only on
 * wallet-signed deref.
 *
 * Validation: bench probes targeting auth-gated domains receive a non-null
 * cookie_jar_pointer when a fresh local cookie exists, and a null pointer
 * with 'no_fresh_cookie' next_step when it does not — never silently
 * injecting empty values.
 *
 * NOT IMPLEMENTED. Today the auth bridge lives in src/auth/index.ts and
 * gets called inline during direct-document / direct-fetch / browser
 * ladder. Layer-6 future work extracts it into this contract-neuron shape
 * with explicit pointer semantics.
 */

export type BrowserProfileHint =
  | { readonly kind: "chrome-default" }
  | { readonly kind: "chrome-custom"; readonly profile_path: string }
  | { readonly kind: "firefox" }
  | { readonly kind: "dia" };

export interface CookieJarPointer {
  readonly host: string;
  readonly profile_source: "chrome" | "firefox" | "dia" | "locked" | "none";
  readonly fresh: boolean;
  readonly expires_min_utc: string | null;
  readonly cookie_count: number;
  // No raw cookie values in the agent-visible pointer.
  readonly resolve_token: string; // server-side or trusted-local handle
}

export interface Layer6Request {
  readonly target_host: string;
  readonly browser_profile_hints: readonly BrowserProfileHint[];
}

export interface Layer6Result {
  readonly cookie_jar: CookieJarPointer | null;
  readonly next_step: "ok" | "no_fresh_cookie" | "profile_locked" | "auth_required";
}

export async function resolveCookieJar(_req: Layer6Request): Promise<Layer6Result> {
  throw new Error("Layer 6 (chrome-prim 75dd360f) not implemented — scaffold only.");
}
