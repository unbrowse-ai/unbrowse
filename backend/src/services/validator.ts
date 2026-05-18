import type { SkillManifest, ValidationResult } from "../types.js";

const VALID_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WS"];
const VALID_OWNER_TYPES = ["agent", "marketplace", "user"];
const VALID_LIFECYCLES = ["active", "deprecated", "disabled"];
const VALID_IDEMPOTENCY = ["safe", "unsafe"];
const VALID_VERIFICATION = ["verified", "unverified", "failed", "pending"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// nanoid emits [A-Za-z0-9_-]. We additionally allow `.` for legacy seeded
// skill IDs that used domain-style names. Path-separator characters (`/`,
// `\`) and parent-directory traversal (`..`) remain banned since the
// publish path uses skill_id as a KV key, not a filesystem path — but the
// CLI mirrors skill_id into a cache file, so the broader rule still holds.
const SKILL_ID_RE = /^[A-Za-z0-9_.\-]{1,128}$/;
const ENDPOINT_ID_RE = /^[a-z0-9_:.-]{1,128}$/i;

/**
 * Skill manifests are publisher-controlled. The marketplace serves them to
 * other agents, who then *execute* them with cookies and credentials loaded
 * from the user's machine. Anything that survives this validator is treated
 * as trusted by downstream consumers — so the bar is high.
 *
 * Rules of thumb:
 *  - Header keys/values that look like credentials are dropped.
 *  - URL hosts must be reachable on the public internet, not RFC1918/loopback.
 *  - URL hosts must share the registrable domain with `skill.domain`.
 *  - Trust-signal fields (verification_status: verified, zk_proof.verified)
 *    cannot be self-attested by agents — only admins / the proof verifier may
 *    set them. Agents who try get downgraded to `pending`.
 *  - Every interpolated string runs through control-char + length checks so
 *    LLM consumers / terminals / Markdown viewers can't be poisoned.
 *
 * This file is the only choke point that gates the publish path; downstream
 * consumers (SKILL.md renderer, skill cache, execute pipeline) defend in
 * depth, but they do not duplicate these checks.
 */

const URL_RE = /^(https?|wss?):\/\//i;
const PROD_URL_RE = /^(https|wss):\/\//i;

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-session-token",
  "x-access-token",
  "x-secret",
  "api-key",
  "secret",
]);

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const MAX_FIELD_LENGTHS = {
  description: 4_000,
  name: 256,
  intent_signature: 256,
  domain: 253,
  subdomain: 253,
  endpoint_description: 2_000,
  url_template: 2_048,
  header_value: 1_024,
  body_json_chars: 32_000,
  query_json_chars: 4_096,
  response_schema_chars: 32_000,
  annotation_text: 280,
};

const MAX_ENDPOINTS = 256;
const MAX_HEADERS_PER_ENDPOINT = 32;
const MAX_QUERY_PARAMS = 64;
const MAX_BODY_KEYS = 256;
const MAX_CONSTRAINT_COUNT = 32;
const MAX_ANNOTATION_COUNT = 20;

/** ASCII C0/C1 control chars that have no business in agent-readable text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

/** Hosts we never let publishers register endpoints against. */
const PRIVATE_HOST_RE = new RegExp(
  [
    "^localhost$",
    "^127\\.",
    "^0\\.0\\.0\\.0$",
    "^10\\.",
    "^172\\.(1[6-9]|2[0-9]|3[0-1])\\.",
    "^192\\.168\\.",
    "^169\\.254\\.", // link-local incl. AWS IMDS
    "^::1$",
    "^fe80:",
    "^fc00:",
    "^fd00:",
    "^\\[?::1\\]?$",
    "^\\[::ffff:", // IPv4-mapped IPv6
  ].join("|"),
  "i",
);

const NUMERIC_HOST_RE = /^\d+$/; // catches http://2130706433 (decimal 127.0.0.1)
const HEX_HOST_RE = /^0x[0-9a-f]+$/i; // http://0x7f000001

function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function pushIfNot(errors: string[], message: string) {
  if (!errors.includes(message)) errors.push(message);
}

