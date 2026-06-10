/**
 * validateRecommendation — the safety keystone of the single LLM-recommends path.
 *
 * When the server-side LLM is the ONLY chooser of which command the client runs,
 * its proposal cannot be trusted blind: a model can name an endpoint that does
 * not exist, or fill a URL that points off the skill's domain (data exfil). This
 * pure validator constrains an LLM-proposed command to the RESOLVED skill's real
 * endpoints + own domain, fills the URL template deterministically, and refuses a
 * half-filled URL. Only an `ok` result is safe to hand to the client executor.
 *
 * The LLM proposes; this disposes. No LLM, no network here.
 */
import type { Env, SkillManifest, EndpointDescriptor } from "../types";

export interface ProposedCommand {
  /** Preferred: name the endpoint the recommendation targets. */
  endpoint_id?: string;
  /** Params to fill the endpoint's URL template ({name} placeholders). */
  params?: Record<string, string>;
  /** Alternatively: a fully-formed URL the model produced. */
  url?: string;
  /** Optional body for POST/PUT/etc. */
  body?: string;
}

export type ValidatedCommand =
  | { ok: true; endpoint_id: string; method: string; url: string; body?: string }
  | { ok: false; reason: string };

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Host of an endpoint's URL template (placeholders don't appear in the host). */
function endpointHost(ep: EndpointDescriptor): string | null {
  return hostOf(ep.url_template);
}

/** The set of hosts this skill legitimately covers: the declared domain plus
 *  every endpoint template's own host (APIs often live on an api.* subdomain or
 *  a separate CDN host captured as part of the same skill). */
function skillHosts(skill: SkillManifest): Set<string> {
  const hosts = new Set<string>();
  const d = (skill.domain || "").toLowerCase();
  if (d) hosts.add(d);
  for (const ep of skill.endpoints ?? []) {
    const h = endpointHost(ep);
    if (h) hosts.add(h);
  }
  return hosts;
}

function fillTemplate(template: string, params: Record<string, string>): { url: string; unfilled: string[] } {
  const unfilled: string[] = [];
  const url = template.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const v = params[key];
    if (v === undefined || v === "") {
      unfilled.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(v);
  });
  return { url, unfilled };
}

/** Path-shape match: same host AND same path prefix as the endpoint template
 *  (the template's path with placeholders stripped to their literal prefix). */
function urlMatchesEndpoint(proposedUrl: string, ep: EndpointDescriptor): boolean {
  const pHost = hostOf(proposedUrl);
  const eHost = endpointHost(ep);
  if (!pHost || !eHost || pHost !== eHost) return false;
  let pPath = "/";
  let tPath = "/";
  try {
    pPath = new URL(proposedUrl).pathname;
    tPath = new URL(ep.url_template).pathname;
  } catch {
    return false;
  }
  // Literal prefix of the template path (up to the first placeholder).
  const literalPrefix = tPath.split("{")[0];
  return pPath === tPath || pPath.startsWith(literalPrefix);
}

export function validateRecommendation(skill: SkillManifest, proposed: ProposedCommand): ValidatedCommand {
  const endpoints = (skill.endpoints ?? []).filter((e) => e.endpoint_id);
  if (endpoints.length === 0) return { ok: false, reason: "skill has no endpoints to recommend" };
  const hosts = skillHosts(skill);

  // Path 1: the model named an endpoint_id → it must be real, then fill+check.
  if (proposed.endpoint_id) {
    const ep = endpoints.find((e) => e.endpoint_id === proposed.endpoint_id);
    if (!ep) return { ok: false, reason: `endpoint "${proposed.endpoint_id}" is not in this skill` };
    const { url, unfilled } = fillTemplate(ep.url_template, proposed.params ?? {});
    if (unfilled.length > 0) return { ok: false, reason: `unfilled template params: ${unfilled.join(", ")}` };
    const h = hostOf(url);
    if (!h || !hosts.has(h)) return { ok: false, reason: `filled URL host "${h ?? "?"}" is outside the skill's domain` };
    return { ok: true, endpoint_id: ep.endpoint_id, method: ep.method, url, ...(proposed.body != null ? { body: proposed.body } : {}) };
  }

  // Path 2: the model produced a full URL → host must be the skill's, and it
  // must match one of the skill's real endpoints (no inventing routes).
  if (proposed.url) {
    const h = hostOf(proposed.url);
    if (!h) return { ok: false, reason: "proposed url is not a valid URL" };
    if (!hosts.has(h)) return { ok: false, reason: `proposed url host "${h}" is outside the skill's domain` };
    if (/\{[^}]+\}/.test(proposed.url)) return { ok: false, reason: "proposed url has unfilled template placeholders" };
    const match = endpoints.find((e) => urlMatchesEndpoint(proposed.url as string, e));
    if (!match) return { ok: false, reason: "proposed url does not match any of the skill's endpoints" };
    return { ok: true, endpoint_id: match.endpoint_id, method: match.method, url: proposed.url, ...(proposed.body != null ? { body: proposed.body } : {}) };
  }

  return { ok: false, reason: "recommendation must name an endpoint_id or a url" };
}

