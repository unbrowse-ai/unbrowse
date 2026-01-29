/**
 * POST /skills/publish — Publish a skill to the index.
 *
 * Accepts a skill definition (no credentials) and stores it with the
 * creator's wallet address for x402 profit sharing.
 */

import { createHash } from "node:crypto";
import { getDb } from "../db.js";
import type { PublishBody } from "../types.js";
import { reviewSkill, staticScan } from "../skill-review.js";

/** Generate a deterministic skill ID from service + baseUrl. */
function makeSkillId(service: string, baseUrl: string): string {
  return createHash("sha256")
    .update(`${service}:${baseUrl}`)
    .digest("hex")
    .slice(0, 16);
}

/** Generate a URL-safe slug from a service name. */
function makeSlug(service: string): string {
  return service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Auto-derive tags from service name and endpoint paths. */
function deriveTags(service: string, endpoints: { path: string }[]): string[] {
  const tags = new Set<string>();

  // From service name
  if (service.includes("api")) tags.add("rest");
  if (/finance|stock|trade|bank|pay/i.test(service)) tags.add("finance");
  if (/social|tweet|post|feed/i.test(service)) tags.add("social");
  if (/auth|login|oauth/i.test(service)) tags.add("auth");
  if (/shop|store|product|cart|order/i.test(service)) tags.add("ecommerce");
  if (/ai|ml|model|chat|completion/i.test(service)) tags.add("ai");
  if (/mail|email|smtp/i.test(service)) tags.add("email");
  if (/storage|file|upload|s3|bucket/i.test(service)) tags.add("storage");
  if (/message|chat|notification/i.test(service)) tags.add("messaging");

  // From endpoints
  const allPaths = endpoints.map((e) => e.path).join(" ");
  if (allPaths.includes("/graphql")) tags.add("graphql");
  if (allPaths.includes("/ws") || allPaths.includes("/socket")) tags.add("websocket");
  if (/\/v\d+\//.test(allPaths)) tags.add("versioned");

  // Always add "rest" if endpoints use standard HTTP methods
  if (endpoints.length > 0 && !tags.has("graphql")) tags.add("rest");

  return [...tags];
}

// Ability type pricing (in cents)
const ABILITY_PRICES: Record<string, number> = {
  skill: 1,       // API skills
  pattern: 0,     // Failure resolution patterns (free for now to encourage sharing)
  technique: 2,   // Reusable code snippets
  extension: 5,   // Full clawdbot plugins
  insight: 1,     // Successful approaches
  agent: 10,      // High-fitness agent designs
};

export async function publishSkill(req: Request): Promise<Response> {
  let body: PublishBody & { abilityType?: string; content?: any; priceCents?: number };
  try {
    body = await req.json() as any;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const abilityType = body.abilityType ?? "skill";
  const validTypes = Object.keys(ABILITY_PRICES);
  if (!validTypes.includes(abilityType)) {
    return Response.json(
      { error: `Invalid ability type. Must be one of: ${validTypes.join(", ")}` },
      { status: 400 },
    );
  }

  // Non-skill abilities use content + service (name)
  const isSkill = abilityType === "skill";

  // Validate required fields
  if (isSkill && (!body.service || !body.baseUrl || !body.creatorWallet)) {
    return Response.json(
      { error: "Missing required fields: service, baseUrl, creatorWallet" },
      { status: 400 },
    );
  }
  if (!isSkill && (!body.service || !body.creatorWallet || !body.content)) {
    return Response.json(
      { error: "Missing required fields for ability: service (name), content, creatorWallet" },
      { status: 400 },
    );
  }

  // Validate Solana wallet address (base58, 32-44 chars)
  if (!body.creatorWallet.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
    return Response.json(
      { error: "Invalid Solana wallet address." },
      { status: 400 },
    );
  }

  // ── Pre-screen: fast static scan ──────────────────────────────────
  // Instant reject for known-bad patterns (shell exec, SSH key access, etc.)
  const preScreen = staticScan(body.skillMd ?? "", body.apiTemplate ?? "");
  if (preScreen.blocked) {
    const reasons = preScreen.flags
      .filter(f => f.severity === "block")
      .map(f => f.description);
    console.log(`[publish] BLOCKED ${body.service}: ${reasons.join(", ")}`);
    return Response.json(
      {
        error: "Skill rejected by safety review",
        reasons,
        flags: preScreen.flags,
      },
      { status: 422 },
    );
  }

  const db = getDb();
  const id = isSkill
    ? makeSkillId(body.service, body.baseUrl)
    : makeSkillId(body.service, abilityType); // Non-skills use type as part of ID
  const slug = makeSlug(body.service);
  const tags = isSkill ? deriveTags(body.service, body.endpoints ?? []) : [abilityType];
  const priceCents = body.priceCents ?? ABILITY_PRICES[abilityType];
  const searchText = [
    body.service,
    body.baseUrl ?? "",
    body.authMethodType ?? "",
    ...(body.endpoints ?? []).map((e) => `${e.method} ${e.path}`),
    ...tags,
    // For non-skills, index content fields for search
    ...(body.content ? Object.values(body.content).filter(v => typeof v === "string") as string[] : []),
  ].join(" ");

  // Check if skill exists
  const existing = db.query("SELECT id, creator_wallet, version FROM skills WHERE id = ?").get(id) as any;

  if (existing) {
    // Update if same creator
    if (existing.creator_wallet.toLowerCase() !== body.creatorWallet.toLowerCase()) {
      return Response.json(
        { error: "This skill was published by a different wallet. Fork not yet supported." },
        { status: 409 },
      );
    }

    const newVersion = (existing.version ?? 1) + 1;
    db.run(`
      UPDATE skills SET
        auth_method_type = ?,
        endpoints_json = ?,
        skill_md = ?,
        api_template = ?,
        endpoint_count = ?,
        tags_json = ?,
        search_text = ?,
        version = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `, [
      body.authMethodType,
      JSON.stringify(body.endpoints ?? []),
      body.skillMd ?? "",
      body.apiTemplate ?? "",
      (body.endpoints ?? []).length,
      JSON.stringify(tags),
      searchText,
      newVersion,
      id,
    ]);

    // Kick off async LLM review — skill is pending until approved
    reviewSkill(id).then(result => {
      console.log(`[publish] Review ${body.service} v${newVersion}: ${result.status} (score: ${result.score}) — ${result.reason}`);
    }).catch(err => {
      console.error(`[publish] Review failed for ${body.service}: ${err}`);
    });

    return Response.json({ id, slug, version: newVersion, reviewStatus: "pending" });
  }

  // Insert new skill/ability
  db.run(`
    INSERT INTO skills (id, service, slug, version, base_url, auth_method_type,
                        endpoints_json, skill_md, api_template, creator_wallet,
                        endpoint_count, tags_json, search_text,
                        ability_type, price_cents, content_json)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, body.service, slug, body.baseUrl ?? "", body.authMethodType ?? "",
    JSON.stringify(body.endpoints ?? []),
    body.skillMd ?? "",
    body.apiTemplate ?? "",
    body.creatorWallet,
    (body.endpoints ?? []).length,
    JSON.stringify(tags),
    searchText,
    abilityType,
    priceCents,
    body.content ? JSON.stringify(body.content) : null,
  ]);

  // Kick off async LLM review — skill is pending until approved
  reviewSkill(id).then(result => {
    console.log(`[publish] Review ${body.service} v1: ${result.status} (score: ${result.score}) — ${result.reason}`);
  }).catch(err => {
    console.error(`[publish] Review failed for ${body.service}: ${err}`);
  });

  return Response.json({ id, slug, version: 1, reviewStatus: "pending" }, { status: 201 });
}
