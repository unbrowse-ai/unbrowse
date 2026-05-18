/**
 * Official-skills submission triage queue.
 *
 * Contract source: .claude/jesus-loop.default.plan.md Step 5+ (lane 6).
 *
 * Domain owners submit their canonical x402-supported endpoints via
 * `POST /v1/claim/submit-official`. Submissions land in a KV queue keyed by
 * `official-submission:<submission_id>` and indexed per domain at
 * `official-submission-index:<domain>`. The team triages out-of-band; once
 * approved, `promoteOfficialSubmission` writes the endpoints into the
 * existing SkillManifest for that domain with `owner_submitted: true` and
 * `verification_status: "verified"`.
 *
 * This module owns:
 *   - KV key shape + JSON contract for `OfficialSkillSubmission`
 *   - per-domain rate-limit primitive (5/24h)
 *   - the `promoteOfficialSubmission` find-or-create-merge primitive
 *
 * Boundary: the HTTP surface lives in `routes/claim.ts`. The marketplace
 * find-or-create + KV write reuses the existing `marketplace.ts` helpers so
 * the official-submission path stays a thin layer over the same skill store.
 */

import { nanoid } from "nanoid";
import type {
  Env,
  EndpointDescriptor,
  SkillManifest,
} from "../types.js";
import { skillsKV } from "./kv.js";
import {
  getSkill,
  mergeEndpoints,
  invalidateSkillListCaches,
} from "./marketplace.js";

// ---------------------------------------------------------------------------
// KV key builders.
// ---------------------------------------------------------------------------

export function buildSubmissionKey(submissionId: string): string {
  return `official-submission:${submissionId}`;
}

export function buildSubmissionIndexKey(domain: string): string {
  return `official-submission-index:${domain.trim().toLowerCase()}`;
}