/* ------------------------------------------------------------------ *
 *  recommendCommand — the structured recommender (path-A brick 1).
 *  The LLM PROPOSES; validateRecommendation DISPOSES. On a rejected
 *  (hallucinated) proposal it retries once, feeding the rejection reason
 *  back so the model can self-correct, then returns the validated command
 *  or an honest rejection.
 * ------------------------------------------------------------------ */

/** Injectable proposer: given a skill + prompt, return a candidate command (or
 *  null). The default (proposeViaLlm) grounds an LLM on the skill's SKILL.md and
 *  parses a structured JSON proposal; tests inject a deterministic stub. */
export type ProposeFn = (skill: SkillManifest, prompt: string) => Promise<ProposedCommand | null>;

export interface RecommendOptions {
  /** Max LLM attempts (1 + retries-on-invalid). Default 2. */
  maxAttempts?: number;
}

export async function recommendCommand(
  skill: SkillManifest,
  prompt: string,
  propose: ProposeFn,
  options: RecommendOptions = {},
): Promise<ValidatedCommand> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  let prompt_i = prompt;
  let last: ValidatedCommand = { ok: false, reason: "no proposal" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proposed = await propose(skill, prompt_i);
    if (!proposed) {
      last = { ok: false, reason: "model proposed nothing" };
      break;
    }
    const validated = validateRecommendation(skill, proposed);
    if (validated.ok) return validated;
    last = validated;
    // Feed the rejection reason back so the next attempt can self-correct.
    prompt_i = `${prompt}\n\n(Your previous proposal was rejected: ${validated.reason}. Choose only from this skill's listed endpoints and fill every {param}.)`;
  }
  return last;
}

/** Default proposer: ground an LLM on the skill's SKILL.md and ask for a
 *  STRUCTURED JSON command. Returns null when no LLM key is configured (the
 *  caller then degrades honestly). Imported lazily to keep this module's unit
 *  surface (validateRecommendation + recommendCommand) free of LLM deps. */
export function proposeViaLlm(env: Env): ProposeFn {
  return async (skill, prompt) => {
    const { runContractLlmChain } = await import("./unbrowse-llm.js");
    const { renderSkillMd } = await import("./skillmd.js");
    const system =
      "You choose ONE command to satisfy the user's request using ONLY the endpoints in <SKILL>. " +
      'Return ONLY JSON, no prose: {"endpoint_id":"<one of the skill\'s endpoint ids>","params":{"<placeholder>":"<value>"}}. ' +
      "Fill every {placeholder} in that endpoint's URL template. Never invent an endpoint, host, or parameter not in the skill.";
    const grounding = `${system}\n\n<SKILL>\n${renderSkillMd(skill)}\n</SKILL>`;
    const raw = await runContractLlmChain(env, [
      { role: "system", content: grounding },
      { role: "user", content: prompt },
    ]);
    if (!raw) return null;
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      const obj = JSON.parse(raw.slice(start, end + 1)) as ProposedCommand;
      return obj;
    } catch {
      return null;
    }
  };
}
