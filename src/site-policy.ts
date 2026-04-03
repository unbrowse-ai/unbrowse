import { getRegistrableDomain } from "./domain.js";
import type { EndpointDescriptor, EndpointPolicyDescriptor } from "./types/index.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
  const policy = getEndpointPolicy(endpoint);
  if (!policy || endpoint.policy) return endpoint;
  return { ...endpoint, policy } as T;
}
