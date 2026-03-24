import type { EndpointDescriptor, EndpointProvenance } from "./types/index.js";

function hasEndpointProvenance(
  endpoint: Pick<EndpointDescriptor, "provenance">,
  ...sources: EndpointProvenance[]
): boolean {
  return !!endpoint.provenance && sources.includes(endpoint.provenance);
}

export function isObservedNetworkEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description">,
): boolean {
  if (hasEndpointProvenance(endpoint, "observed_network")) return true;
  return false;
}

export function isBundleInferredEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description">,
): boolean {
  if (hasEndpointProvenance(endpoint, "bundle_inferred", "bundle_inferred_action")) return true;
  return /inferred from js bundle/i.test(endpoint.description ?? "");
}

export function isBundleInferredActionEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description" | "method" | "idempotency">,
): boolean {
  if (hasEndpointProvenance(endpoint, "bundle_inferred_action")) return true;
  return (
    endpoint.method !== "GET" &&
    endpoint.idempotency === "unsafe" &&
    /inferred action mutation(?: from js bundle)?/i.test(endpoint.description ?? "")
  );
}

export function isUnvalidatedBundleActionEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description" | "method" | "idempotency">,
): boolean {
  return isBundleInferredEndpoint(endpoint) || isBundleInferredActionEndpoint(endpoint);
}

export function isHtmlInferredEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description">,
): boolean {
  if (hasEndpointProvenance(endpoint, "html_inferred")) return true;
  return /inferred from html (?:fetch )?(?:preload|prefetch|route)/i.test(endpoint.description ?? "");
}

export function isHtmlFormEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description">,
): boolean {
  if (hasEndpointProvenance(endpoint, "html_form")) return true;
  return /inferred action form/i.test(endpoint.description ?? "");
}

export function isCapturedPageArtifactEndpoint(
  endpoint: Pick<EndpointDescriptor, "provenance" | "description">,
): boolean {
  if (hasEndpointProvenance(endpoint, "dom_artifact")) return true;
  return /captured page artifact/i.test(endpoint.description ?? "");
}

export function canPublishLearnedEndpoint(
  endpoint: Pick<EndpointDescriptor, "method" | "idempotency" | "provenance" | "description">,
): boolean {
  if (endpoint.method === "WS") return false;
  if (endpoint.idempotency === "safe") return true;
  if (isObservedNetworkEndpoint(endpoint)) return true;
  if (!endpoint.provenance) {
    return !(
      isUnvalidatedBundleActionEndpoint(endpoint) ||
      isHtmlFormEndpoint(endpoint) ||
      isHtmlInferredEndpoint(endpoint) ||
      isCapturedPageArtifactEndpoint(endpoint)
    );
  }
  return false;
}
