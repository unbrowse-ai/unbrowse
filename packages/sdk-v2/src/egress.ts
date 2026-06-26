/**
 * egress — SDK-side residential egress hint. Pure functions only. No module-
 * level state. The SDK does not know the residential pool's URL or vendor;
 * it sends the worker a `mode` + optional country/session, and the worker
 * resolves the actual upstream proxy URL from its env + ~/.identity file.
 *
 * This keeps the SDK vendor-agnostic and lets the gate's moat-term list
 * (the residential pool vendor name stays worker-side only) hold.
 */

export type EgressMode = "direct" | "residential";

export interface EgressHint {
  mode: EgressMode;
  /** Residential pool country-lock suffix (e.g. "my"). Forwarded to worker, appended to its password. */
  country?: string;
  /** Residential pool sticky-session id. Forwarded to worker. */
  session_id?: string;
}

export interface EgressEnv {
  UNBROWSE_DIRECT_EGRESS?: string;
  UNBROWSE_PROXY_URL?: string;
}

export interface ResidentialOverrideInput {
  country?: string;
  session_id?: string;
}

/**
 * Resolve the SDK-side egress hint. Pure function of (env, override).
 *
 * Precedence:
 *   - per-call override (mode direct/residential) wins
 *   - UNBROWSE_DIRECT_EGRESS=1 → direct
 *   - UNBROWSE_PROXY_URL set → residential (worker uses the override URL)
 *   - else → direct (default)
 *
 * The SDK never builds a proxy URL of its own — that's the worker's job.
 */
export function resolveEgressMode(env: EgressEnv, override: EgressHint | null): EgressHint {
  if (override?.mode) {
    return override;
  }
  if (env.UNBROWSE_DIRECT_EGRESS === "1") {
    return { mode: "direct" };
  }
  if (env.UNBROWSE_PROXY_URL) {
    return { mode: "residential" };
  }
  return { mode: "direct" };
}

/**
 * Apply country + session overrides to a hint. Returns a new hint —
 * pure; does not mutate input.
 *
 * `_country-<cc>` and `_session-<id>` are appended at the worker side to the
 * residential pool's password (the upstream pool's documented convention).
 * The SDK just passes them through; the actual concatenation happens
 * worker-side.
 */
export function applyResidentialOverrides(
  hint: EgressHint,
  overrides: ResidentialOverrideInput | null,
): EgressHint {
  if (!overrides || (!overrides.country && !overrides.session_id)) return hint;
  return {
    mode: hint.mode,
    country: overrides.country ?? hint.country,
    session_id: overrides.session_id ?? hint.session_id,
  };
}

/**
 * Redact credentials from any URL the SDK might carry (e.g. cached proxy URLs
 * for log lines). The SDK normally doesn't build a proxy URL itself, but if
 * the worker sends one back in a debug field, this redacts it.
 */
export function redactProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.username) u.username = "***";
    if (u.password) u.password = "";
    return u.toString();
  } catch {
    return url.replace(/:\/\/[^@]+@/, "://***@");
  }
}