import type { EndpointDescriptor, SkillManifest } from "../types/index.js";

export function isAuthGatedEndpoint(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
): boolean {
  return Boolean(skill.auth_profile_ref || endpoint.semantic?.auth_required === true);
}
