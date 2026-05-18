/**
 * /v1/claim/* routes — DNS-TXT domain-wallet verification surface.
 *
 * Contract source: .claude/firmament-step2.md
 *
 * SEED-ONLY for Step 2. Handlers return structurally-correct envelopes but
 * do not yet write to KV or call DoH. Each handler ends with a TODO marker
 * naming the step that plugs the behaviour in.
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  buildTxtName,
  buildTxtValue,
  isValidApexDomain,
  isValidSolanaPubkey,
  mintChallenge,
} from "../services/domain-claim.js";

type ClaimEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const claimRoutes = new Hono<ClaimEnv>();

// Bearer auth gates challenge mint + verify. Status read stays public per
// firmament-step2.md "Public vs authed routes". Hono's first-match dispatch
// means we attach the middleware to the two POST paths individually rather
// than to /claim/*.
claimRoutes.use("/claim/challenge", bearerAuth);
claimRoutes.use("/claim/verify", bearerAuth);

// Challenge TTL is 24h per the spec; surface here so the seed's expires_at
// envelope is self-consistent even before the KV write lands.
const CHALLENGE_TTL_SECONDS = 24 * 60 * 60;

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
  const challenge = mintChallenge();
  const txtName = buildTxtName(domain);
  const txtValue = buildTxtValue(challenge, wallet);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);

  // TODO step 4: write DomainClaimChallenge to statsKV under
  // buildChallengeKey(domain, wallet) with expirationTtl =
  // CHALLENGE_TTL_SECONDS, and enforce the buildRateLimitKey counter
  // (<=10/hour returns 429 rate_limited).
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

  // TODO step 4: load the pending challenge from
  // buildChallengeKey(domain, wallet); reconstruct the expected txt_value
  // server-side; call verifyTxtBothProviders(txt_name, txt_value); on
  // success, write DomainClaimBinding to buildBindingKey(domain) and
  // return { ok: true, verified_at, domain, wallet_address }. Until then
  // surface 501 not_implemented so callers know the surface exists but
  // the verification gate has not been wired.
  return c.json(
    {
      ok: false,
      error: "not_implemented",
      message: "DoH verification stub; lands in step 4",
    },
    501,
  );
});

// ---------------------------------------------------------------------------
// GET /v1/claim/status
// ---------------------------------------------------------------------------
claimRoutes.get("/claim/status", async (c) => {
  const domainRaw = c.req.query("domain") ?? "";
  if (!isValidApexDomain(domainRaw)) {
    return c.json({ error: "invalid_domain" }, 400);
  }

  // TODO step 4: read DomainClaimBinding from buildBindingKey(domain);
  // return { verified: true, wallet_address, verified_at } when present,
  // else { verified: false }.
  return c.json({
    verified: false,
    message: "binding lookup stub; lands in step 4",
  });
});