export function buildSubmissionRateLimitKey(domain: string): string {
  return `submit-rl:${domain.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Stored shapes — JSON contracts in KV.
// ---------------------------------------------------------------------------

export interface OfficialSkillSubmissionEndpoint {
  method: string;
  url_template: string;
  description?: string;
  x402_supported: boolean;
  x402_envelope?: { price_usd_micros: number; recipient_atom?: string };
}

export interface OfficialSkillSubmission {
  submission_id: string;
  domain: string;
  contact_email: string;
  contact_name?: string;
  description?: string;
  endpoints: OfficialSkillSubmissionEndpoint[];
  submitted_at: string;
  submitted_by_agent_id?: string;
  status: "pending" | "approved" | "rejected";
  triage_notes?: string;
}

// ---------------------------------------------------------------------------
// Configuration knobs (kept inline for now; if these need to be tuned across
// environments we lift them onto the Env binding).
// ---------------------------------------------------------------------------

/** Maximum endpoints accepted on a single submission. */
export const MAX_ENDPOINTS_PER_SUBMISSION = 50;

/** Rate-limit cap per-domain: 5 submissions / 24h. */
export const SUBMISSION_RATE_LIMIT_COUNT = 5;
export const SUBMISSION_RATE_LIMIT_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Validation primitives (pure; no KV).
// ---------------------------------------------------------------------------

/**
 * RFC-5322-lite email check. We intentionally do not run a full RFC validator
 * here: contact_email is the proof channel ("we will email you when we
 * triage"); strict RFC parsing would reject many real, deliverable addresses
 * (plus-addressing edge cases, etc.) and we do not need it to be a unique
 * identifier. The spec calls for `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; we keep that
 * verbatim so the falsifier test pins the exact contract.
 */
export function isValidContactEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function isValidSubmissionEndpoint(
  raw: unknown,
): raw is OfficialSkillSubmissionEndpoint {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.method !== "string") return false;
  if (!ALLOWED_METHODS.has(e.method.toUpperCase())) return false;
  if (typeof e.url_template !== "string" || e.url_template.trim() === "") {
    return false;
  }
  if (e.description !== undefined && typeof e.description !== "string") {
    return false;
  }
  if (
    e.x402_supported !== undefined &&
    typeof e.x402_supported !== "boolean"
  ) {
    return false;
  }
  if (e.x402_envelope !== undefined) {
    if (typeof e.x402_envelope !== "object" || e.x402_envelope === null) {
      return false;
    }
    const env = e.x402_envelope as Record<string, unknown>;
    if (typeof env.price_usd_micros !== "number") return false;
    if (
      env.recipient_atom !== undefined &&
      typeof env.recipient_atom !== "string"
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Write side: store a fresh submission.
// ---------------------------------------------------------------------------

/**
 * Append `submissionId` to the per-domain index. We keep the index as a JSON
 * array of strings; the queue is small per-domain (≤ a few submissions
 * before triage) so a JSON array is fine and lets the team read every
 * submission with a single KV `get`.
 */
async function appendSubmissionIndex(
  env: Env,
  domain: string,
  submissionId: string,
): Promise<void> {
  const kv = skillsKV(env);
  const key = buildSubmissionIndexKey(domain);
  const raw = (await kv.get(key)) as string | null;
  let ids: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ids = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // corrupt index — start fresh; the caller still has the durable record.
    }
  }
  if (!ids.includes(submissionId)) {
    ids.push(submissionId);
  }
  await kv.put(key, JSON.stringify(ids));
}

export interface StoreOfficialSubmissionInput {
  domain: string;
  contact_email: string;
  contact_name?: string;
  description?: string;
  endpoints: OfficialSkillSubmissionEndpoint[];
  submitted_by_agent_id?: string;
}

/**
 * Persist a new submission and update the per-domain index. Returns the
 * stored record (including the freshly-minted `submission_id`).
 *
 * Callers are responsible for the rate-limit check; that lives at the route
 * boundary so the failure surface (`429 rate_limited`) is uniform with the
 * rest of the claim surface.
 */
export async function storeOfficialSubmission(
  env: Env,
  input: StoreOfficialSubmissionInput,
): Promise<OfficialSkillSubmission> {
  const domain = input.domain.trim().toLowerCase();
  const record: OfficialSkillSubmission = {
    submission_id: nanoid(),
    domain,
    contact_email: input.contact_email.trim(),
    contact_name: input.contact_name?.trim() || undefined,
    description: input.description?.trim() || undefined,
    endpoints: input.endpoints.map((e) => ({
      method: e.method.toUpperCase(),
      url_template: e.url_template,
      description: e.description,
      x402_supported: e.x402_supported,
      x402_envelope: e.x402_envelope,
    })),
    submitted_at: new Date().toISOString(),
    submitted_by_agent_id: input.submitted_by_agent_id,
    status: "pending",
  };

  await skillsKV(env).put(
    buildSubmissionKey(record.submission_id),
    JSON.stringify(record),
  );
  await appendSubmissionIndex(env, domain, record.submission_id);
  return record;
}

/**
 * Increment the per-domain rate-limit counter. Returns `{ ok: true, count }`
 * when the request is under the cap, `{ ok: false, count }` when this
 * request would push it over. Caller surfaces `429 rate_limited` on `!ok`.
 *
 * Counter resets via TTL after `SUBMISSION_RATE_LIMIT_TTL_SECONDS`.
 */
export async function checkAndIncrementSubmissionRateLimit(
  env: Env,
  domain: string,
): Promise<{ ok: boolean; count: number }> {
  const kv = skillsKV(env);
  const key = buildSubmissionRateLimitKey(domain);
  const raw = (await kv.get(key)) as string | null;
  const current = raw ? Number.parseInt(raw, 10) || 0 : 0;
  if (current >= SUBMISSION_RATE_LIMIT_COUNT) {
    return { ok: false, count: current };
  }
  const next = current + 1;
  await kv.put(key, String(next), {
    expirationTtl: SUBMISSION_RATE_LIMIT_TTL_SECONDS,
  });
  return { ok: true, count: next };
}

// ---------------------------------------------------------------------------
// Read side.
// ---------------------------------------------------------------------------

export async function getOfficialSubmission(
  env: Env,
  submissionId: string,
): Promise<OfficialSkillSubmission | null> {
  const raw = (await skillsKV(env).get(
    buildSubmissionKey(submissionId),
  )) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OfficialSkillSubmission;
  } catch {
    return null;
  }
}

