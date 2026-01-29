/**
 * GET /skills/search — Free full-text search over the skill index.
 */

import { getDb } from "../db.js";
import type { SkillSummary } from "../types.js";

export function searchSkills(req: Request): Response {
  const url = new URL(req.url);
  const query = url.searchParams.get("q") ?? "";
  const tags = url.searchParams.get("tags") ?? "";
  const abilityType = url.searchParams.get("type") ?? ""; // Filter by ability type
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  const db = getDb();

  let skills: SkillSummary[];
  let total: number;

  // Only show approved skills in search results (unless ?include_unreviewed=true for admin)
  const includeUnreviewed = url.searchParams.get("include_unreviewed") === "true";
  const reviewFilter = includeUnreviewed
    ? "AND (s.review_status = 'approved' OR s.review_status IS NULL OR s.review_status = 'pending')"
    : "AND (s.review_status = 'approved' OR s.review_status IS NULL)";

  // Ability type filter
  const typeFilter = abilityType
    ? `AND (s.ability_type = '${abilityType}' OR (s.ability_type IS NULL AND '${abilityType}' = 'skill'))`
    : "";
  // Note: IS NULL handles legacy rows that predate the review system

  if (query) {
    // Full-text search via FTS5
    const ftsQuery = query.split(/\s+/).map((w) => `"${w}"`).join(" OR ");
    const rows = db.query(`
      SELECT s.id, s.service, s.slug, s.base_url, s.auth_method_type,
             s.endpoint_count, s.download_count, s.tags_json,
             s.creator_wallet, s.creator_alias, s.updated_at,
             s.review_status, s.review_score, s.ability_type, s.price_cents
      FROM skills s
      JOIN skills_fts fts ON s.rowid = fts.rowid
      WHERE skills_fts MATCH ? ${reviewFilter} ${typeFilter}
      ORDER BY s.download_count DESC
      LIMIT ? OFFSET ?
    `).all(ftsQuery, limit, offset) as any[];

    const countRow = db.query(`
      SELECT COUNT(*) as cnt
      FROM skills s
      JOIN skills_fts fts ON s.rowid = fts.rowid
      WHERE skills_fts MATCH ? ${reviewFilter} ${typeFilter}
    `).get(ftsQuery) as any;

    total = countRow?.cnt ?? 0;
    skills = rows.map(mapRow);
  } else if (tags) {
    // Tag-based filter
    const tagList = tags.split(",").map((t) => t.trim().toLowerCase());
    const rows = db.query(`
      SELECT s.id, s.service, s.slug, s.base_url, s.auth_method_type,
             s.endpoint_count, s.download_count, s.tags_json,
             s.creator_wallet, s.creator_alias, s.updated_at,
             s.review_status, s.review_score, s.ability_type, s.price_cents
      FROM skills s
      WHERE (${tagList.map(() => "s.tags_json LIKE ?").join(" OR ")}) ${reviewFilter} ${typeFilter}
      ORDER BY s.download_count DESC
      LIMIT ? OFFSET ?
    `).all(...tagList.map((t) => `%"${t}"%`), limit, offset) as any[];

    total = rows.length;
    skills = rows.map(mapRow);
  } else {
    // Browse all — most popular first
    const rows = db.query(`
      SELECT s.id, s.service, s.slug, s.base_url, s.auth_method_type,
             s.endpoint_count, s.download_count, s.tags_json,
             s.creator_wallet, s.creator_alias, s.updated_at,
             s.review_status, s.review_score, s.ability_type, s.price_cents
      FROM skills s
      WHERE 1=1 ${reviewFilter} ${typeFilter}
      ORDER BY s.download_count DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    const countRow = db.query(`SELECT COUNT(*) as cnt FROM skills s WHERE 1=1 ${reviewFilter} ${typeFilter}`).get() as any;
    total = countRow?.cnt ?? 0;
    skills = rows.map(mapRow);
  }

  return Response.json({ skills, total });
}

function mapRow(row: any): SkillSummary & { reviewStatus?: string; reviewScore?: number | null; abilityType?: string; priceCents?: number } {
  return {
    id: row.id,
    service: row.service,
    slug: row.slug,
    baseUrl: row.base_url,
    authMethodType: row.auth_method_type,
    endpointCount: row.endpoint_count,
    downloadCount: row.download_count,
    tags: JSON.parse(row.tags_json ?? "[]"),
    creatorWallet: row.creator_wallet,
    creatorAlias: row.creator_alias ?? undefined,
    updatedAt: row.updated_at,
    reviewStatus: row.review_status ?? "approved",
    reviewScore: row.review_score ?? null,
    abilityType: row.ability_type ?? "skill",
    priceCents: row.price_cents ?? 1,
  };
}

/** GET /abilities/leaderboard — Top abilities by unique payers and rank score. */
export function getLeaderboard(req: Request): Response {
  const url = new URL(req.url);
  const abilityType = url.searchParams.get("type") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);

  const db = getDb();

  const typeFilter = abilityType
    ? `WHERE (ability_type = '${abilityType}' OR (ability_type IS NULL AND '${abilityType}' = 'skill'))`
    : "";

  const rows = db.query(`
    SELECT * FROM ability_leaderboard
    ${typeFilter}
    LIMIT ?
  `).all(limit) as any[];

  const abilities = rows.map(row => ({
    id: row.id,
    service: row.service,
    slug: row.slug,
    abilityType: row.ability_type ?? "skill",
    downloadCount: row.download_count,
    uniquePayers: row.unique_payers ?? 0,
    rankScore: row.rank_score ?? 0,
    reviewScore: row.review_score ?? null,
    priceCents: row.price_cents ?? 1,
    creatorWallet: row.creator_wallet,
  }));

  return Response.json({ abilities, total: abilities.length });
}
