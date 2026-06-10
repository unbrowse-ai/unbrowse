/*
 * recommend-guard — the frontend half of path-A's seal (brick 3b).
 *
 * The hero agent loop is the live LLM-recommends + client-executes path. When
 * the loop has RESOLVED a skill (via get_route), the LLM's execute_route URL
 * must belong to that skill — its own host + one of its endpoint paths — or the
 * model has wandered off-skill (hallucinated route / off-domain exfil) and the
 * client must NOT fetch it. The cold path (no resolved skill) can't be checked
 * against one, so it falls through to the existing SSRF guard.
 *
 * Pure logic, mirrors backend validateRecommendation's host+path check.
 */

export interface SkillManifestLite {
  skill_id?: string;
  domain?: string;
  endpoints?: Array<{ url?: string; url_template?: string; method?: string; endpoint_id?: string }>;
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts this skill legitimately covers: declared domain + every endpoint host. */
function skillHosts(m: SkillManifestLite): Set<string> {
  const hosts = new Set<string>();
  if (m.domain) hosts.add(m.domain.toLowerCase());
  for (const e of m.endpoints ?? []) {
    const h = hostOf(e.url ?? e.url_template ?? "");
    if (h) hosts.add(h);
  }
  return hosts;
}

/** Does the proposed URL belong to one of the skill's real endpoints?
 *  Host must be a skill host AND the path must match an endpoint's literal
 *  prefix (the template path up to its first {placeholder}). */
export function urlBelongsToSkill(manifest: SkillManifestLite, url: string): { ok: boolean; reason?: string } {
  const pHost = hostOf(url);
  if (!pHost) return { ok: false, reason: "invalid url" };
  if (!skillHosts(manifest).has(pHost)) {
    return { ok: false, reason: `url host "${pHost}" is outside the resolved skill` };
  }
  let pPath = "/";
  try {
    pPath = new URL(url).pathname;
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  for (const e of manifest.endpoints ?? []) {
    const tpl = e.url ?? e.url_template ?? "";
    const eHost = hostOf(tpl);
    if (!eHost || eHost !== pHost) continue;
    let tPath = "/";
    try {
      tPath = new URL(tpl).pathname;
    } catch {
      continue;
    }
    const literalPrefix = tPath.split("{")[0];
    if (pPath === tPath || pPath.startsWith(literalPrefix)) return { ok: true };
  }
  return { ok: false, reason: "url does not match any of the resolved skill's endpoints" };
}

/** Parse a get_route tool output (JSON string) into a lite manifest, or null. */
export function parseManifest(output: string): SkillManifestLite | null {
  try {
    const obj = JSON.parse(output) as SkillManifestLite;
    if (obj && typeof obj === "object" && Array.isArray(obj.endpoints)) return obj;
    return null;
  } catch {
    return null;
  }
}
