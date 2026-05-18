/**
 * /v1/claim/* routes — DNS-TXT domain-wallet verification surface.
 *
 * Contract source: .claude/firmament-step2.md and .claude/jesus-loop.default.plan.md
 *
 * Surfaces:
 *   - POST /claim/challenge          mint + persist claim challenge to KV
 *   - POST /claim/verify             dual-DoH attestation, write wallet binding
 *   - GET  /claim/status             public read of wallet binding
 *   - POST /claim/takedown/challenge mint + persist takedown challenge to KV
 *   - POST /claim/takedown/verify    DoH-verify, disable matching skills,
 *                                    write persistent `domain-optout:<d>`
 *   - GET  /claim/takedown/status    public read of opt-out state
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { statsKV, skillsKV } from "../services/kv.js";
import { listSkills } from "../services/marketplace.js";
import { stampOwnerOnDomainSkills } from "../services/domain-claim-effects.js";
import {
  buildBindingKey,
  buildChallengeKey,
  buildOptOutKey,
  buildRateLimitKey,
  buildTakedownChallengeKey,
  buildTakedownTxtValue,
  buildTxtName,
  buildTxtValue,
  isValidApexDomain,
  isValidSolanaPubkey,
  mintChallenge,
  verifyTxtBothProviders,
  type DomainClaimBinding,
  type DomainClaimChallenge,
  type DomainTakedownChallenge,
  type DomainTakedownRecord,
} from "../services/domain-claim.js";
import {
  checkAndIncrementSubmissionRateLimit,
  isValidContactEmail,
  isValidSubmissionEndpoint,
  listSubmissionsForDomain,
  MAX_ENDPOINTS_PER_SUBMISSION,
  SUBMISSION_RATE_LIMIT_COUNT,
  storeOfficialSubmission,
  type OfficialSkillSubmissionEndpoint,
} from "../services/official-submissions.js";

type ClaimEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const claimRoutes = new Hono<ClaimEnv>();

// Bearer auth gates challenge mint + verify. Status reads stay public per
// firmament-step2.md "Public vs authed routes". Takedown follows the same
// rule: minting + verifying gated, status reading public.
claimRoutes.use("/claim/challenge", bearerAuth);
claimRoutes.use("/claim/verify", bearerAuth);
claimRoutes.use("/claim/takedown/challenge", bearerAuth);
claimRoutes.use("/claim/takedown/verify", bearerAuth);

// Challenge TTL is 24h per the spec.
const CHALLENGE_TTL_SECONDS = 24 * 60 * 60;
// Rate limit: 10 challenge mints per hour per domain.
const RATE_LIMIT_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_MAX = 10;

interface ChallengeRequestBody {
  domain?: unknown;
  wallet_address?: unknown;
}

interface VerifyRequestBody {
  domain?: unknown;
  wallet_address?: unknown;
}

// ---------------------------------------------------------------------------
// POST /v1/claim/challenge
// ---------------------------------------------------------------------------
claimRoutes.post("/claim/challenge", async (c) => {
  let body: ChallengeRequestBody;
  try {
    body = await c.req.json<ChallengeRequestBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const domainRaw = typeof body.domain === "string" ? body.domain : "";
  const walletRaw = typeof body.wallet_address === "string" ? body.wallet_address : "";

  if (!isValidApexDomain(domainRaw)) {
    return c.json(
      {
        error: "invalid_domain",
        message:
          "domain must be an apex (e.g. example.com); subdomains and casing are normalized at the source.",
      },
      400,
    );
  }
  if (!isValidSolanaPubkey(walletRaw)) {
    return c.json(
      {
        error: "invalid_wallet",
        message: "wallet_address must be a base58 Solana pubkey (32-44 chars).",
      },
      400,
    );
  }

  const domain = domainRaw.trim().toLowerCase();
  const wallet = walletRaw.trim();

  // Rate-limit: per-domain counter, TTL 1 hour, cap 10/hour. Stored as a
  // plain integer string in statsKV.
  const kv = statsKV(c.env);
  const rlKey = buildRateLimitKey(domain);
  const prior = await kv.get(rlKey).catch(() => null);
  const priorCount = (() => {
    if (typeof prior !== "string") return 0;
    const n = parseInt(prior, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  if (priorCount >= RATE_LIMIT_MAX) {
    return c.json(
      {
        error: "rate_limited",
        message: `at most ${RATE_LIMIT_MAX} challenge mints per hour per domain`,
      },
      429,
    );
  }
  // Bump the counter BEFORE minting so a slow KV write cannot let a flood
  // of concurrent mints all pass the gate. The TTL stamps the window.
  await kv.put(rlKey, String(priorCount + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS })
    .catch(() => {});

  const challenge = mintChallenge();
  const txtName = buildTxtName(domain);
  const txtValue = buildTxtValue(challenge, wallet);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  const agentId = c.var.agent_id ?? "__unknown__";

  const record: DomainClaimChallenge = {
    domain,
    wallet_address: wallet,
    challenge,
    txt_name: txtName,
    txt_value: txtValue,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    agent_id: agentId,
  };
  await kv.put(buildChallengeKey(domain, wallet), JSON.stringify(record), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });

  return c.json({
    domain,
    wallet_address: wallet,
    challenge,
    txt_name: txtName,
    txt_value: txtValue,
    expires_at: expiresAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/claim/verify
// ---------------------------------------------------------------------------
claimRoutes.post("/claim/verify", async (c) => {
  let body: VerifyRequestBody;
  try {
    body = await c.req.json<VerifyRequestBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const domainRaw = typeof body.domain === "string" ? body.domain : "";
  const walletRaw = typeof body.wallet_address === "string" ? body.wallet_address : "";

  if (!isValidApexDomain(domainRaw)) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  if (!isValidSolanaPubkey(walletRaw)) {
    return c.json({ error: "invalid_wallet" }, 400);
  }

  const domain = domainRaw.trim().toLowerCase();
  const wallet = walletRaw.trim();
  const kv = statsKV(c.env);

  // Load the pending challenge keyed on (domain, wallet). Missing means
  // either the caller never minted one OR the KV TTL already swept it.
  const challengeRaw = await kv.get(buildChallengeKey(domain, wallet)).catch(() => null);
  if (challengeRaw == null || typeof challengeRaw !== "string") {
    return c.json({ error: "no_challenge" }, 404);
  }
  let challenge: DomainClaimChallenge;
  try {
    challenge = JSON.parse(challengeRaw) as DomainClaimChallenge;
  } catch {
    return c.json({ error: "no_challenge" }, 404);
  }

  // Defensive expiry recheck. KV TTL handles the common case but a clock
  // skew between record-mint and verify-call could leave a stale record
  // visible. Tests also use this path by writing a past expires_at.
  const expiresAtMs = Date.parse(challenge.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return c.json({ error: "challenge_expired" }, 410);
  }

  // Reconstruct expected TXT value server-side; never trust a client value.
  const expectedTxt = buildTxtValue(challenge.challenge, challenge.wallet_address);
  if (expectedTxt !== challenge.txt_value) {
    // Shouldn't happen unless the stored record was hand-edited. Treat as
    // a missing challenge so the caller re-mints rather than retrying.
    return c.json({ error: "no_challenge" }, 404);
  }

  const verifyResult = await verifyTxtBothProviders(challenge.txt_name, expectedTxt);
  if (!verifyResult.ok) {
    const reason = verifyResult.reason;
    const httpStatus = reason === "doh_unreachable" ? 502 : 409;
    return c.json({ ok: false, error: reason, detail: verifyResult.detail }, httpStatus);
  }

  // Check existing binding. Re-verifying with the same wallet is fine
  // (idempotent overwrite). A different wallet is wallet_conflict.
  const bindingRaw = await kv.get(buildBindingKey(domain)).catch(() => null);
  if (typeof bindingRaw === "string") {
    try {
      const existing = JSON.parse(bindingRaw) as DomainClaimBinding;
      if (existing.wallet_address && existing.wallet_address !== wallet) {
        return c.json(
          {
            ok: false,
            error: "wallet_conflict",
            detail: { current_wallet: existing.wallet_address },
          },
          409,
        );
      }
    } catch {
      // Corrupt prior binding. Fall through and overwrite with the new
      // verified record.
    }
  }

  const verifiedAt = new Date().toISOString();
  const agentId = c.var.agent_id ?? "__unknown__";
  // ATA derivation is deferred to Step 6. It needs the SPL token program
  // primitive plus a USDC mint constant, neither of which is shipped here.
  // Leave the field absent; resolver hydration in Step 7 fills it.
  const binding: DomainClaimBinding = {
    domain,
    wallet_address: wallet,
    verified_at: verifiedAt,
    verified_by_agent_id: agentId,
    txt_value_witness: expectedTxt,
    doh_attestations: verifyResult.attestations,
    schema_version: 1,
  };
  await kv.put(buildBindingKey(domain), JSON.stringify(binding));

  // Owner-wallet stamping (Step 4 luminary: the post-verify side effect
  // that turns the verified binding into something computeFlexSplits
  // actually reads). Walks every published skill for this domain and
  // stamps owner_compensation_opt_in + owner_wallet_address +
  // owner_wallet_usdc_ata + owner_wallet_verified_at. Without this hook
  // the OWNER_BPS lane in flex.ts stays dormant in production even
  // after a successful claim. Cherry-pick of peer commit 372bdab5;
  // full reasoning in docs/CLAIM_YOUR_DOMAIN.md.
  //
  // Best-effort: a KV write failure here does NOT undo the binding.
  // The caller already has a verified domain-wallet record; the
  // stamping is a separate read-through-write-back over skill records
  // that callers can re-run via a future admin route if needed.
  const stamp = await stampOwnerOnDomainSkills(c.env, {
    domain,
    wallet_address: wallet,
    verified_at: verifiedAt,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[claim/verify] stampOwnerOnDomainSkills failed: ${err}`);
    return { domain, stamped_count: 0, skill_ids: [] };
  });

  return c.json({
    ok: true,
    verified_at: verifiedAt,
    domain,
    wallet_address: wallet,
    stamped_skills: stamp.stamped_count,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/claim/status
// ---------------------------------------------------------------------------
claimRoutes.get("/claim/status", async (c) => {
  const domainRaw = c.req.query("domain") ?? "";
  if (!isValidApexDomain(domainRaw)) {
    return c.json({ error: "invalid_domain" }, 400);
  }

  const domain = domainRaw.trim().toLowerCase();
  const bindingRaw = await statsKV(c.env).get(buildBindingKey(domain)).catch(() => null);
  if (bindingRaw == null || typeof bindingRaw !== "string") {
    return c.json({ verified: false });
  }
  let binding: DomainClaimBinding;
  try {
    binding = JSON.parse(bindingRaw) as DomainClaimBinding;
  } catch {
    return c.json({ verified: false });
  }
  return c.json({
    verified: true,
    wallet_address: binding.wallet_address,
    verified_at: binding.verified_at,
  });
});

// ===========================================================================
// Takedown surface
//
// A verified domain owner can take their domain DOWN from the marketplace by
// publishing `unbrowse-takedown=<challenge>` at `_unbrowse-claim.<domain>`
// (same TXT name as the claim flow; different VALUE shape).
//
// Flow:
//   POST /claim/takedown/challenge -> mint challenge, persist 24h
//   POST /claim/takedown/verify    -> DoH-verify, disable matching skills,
//                                     write persistent `domain-optout:<d>`
//   GET  /claim/takedown/status    -> public read of opt-out state
// ===========================================================================

interface TakedownChallengeBody {
  domain?: unknown;
}

interface TakedownVerifyBody {
  domain?: unknown;
  reason?: unknown;
}

// POST /v1/claim/takedown/challenge ------------------------------------------
claimRoutes.post("/claim/takedown/challenge", async (c) => {
  let body: TakedownChallengeBody;
  try {
    body = await c.req.json<TakedownChallengeBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const domainRaw = typeof body.domain === "string" ? body.domain : "";
  if (!isValidApexDomain(domainRaw)) {
    return c.json(
      {
        error: "invalid_domain",
        message:
          "domain must be an apex (e.g. example.com); subdomains and casing are normalized at the source.",
      },
      400,
    );
  }

  const domain = domainRaw.trim().toLowerCase();
  const challenge = mintChallenge();
  // Reuse the claim TXT name (_unbrowse-claim.<domain>) so site owners only
  // ever publish one TXT record name. Discriminate by VALUE prefix
  // (`unbrowse-claim=` vs `unbrowse-takedown=`).
  const txtName = buildTxtName(domain);
  const txtValue = buildTakedownTxtValue(challenge);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  const agentId = c.var.agent_id ?? "__unknown__";

  const record: DomainTakedownChallenge = {
    domain,
    challenge,
    txt_name: txtName,
    txt_value: txtValue,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    agent_id: agentId,
  };
  await statsKV(c.env).put(
    buildTakedownChallengeKey(domain),
    JSON.stringify(record),
    { expirationTtl: CHALLENGE_TTL_SECONDS },
  );

  return c.json({
    domain,
    challenge,
    txt_name: txtName,
    txt_value: txtValue,
    expires_at: expiresAt.toISOString(),
  });
});

// POST /v1/claim/takedown/verify ---------------------------------------------
claimRoutes.post("/claim/takedown/verify", async (c) => {
  let body: TakedownVerifyBody;
  try {
    body = await c.req.json<TakedownVerifyBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const domainRaw = typeof body.domain === "string" ? body.domain : "";
  if (!isValidApexDomain(domainRaw)) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  const domain = domainRaw.trim().toLowerCase();
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : undefined;
  const kv = statsKV(c.env);

  // Idempotent takedown: if the opt-out already exists, short-circuit. The
  // verify call MUST succeed regardless of whether DNS is still present —
  // takedown is final and undoable only by admin.
  const existingOptOut = await kv.get(buildOptOutKey(domain)).catch(() => null);
  if (typeof existingOptOut === "string" && existingOptOut.length > 0) {
    let parsed: DomainTakedownRecord | null = null;
    try {
      parsed = JSON.parse(existingOptOut) as DomainTakedownRecord;
    } catch {
      parsed = null;
    }
    return c.json({
      ok: true,
      already_disabled: true,
      domain,
      opted_out_at: parsed?.verified_at,
    });
  }

  // Load pending challenge; reconstruct expected TXT value server-side.
  const challengeRaw = await kv.get(buildTakedownChallengeKey(domain)).catch(() => null);
  if (challengeRaw == null || typeof challengeRaw !== "string") {
    return c.json({ error: "no_challenge" }, 404);
  }
  let challenge: DomainTakedownChallenge;
  try {
    challenge = JSON.parse(challengeRaw) as DomainTakedownChallenge;
  } catch {
    return c.json({ error: "no_challenge" }, 404);
  }

  const expiresAtMs = Date.parse(challenge.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return c.json({ error: "challenge_expired" }, 410);
  }

  const expectedTxt = buildTakedownTxtValue(challenge.challenge);
  if (expectedTxt !== challenge.txt_value) {
    // Should never happen unless the stored record was hand-edited.
    return c.json({ error: "no_challenge" }, 404);
  }

  const verifyResult = await verifyTxtBothProviders(challenge.txt_name, expectedTxt);
  if (!verifyResult.ok) {
    const httpStatus = verifyResult.reason === "doh_unreachable" ? 502 : 409;
    return c.json(
      { ok: false, error: verifyResult.reason, detail: verifyResult.detail },
      httpStatus,
    );
  }

  // DNS proof succeeded. Disable every existing skill for the domain.
  const verifiedAt = new Date().toISOString();
  const agentId = c.var.agent_id ?? "__unknown__";

  // Enumerate skills by domain via the existing listSkills() primitive —
  // there is no listSkillsByDomain() yet and the marketplace already filters
  // by domain in three places (removeDomainFromMarketplace, getSkillByDomain,
  // findExistingByDomain). Adding a new primitive just for takedown would
  // duplicate logic; the cost of listSkills() is the same _idxLoad call
  // those paths already do.
  const skills = await listSkills(c.env);
  const matching = skills.filter(
    (skill) => (skill.domain ?? "").toLowerCase() === domain,
  );
  const skillsKv = skillsKV(c.env);
  const updatedAt = new Date().toISOString();
  let disabledCount = 0;
  for (const skill of matching) {
    if (skill.lifecycle === "disabled") {
      disabledCount += 1;
      continue;
    }
    await skillsKv
      .put(
        `skill:${skill.skill_id}`,
        JSON.stringify({ ...skill, lifecycle: "disabled", updated_at: updatedAt }),
      )
      .catch(() => {});
    disabledCount += 1;
  }

  // Persistent opt-out record. NO TTL — once a domain opts out, the publish
  // path stays gated indefinitely until an admin manually clears the key.
  const record: DomainTakedownRecord = {
    domain,
    verified_at: verifiedAt,
    verified_by_agent_id: agentId,
    txt_value_witness: expectedTxt,
    doh_attestations: verifyResult.attestations,
    reason,
    schema_version: 1,
  };
  await kv.put(buildOptOutKey(domain), JSON.stringify(record));

  return c.json({
    ok: true,
    domain,
    opted_out_at: verifiedAt,
    disabled_count: disabledCount,
  });
});

// GET /v1/claim/takedown/status?domain=<d> -----------------------------------
claimRoutes.get("/claim/takedown/status", async (c) => {
  const domainRaw = c.req.query("domain") ?? "";
  if (!isValidApexDomain(domainRaw)) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  const domain = domainRaw.trim().toLowerCase();
  const raw = await statsKV(c.env).get(buildOptOutKey(domain)).catch(() => null);
  if (raw == null || typeof raw !== "string") {
    return c.json({ opted_out: false });
  }
  let parsed: DomainTakedownRecord | null = null;
  try {
    parsed = JSON.parse(raw) as DomainTakedownRecord;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return c.json({ opted_out: false });
  }
  return c.json({
    opted_out: true,
    opted_out_at: parsed.verified_at,
  });
});

// ===========================================================================
// Official-skills submission flow (lane 6 — plan amendment 2026-05-18)
// ===========================================================================
// A domain owner submits canonical x402-supported endpoints. The submission
// lands in a per-domain KV queue (`storeOfficialSubmission` writes the row +
// the per-domain index). Triage is manual: `promoteOfficialSubmission` runs
// from a script or admin route (not exposed here) to flip status to
// "approved" and write the endpoints into a marketplace skill with
// `owner_submitted: true` + `verification_status: "verified"`. Until then,
// the submission stays "pending" and is invisible to public resolve.
//
// Per the plan amendment: the route prefers bearer-authed submissions for
// agent_id capture but accepts anonymous. Rate-limit (5/24h per domain)
// fires before any KV write so concurrent floods cannot get past the cap.

claimRoutes.post("/claim/submit-official", async (c) => {
  let body: {
    domain?: unknown;
    contact_email?: unknown;
    contact_name?: unknown;
    description?: unknown;
    endpoints?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (typeof body.contact_email !== "string" || !isValidContactEmail(body.contact_email)) {
    return c.json({ error: "invalid_email" }, 400);
  }
  if (typeof body.domain !== "string" || !isValidApexDomain(body.domain)) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  if (!Array.isArray(body.endpoints) || body.endpoints.length === 0) {
    return c.json({ error: "endpoints_required" }, 400);
  }
  if (body.endpoints.length > MAX_ENDPOINTS_PER_SUBMISSION) {
    return c.json(
      {
        error: "too_many_endpoints",
        max: MAX_ENDPOINTS_PER_SUBMISSION,
        received: body.endpoints.length,
      },
      400,
    );
  }
  const endpoints = body.endpoints.map(
    (raw): OfficialSkillSubmissionEndpoint | { __invalid: true } => {
      if (!isValidSubmissionEndpoint(raw)) return { __invalid: true };
      return {
        method: raw.method,
        url_template: raw.url_template,
        description: raw.description,
        x402_supported: raw.x402_supported,
        x402_envelope: raw.x402_envelope,
      };
    },
  );
  const invalidIdx = endpoints.findIndex((e) => "__invalid" in e);
  if (invalidIdx !== -1) {
    return c.json(
      {
        error: "invalid_endpoint",
        index: invalidIdx,
        message:
          "Each endpoint needs a method (GET/POST/...), a non-empty url_template, and a boolean x402_supported.",
      },
      400,
    );
  }
  const validEndpoints = endpoints as OfficialSkillSubmissionEndpoint[];

  const domain = body.domain.trim().toLowerCase();
  const rateLimit = await checkAndIncrementSubmissionRateLimit(c.env, domain);
  if (!rateLimit.ok) {
    return c.json(
      {
        error: "rate_limited",
        message: `Maximum ${SUBMISSION_RATE_LIMIT_COUNT} submissions per domain per 24h. Current count: ${rateLimit.count}.`,
        cap: SUBMISSION_RATE_LIMIT_COUNT,
      },
      429,
    );
  }

  const agentId =
    (c.get?.("agent_id") as string | undefined) ?? undefined;

  const record = await storeOfficialSubmission(c.env, {
    domain,
    contact_email: body.contact_email,
    contact_name: typeof body.contact_name === "string" ? body.contact_name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    endpoints: validEndpoints,
    submitted_by_agent_id: agentId,
  });

  return c.json({
    submission_id: record.submission_id,
    status: record.status,
    message: `Got it. We will email ${record.contact_email} when we triage this submission.`,
  });
});

// Public list of submissions for a domain. Strips `contact_email` and any
// other privately-identifying field so callers can render a status badge
// without leaking the owner's address.
claimRoutes.get("/claim/submissions", async (c) => {
  const domain = c.req.query("domain");
  if (typeof domain !== "string" || !isValidApexDomain(domain)) {
    return c.json({ error: "invalid_domain" }, 400);
  }
  const records = await listSubmissionsForDomain(c.env, domain.trim().toLowerCase());
  const summaries = records.map((r) => ({
    submission_id: r.submission_id,
    status: r.status,
    submitted_at: r.submitted_at,
    endpoint_count: r.endpoints.length,
  }));
  return c.json({ submissions: summaries });
});
