import { getRegistrableDomain } from "./domain.js";
import type { EndpointDescriptor, EndpointPolicyDescriptor } from "./types/index.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Known session-bound fingerprint parameters that are tied to a specific browser
 * session. Replaying captured values for these params produces empty or rejected
 * responses because the server validates them server-side.
 *
 * TikTok is the primary example: ~38 params like device_id, WebIdLastTime, and
 * browser_version are generated per-session and cannot be replayed from a capture.
 */
const KNOWN_SESSION_BOUND_PARAMS = new Set([
  // TikTok device/browser fingerprint params
  "device_id",
  "WebIdLastTime",
  "browser_version",
  "browser_name",
  "browser_language",
  "browser_platform",
  "browser_online",
  "os",
  "os_version",
  "device_platform",
  "channel",
  "app_id",
  "app_name",
  "app_version",
  "fp",
  "msToken",
  "tt_webid",
  "tt_webid_v2",
  "verifyFp",
  "X-Bogus",
  "_signature",
  "aid",
  "biz_trace_id",
  "clientABVersions",
  "coverFormat",
  "webcast_sdk_version",
  "live_id",
  "enter_from",
  "enter_method",
  "from_source",
  "screen_width",
  "screen_height",
  "history_len",
  "is_fullscreen",
  "is_page_visible",
  "focus_state",
  "is_night_mode",
  "cookie_enabled",
  "timezone_name",
  "timezone_offset",
  "uid",
]);

/**
 * Detect query parameters in an endpoint that are known to be session-bound.
 * Returns the list of offending param names, or an empty array if none found.
 */
export function detectSessionBoundParams(endpoint: EndpointDescriptor): string[] {
  if (!endpoint.query || typeof endpoint.query !== "object") return [];
  return Object.keys(endpoint.query).filter((k) => KNOWN_SESSION_BOUND_PARAMS.has(k));
}

type DomainPolicy = {
  domain: string;
  reason: string;
  require_for_mutations: boolean;
};

const DOMAIN_POLICIES: DomainPolicy[] = [
  {
    domain: "x.com",
    reason: "X write endpoints require explicit user confirmation because automated posting or other mutations may violate third-party site terms or automation rules.",
    require_for_mutations: true,
  },
];

function resolveEndpointDomain(endpoint: EndpointDescriptor): string | null {
  try {
    const parsed = new URL(endpoint.url_template);
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return null;
  }
}

export function getEndpointPolicy(endpoint: EndpointDescriptor): EndpointPolicyDescriptor | undefined {
  if (endpoint.policy?.requires_third_party_terms_confirmation) return endpoint.policy;

  const domain = resolveEndpointDomain(endpoint);
  if (!domain) return undefined;

  const matched = DOMAIN_POLICIES.find((policy) => policy.domain === domain);
  if (!matched) return undefined;
  if (matched.require_for_mutations && !MUTATION_METHODS.has(endpoint.method)) return undefined;

  // Read-only POST endpoints (GraphQL queries, ad queries, search) are safe — skip the gate
  if (endpoint.idempotency === "safe" || endpoint.idempotency === "read") return undefined;

  return {
    requires_third_party_terms_confirmation: true,
    policy_domain: matched.domain,
    reason: matched.reason,
  };
}

export function endpointRequiresThirdPartyTermsConfirmation(endpoint: EndpointDescriptor): boolean {
  return !!getEndpointPolicy(endpoint)?.requires_third_party_terms_confirmation;
}

export function annotateEndpointPolicy<T extends EndpointDescriptor>(endpoint: T): T {
  const sessionBound = detectSessionBoundParams(endpoint);

  // If there's no existing policy but we detected session-bound params, build one
  if (!endpoint.policy && sessionBound.length > 0) {
    const domain = resolveEndpointDomain(endpoint) ?? "unknown";
    return {
      ...endpoint,
      policy: {
        requires_third_party_terms_confirmation: false,
        policy_domain: domain,
        reason: `This endpoint has ${sessionBound.length} session-bound fingerprint parameter(s) (${sessionBound.slice(0, 3).join(", ")}${sessionBound.length > 3 ? ", ..." : ""}) that cannot be replayed from a capture. A live browser session is required.`,
        requires_live_session: true,
        session_bound_params: sessionBound,
      },
    } as T;
  }

  // If there's already a policy but no requires_live_session annotation, merge in the session-bound info
  if (endpoint.policy && sessionBound.length > 0 && !endpoint.policy.requires_live_session) {
    return {
      ...endpoint,
      policy: {
        ...endpoint.policy,
        requires_live_session: true,
        session_bound_params: sessionBound,
      },
    } as T;
  }

  const policy = getEndpointPolicy(endpoint);
  if (!policy || endpoint.policy) return endpoint;
  return { ...endpoint, policy } as T;
}