function isProductionEnv(): boolean {
  // Hono's request context isn't available here; the publish handler passes
  // env through context, but the validator runs synchronously off the body.
  // Default to "strict" (production). The caller may opt into laxer mode
  // through validateSkillManifest's `options.production` argument.
  return true;
}

function getRegistrableDomain(host: string): string {
  // Lightweight registrable-domain extractor. We don't pull the full PSL into
  // a CF Worker — agents publish second-level domains (shop.example.com →
  // example.com) the vast majority of the time, and the host-allowlist below
  // accepts both `domain` exactly and `*.${domain}` so cross-subdomain calls
  // require a fresh skill anyway.
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return host.toLowerCase();
  return parts.slice(-2).join(".");
}

function hostMatchesSkillDomain(urlHost: string, skillDomain: string): boolean {
  const lhs = urlHost.toLowerCase();
  const rhs = skillDomain.toLowerCase();
  if (lhs === rhs) return true;
  if (lhs.endsWith(`.${rhs}`)) return true;
  // Allow subdomain skills to publish endpoints on their own subdomain only.
  // We do NOT walk up to the registrable domain here — that would let a
  // skill registered as `evil.example.com` publish for `bank.example.com`.
  return false;
}

function isPrivateOrInternalHost(host: string): boolean {
  if (!host) return true;
  const lower = host.toLowerCase();
  if (PRIVATE_HOST_RE.test(lower)) return true;
  if (NUMERIC_HOST_RE.test(lower)) return true;
  if (HEX_HOST_RE.test(lower)) return true;
  return false;
}

function checkObjectShape(
  obj: Record<string, unknown>,
  errors: string[],
  prefix: string,
  options: { maxKeys?: number; allowNested?: boolean } = {},
): void {
  const maxKeys = options.maxKeys ?? MAX_BODY_KEYS;
  const keys = Object.keys(obj);
  if (keys.length > maxKeys) {
    pushIfNot(errors, `${prefix} has too many keys (${keys.length} > ${maxKeys})`);
  }
  for (const key of keys) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      pushIfNot(errors, `${prefix} contains forbidden key "${key}"`);
    }
    if (hasControlChars(key)) {
      pushIfNot(errors, `${prefix} contains control characters in key`);
    }
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!options.allowNested) {
        // Shallow check only — recurse one level for prototype-pollution
        for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
          if (PROTOTYPE_POLLUTION_KEYS.has(nestedKey)) {
            pushIfNot(errors, `${prefix}.${key} contains forbidden key "${nestedKey}"`);
          }
        }
      }
    }
  }
}

function jsonByteLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface ValidatorOptions {
  /**
   * Set to false for staging / development to allow http:// endpoints.
   * Production publishers must use https/wss only.
   */
  production?: boolean;
  /**
   * Submitter's agent_id. Used to detect agent self-attestation of
   * verification_status: "verified" — only admins may stamp `verified`.
   */
  submitter_agent_id?: string;
  /**
   * If the submitter is an admin, agent-attested `verified` flags are
   * allowed through. Admin keys are gated by env.API_KEY in the auth
   * middleware so this can never be set by a regular agent.
   */
  is_admin?: boolean;
}