export async function listSubmissionsForDomain(
  env: Env,
  domain: string,
): Promise<OfficialSkillSubmission[]> {
  const kv = skillsKV(env);
  const raw = (await kv.get(buildSubmissionIndexKey(domain))) as
    | string
    | null;
  if (!raw) return [];
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    return [];
  }
  const out: OfficialSkillSubmission[] = [];
  for (const id of ids) {
    const rec = await getOfficialSubmission(env, id);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triage helper (internal — no route exposes this yet).
// ---------------------------------------------------------------------------

/**
 * Build an EndpointDescriptor from a submitted endpoint. Owner-submitted
 * endpoints land as `verified` because the team has manually triaged them;
 * the `owner_submitted: true` flag is the provenance signal downstream
 * consumers read.
 */
function endpointFromSubmission(
  e: OfficialSkillSubmissionEndpoint,
): EndpointDescriptor {
  return {
    endpoint_id: nanoid(),
    method: e.method.toUpperCase() as EndpointDescriptor["method"],
    url_template: e.url_template,
    description: e.description,
    idempotency:
      e.method.toUpperCase() === "GET" || e.method.toUpperCase() === "HEAD"
        ? "safe"
        : "unsafe",
    verification_status: "verified",
    reliability_score: 0.9,
    owner_submitted: true,
    last_verified_at: new Date().toISOString(),
  };
}

/** Find an active SkillManifest for `domain`, scanning the full list. */
async function findActiveSkillForDomain(
  env: Env,
  domain: string,
): Promise<SkillManifest | null> {
  const target = domain.trim().toLowerCase();
  // Primary: domain-idx KV key (same path the marketplace publish uses).
  const existingId = (await skillsKV(env).get(`domain-idx:${target}`)) as
    | string
    | null;
  if (existingId) {
    const skill = await getSkill(env, existingId);
    if (skill && skill.lifecycle === "active") return skill;
  }
  return null;
}

export type PromoteMode = "approve" | "reject";

export interface PromoteResult {
  ok: boolean;
  submission_id: string;
  status: OfficialSkillSubmission["status"];
  skill_id?: string;
  promoted_endpoints?: number;
  reason?: string;
}

/**
 * Promote (or reject) a triage-queued submission.
 *
 * On `approve`:
 *   1. Load the submission.
 *   2. Find-or-create the canonical SkillManifest for `submission.domain`.
 *   3. Merge in the submission's endpoints with `owner_submitted: true` and
 *      `verification_status: "verified"`.
 *   4. Persist the skill, mark the submission `status: "approved"`.
 *
 * On `reject`: just mark the submission `status: "rejected"` plus optional
 * `triage_notes`. Idempotent.
 *
 * Out of scope: emailing the contact (the next-step admin route will wrap
 * this helper and fire the resend notification).
 */
export async function promoteOfficialSubmission(
  env: Env,
  submissionId: string,
  mode: PromoteMode,
  notes?: string,
): Promise<PromoteResult> {
  const submission = await getOfficialSubmission(env, submissionId);
  if (!submission) {
    return {
      ok: false,
      submission_id: submissionId,
      status: "pending",
      reason: "submission_not_found",
    };
  }

  if (mode === "reject") {
    const updated: OfficialSkillSubmission = {
      ...submission,
      status: "rejected",
      triage_notes: notes,
    };
    await skillsKV(env).put(
      buildSubmissionKey(submissionId),
      JSON.stringify(updated),
    );
    return {
      ok: true,
      submission_id: submissionId,
      status: "rejected",
    };
  }

  // Approve path.
  const now = new Date().toISOString();
  const newEndpoints = submission.endpoints.map(endpointFromSubmission);

  const existing = await findActiveSkillForDomain(env, submission.domain);

  let skill: SkillManifest;
  if (existing) {
    skill = {
      ...existing,
      endpoints: mergeEndpoints(existing.endpoints, newEndpoints),
      updated_at: now,
    };
  } else {
    skill = {
      skill_id: nanoid(),
      version: "1.0.0",
      schema_version: "1",
      name: submission.domain,
      intent_signature: `official:${submission.domain}`,
      domain: submission.domain,
      description:
        submission.description ?? `Official API for ${submission.domain}`,
      owner_type: "user",
      execution_type: "http",
      endpoints: newEndpoints,
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    };
  }

  const kv = skillsKV(env);
  await kv.put(`skill:${skill.skill_id}`, JSON.stringify(skill));
  if (!existing) {
    await kv.put(`domain-idx:${submission.domain}`, skill.skill_id);
  }
  await invalidateSkillListCaches(env);

  const updated: OfficialSkillSubmission = {
    ...submission,
    status: "approved",
    triage_notes: notes,
  };
  await kv.put(buildSubmissionKey(submissionId), JSON.stringify(updated));

  return {
    ok: true,
    submission_id: submissionId,
    status: "approved",
    skill_id: skill.skill_id,
    promoted_endpoints: newEndpoints.length,
  };
}