export function validateSkillManifest(
  manifest: unknown,
  options: ValidatorOptions = {},
): ValidationResult {
  const hardErrors: string[] = [];
  const softWarnings: string[] = [];
  const m = manifest as Record<string, unknown>;
  const production = options.production ?? isProductionEnv();
  const isAdmin = options.is_admin ?? false;

  if (!m || typeof m !== "object" || Array.isArray(m)) {
    return { valid: false, hardErrors: ["manifest must be an object"], softWarnings: [] };
  }

  // Reject prototype pollution at the manifest top level
  for (const key of Object.keys(m)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      hardErrors.push(`manifest contains forbidden key "${key}"`);
    }
  }

  // Required string fields
  for (const field of [
    "skill_id",
    "version",
    "schema_version",
    "name",
    "intent_signature",
    "domain",
    "description",
    "owner_type",
    "lifecycle",
    "created_at",
    "updated_at",
  ]) {
    const value = m?.[field];
    if (!isString(value) || value.length === 0) {
      hardErrors.push(`skill.${field} is required and must be a non-empty string`);
      continue;
    }
    if (hasControlChars(value)) {
      hardErrors.push(`skill.${field} contains control characters`);
    }
  }

  // Length caps for human-visible strings (defends LLM context + Markdown renderers)
  if (isString(m.description) && m.description.length > MAX_FIELD_LENGTHS.description) {
    hardErrors.push(`skill.description exceeds ${MAX_FIELD_LENGTHS.description} chars`);
  }
  if (isString(m.name) && m.name.length > MAX_FIELD_LENGTHS.name) {
    hardErrors.push(`skill.name exceeds ${MAX_FIELD_LENGTHS.name} chars`);
  }
  if (isString(m.intent_signature) && m.intent_signature.length > MAX_FIELD_LENGTHS.intent_signature) {
    hardErrors.push(`skill.intent_signature exceeds ${MAX_FIELD_LENGTHS.intent_signature} chars`);
  }

  if (isString(m.skill_id)) {
    if (!SKILL_ID_RE.test(m.skill_id)) {
      hardErrors.push("skill.skill_id must match [A-Za-z0-9_.-]{1,128} (no slashes, no '..')");
    }
    if (m.skill_id.includes("..") || m.skill_id.includes("/") || m.skill_id.includes("\\")) {
      hardErrors.push("skill.skill_id must not contain path separators or '..'");
    }
  }

  // Domain must look like a real DNS name. The publish handler reuses the
  // domain as a path segment (cache key, KV index) and the SKILL.md export
  // joins it onto a filesystem path on the user's machine, so traversal here
  // is RCE-adjacent.
  if (isString(m.domain)) {
    const lower = m.domain.toLowerCase();
    if (!DOMAIN_RE.test(lower)) {
      hardErrors.push("skill.domain must be a valid DNS hostname (no path/scheme/special chars)");
    }
    if (lower.includes("..") || lower.includes("/") || lower.includes("\\")) {
      hardErrors.push("skill.domain must not contain path separators");
    }
    if (lower.length > MAX_FIELD_LENGTHS.domain) {
      hardErrors.push(`skill.domain exceeds ${MAX_FIELD_LENGTHS.domain} chars`);
    }
  }
  if (isString(m.subdomain) && m.subdomain.length > 0) {
    const lower = m.subdomain.toLowerCase();
    if (!DOMAIN_RE.test(lower)) {
      hardErrors.push("skill.subdomain must be a valid DNS hostname");
    }
  }

  if (isString(m.version) && !VERSION_RE.test(m.version)) {
    hardErrors.push("skill.version must match semver (x.y.z)");
  }
  if (isString(m.owner_type) && !VALID_OWNER_TYPES.includes(m.owner_type)) {
    hardErrors.push(`skill.owner_type must be one of: ${VALID_OWNER_TYPES.join(", ")}`);
  }
  if (isString(m.lifecycle) && !VALID_LIFECYCLES.includes(m.lifecycle)) {
    hardErrors.push(`skill.lifecycle must be one of: ${VALID_LIFECYCLES.join(", ")}`);
  }

  // auth_profile_ref must be self-scoped to the skill domain. A publisher who
  // sets `auth_profile_ref: auth:victim-bank.com` would coerce the executor
  // into loading victim-bank cookies on a request to attacker.com.
  if (isString(m.auth_profile_ref) && m.auth_profile_ref.length > 0 && isString(m.domain)) {
    const ref = m.auth_profile_ref.toLowerCase();
    const expected = `auth:${m.domain.toLowerCase()}`;
    const expectedRegistrable = `auth:${getRegistrableDomain(m.domain)}`;
    if (ref !== expected && ref !== expectedRegistrable) {
      hardErrors.push(
        "skill.auth_profile_ref must reference the skill's own domain (auth:<skill.domain>)",
      );
    }
  }

  // Endpoints array
  if (!Array.isArray(m?.endpoints) || (m.endpoints as unknown[]).length === 0) {
    hardErrors.push("skill.endpoints must be a non-empty array");
  } else {
    if ((m.endpoints as unknown[]).length > MAX_ENDPOINTS) {
      hardErrors.push(`skill.endpoints exceeds maximum of ${MAX_ENDPOINTS}`);
    }
    const seenIds = new Set<string>();
    for (const epRaw of m.endpoints as unknown[]) {
      if (!epRaw || typeof epRaw !== "object" || Array.isArray(epRaw)) {
        hardErrors.push("each endpoint must be an object");
        continue;
      }
      const ep = epRaw as Record<string, unknown>;
      const epId = isString(ep.endpoint_id) ? ep.endpoint_id : "unknown";

      if (!isString(ep.endpoint_id) || ep.endpoint_id.length === 0) {
        hardErrors.push(`endpoint.endpoint_id is required`);
      } else if (!ENDPOINT_ID_RE.test(ep.endpoint_id)) {
        hardErrors.push(`endpoint[${epId}].endpoint_id must match [a-z0-9_:.-]{1,128}`);
      } else if (seenIds.has(ep.endpoint_id)) {
        hardErrors.push(`endpoint[${epId}].endpoint_id appears more than once`);
      } else {
        seenIds.add(ep.endpoint_id);
      }

      if (!isString(ep.method) || !VALID_METHODS.includes(ep.method)) {
        hardErrors.push(`endpoint[${epId}].method must be one of: ${VALID_METHODS.join(", ")}`);
      }

      if (!isString(ep.url_template) || ep.url_template.length === 0) {
        hardErrors.push(`endpoint[${epId}].url_template is required`);
      } else {
        if (ep.url_template.length > MAX_FIELD_LENGTHS.url_template) {
          hardErrors.push(
            `endpoint[${epId}].url_template exceeds ${MAX_FIELD_LENGTHS.url_template} chars`,
          );
        }
        if (hasControlChars(ep.url_template)) {
          hardErrors.push(`endpoint[${epId}].url_template contains control characters`);
        }

        const schemeOk = production ? PROD_URL_RE.test(ep.url_template) : URL_RE.test(ep.url_template);
        if (!schemeOk) {
          hardErrors.push(
            production
              ? `endpoint[${epId}].url_template must use https:// or wss:// (cleartext schemes are not allowed)`
              : `endpoint[${epId}].url_template must use http(s):// or ws(s)://`,
          );
        }

        // Parse + validate host. We use URL with a same-origin base only when
        // the template begins with the scheme; otherwise we treat it as
        // already-broken upstream of this call.
        let parsed: URL | null = null;
        try {
          // Replace `{var}` interpolation placeholders so URL.parse doesn't
          // choke on them. We don't trust their values yet, but we do check
          // the template host below.
          const placeholderSafe = ep.url_template.replace(/\{[^}]+\}/g, "X");
          parsed = new URL(placeholderSafe);
        } catch {
          hardErrors.push(`endpoint[${epId}].url_template is not a valid URL`);
        }

        if (parsed) {
          if (parsed.username || parsed.password) {
            hardErrors.push(
              `endpoint[${epId}].url_template must not contain a userinfo component`,
            );
          }
          if (isPrivateOrInternalHost(parsed.hostname)) {
            hardErrors.push(
              `endpoint[${epId}].url_template host "${parsed.hostname}" is private/loopback/link-local`,
            );
          }
          if (isString(m.domain) && !hostMatchesSkillDomain(parsed.hostname, m.domain)) {
            hardErrors.push(
              `endpoint[${epId}].url_template host "${parsed.hostname}" must match skill.domain "${m.domain}" (or be a subdomain of it)`,
            );
          }
        }
      }

      if (!isString(ep.idempotency) || !VALID_IDEMPOTENCY.includes(ep.idempotency)) {
        hardErrors.push(`endpoint[${epId}].idempotency must be "safe" or "unsafe"`);
      }

      // verification_status: agents may not self-attest as "verified". The
      // marketplace ranker, the SKILL.md renderer, and the agent shortlist
      // all treat `verified` as a strong trust signal — we let admins or
      // server-side flows promote, never the publisher.
      if (!isString(ep.verification_status) || !VALID_VERIFICATION.includes(ep.verification_status)) {
        hardErrors.push(
          `endpoint[${epId}].verification_status must be one of: ${VALID_VERIFICATION.join(", ")}`,
        );
      } else if (ep.verification_status === "verified" && !isAdmin) {
        // Soft-downgrade rather than rejecting outright. This way contributors
        // running an older client that defaults to "verified" still have
        // their endpoints accepted.
        ep.verification_status = "pending";
        softWarnings.push(
          `endpoint[${epId}].verification_status downgraded from "verified" to "pending" (only admins may stamp verified)`,
        );
      }

      if (
        typeof ep.reliability_score !== "number" ||
        !Number.isFinite(ep.reliability_score) ||
        ep.reliability_score < 0 ||
        ep.reliability_score > 1
      ) {
        hardErrors.push(`endpoint[${epId}].reliability_score must be a finite number in [0, 1]`);
      }

      // Description length + control chars
      if (ep.description !== undefined) {
        if (!isString(ep.description)) {
          hardErrors.push(`endpoint[${epId}].description must be a string`);
        } else {
          if (ep.description.length > MAX_FIELD_LENGTHS.endpoint_description) {
            hardErrors.push(
              `endpoint[${epId}].description exceeds ${MAX_FIELD_LENGTHS.endpoint_description} chars`,
            );
          }
          if (hasControlChars(ep.description)) {
            hardErrors.push(`endpoint[${epId}].description contains control characters`);
          }
        }
      }

      // Headers: drop credentials. We *mutate* the manifest here so anything
      // that survived the validator is safe to replay.
      if (ep.headers_template !== undefined) {
        if (!ep.headers_template || typeof ep.headers_template !== "object" || Array.isArray(ep.headers_template)) {
          hardErrors.push(`endpoint[${epId}].headers_template must be an object`);
        } else {
          const headersObj = ep.headers_template as Record<string, unknown>;
          checkObjectShape(headersObj, hardErrors, `endpoint[${epId}].headers_template`, {
            maxKeys: MAX_HEADERS_PER_ENDPOINT,
          });
          for (const key of Object.keys(headersObj)) {
            const lowerKey = key.toLowerCase();
            if (SENSITIVE_HEADER_KEYS.has(lowerKey) || lowerKey.startsWith("x-csrf-") || lowerKey.startsWith("x-xsrf-")) {
              softWarnings.push(
                `endpoint[${epId}].headers_template["${key}"] dropped (credential headers cannot be published)`,
              );
              delete headersObj[key];
              continue;
            }
            const value = headersObj[key];
            if (!isString(value)) {
              hardErrors.push(`endpoint[${epId}].headers_template["${key}"] must be a string`);
              continue;
            }
            if (value.length > MAX_FIELD_LENGTHS.header_value) {
              hardErrors.push(
                `endpoint[${epId}].headers_template["${key}"] exceeds ${MAX_FIELD_LENGTHS.header_value} chars`,
              );
            }
            if (hasControlChars(value) || /[\r\n]/.test(value)) {
              hardErrors.push(
                `endpoint[${epId}].headers_template["${key}"] contains control or CRLF characters`,
              );
            }
            // Heuristic: looks like a bearer credential leaked into the value
            if (/^bearer\s+\S/i.test(value) || /^token\s+\S/i.test(value)) {
              softWarnings.push(
                `endpoint[${epId}].headers_template["${key}"] dropped (looks like a bearer credential)`,
              );
              delete headersObj[key];
            }
          }
        }
      }

      // Query and body: shape + size only. We don't introspect contents.
      if (ep.query !== undefined) {
        if (!ep.query || typeof ep.query !== "object" || Array.isArray(ep.query)) {
          hardErrors.push(`endpoint[${epId}].query must be an object`);
        } else {
          checkObjectShape(ep.query as Record<string, unknown>, hardErrors, `endpoint[${epId}].query`, {
            maxKeys: MAX_QUERY_PARAMS,
          });
          const queryBytes = jsonByteLength(ep.query);
          if (queryBytes > MAX_FIELD_LENGTHS.query_json_chars) {
            hardErrors.push(
              `endpoint[${epId}].query JSON exceeds ${MAX_FIELD_LENGTHS.query_json_chars} chars`,
            );
          }
        }
      }
      if (ep.body !== undefined) {
        if (!ep.body || typeof ep.body !== "object" || Array.isArray(ep.body)) {
          hardErrors.push(`endpoint[${epId}].body must be an object`);
        } else {
          checkObjectShape(ep.body as Record<string, unknown>, hardErrors, `endpoint[${epId}].body`, {
            maxKeys: MAX_BODY_KEYS,
          });
          const bodyBytes = jsonByteLength(ep.body);
          if (bodyBytes > MAX_FIELD_LENGTHS.body_json_chars) {
            hardErrors.push(
              `endpoint[${epId}].body JSON exceeds ${MAX_FIELD_LENGTHS.body_json_chars} chars`,
            );
          }
        }
      }

      if (ep.response_schema !== undefined) {
        const schemaBytes = jsonByteLength(ep.response_schema);
        if (schemaBytes > MAX_FIELD_LENGTHS.response_schema_chars) {
          hardErrors.push(
            `endpoint[${epId}].response_schema JSON exceeds ${MAX_FIELD_LENGTHS.response_schema_chars} chars`,
          );
        }
      }

      if (ep.constraints !== undefined) {
        if (!Array.isArray(ep.constraints)) {
          hardErrors.push(`endpoint[${epId}].constraints must be an array`);
        } else if (ep.constraints.length > MAX_CONSTRAINT_COUNT) {
          hardErrors.push(`endpoint[${epId}].constraints exceeds ${MAX_CONSTRAINT_COUNT} entries`);
        }
      }
      if (ep.annotations !== undefined) {
        if (!Array.isArray(ep.annotations)) {
          hardErrors.push(`endpoint[${epId}].annotations must be an array`);
        } else {
          if (ep.annotations.length > MAX_ANNOTATION_COUNT) {
            hardErrors.push(`endpoint[${epId}].annotations exceeds ${MAX_ANNOTATION_COUNT} entries`);
          }
          for (const a of ep.annotations as Array<Record<string, unknown>>) {
            if (a && isString(a.text)) {
              if (a.text.length > MAX_FIELD_LENGTHS.annotation_text) {
                hardErrors.push(
                  `endpoint[${epId}].annotations[].text exceeds ${MAX_FIELD_LENGTHS.annotation_text} chars`,
                );
              }
              if (hasControlChars(a.text)) {
                hardErrors.push(`endpoint[${epId}].annotations[].text contains control characters`);
              }
            }
          }
        }
      }

      // zk_proof: agents may submit commitment_only proofs (cheap, useful
      // for client-side replay), but anything that claims `verified: true`
      // for a non-commitment proof type is downgraded — only the proof
      // verifier service may stamp verified.
      if (ep.zk_proof !== undefined) {
        if (!ep.zk_proof || typeof ep.zk_proof !== "object" || Array.isArray(ep.zk_proof)) {
          hardErrors.push(`endpoint[${epId}].zk_proof must be an object`);
        } else {
          const zk = ep.zk_proof as Record<string, unknown>;
          if (!isAdmin && zk.verified === true && zk.proof_type !== "commitment_only") {
            zk.verified = false;
            softWarnings.push(
              `endpoint[${epId}].zk_proof.verified downgraded to false (only the proof verifier may stamp verified)`,
            );
          }
        }
      }

      if (ep.method !== "GET" && !ep.csrf_plan) {
        softWarnings.push(`endpoint[${epId}] non-GET endpoint missing csrf_plan`);
      }
    }
  }

  return { valid: hardErrors.length === 0, hardErrors, softWarnings };
}
