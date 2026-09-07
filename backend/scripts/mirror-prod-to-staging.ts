#!/usr/bin/env bun
/**
 * One-way prod -> staging mirror. NEVER reverse. Run from operator machine
 * with both EMERGENTDB_*_API_KEY env vars set. The worker itself does NOT
 * run this; the worker only reads/writes its own env's namespace.
 *
 * Day-3 (Land) seed of the marketplace backfill.
 *
 *   Source (read-only): namespace "skills-v2"           -> EMERGENTDB_PROD_API_KEY
 *   Destination (write):  namespace "staging-skills-v3" -> EMERGENTDB_STAGING_API_KEY
 *
 * Directionality is hardcoded. There is no --direction flag and no env switch
 * that can flip prod and staging. Reversing requires editing this file.
 *
 * Flags:
 *   --dry-run        Count + sample only, no writes. (default: false; set this
 *                    explicitly for safety in CI/local first runs.)
 *   --limit N        Process at most N skill keys. (default: unlimited)
 *   --prefix STR     Key prefix in the namespace. (default: "skill:")
 *
 * Idempotent: if a staging skill with the same skill_id has a HIGHER
 * updated_at than the prod copy, the prod write is SKIPPED. Staging-side
 * edits are not clobbered on re-runs.
 *
 * Day-5 will harden this (concurrency, retries, smoke test, npm script).
 */

const PROD_NAMESPACE = "skills-v2";
const STAGING_NAMESPACE = "staging-skills-v3";
const EBASE = "https://api.emergentdb.com";

const PROD_KEY = process.env.EMERGENTDB_PROD_API_KEY;
const STAGING_KEY = process.env.EMERGENTDB_STAGING_API_KEY;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!PROD_KEY) {
  die(
    "EMERGENTDB_PROD_API_KEY is not set. Refusing to run. " +
      "Set EMERGENTDB_PROD_API_KEY (read-only on '" +
      PROD_NAMESPACE +
      "') and EMERGENTDB_STAGING_API_KEY (write on '" +
      STAGING_NAMESPACE +
      "') and re-run.",
  );
}
if (!STAGING_KEY) {
  die(
    "EMERGENTDB_STAGING_API_KEY is not set. Refusing to run. " +
      "Set EMERGENTDB_STAGING_API_KEY (write on '" +
      STAGING_NAMESPACE +
      "') and re-run.",
  );
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");

function argValue(flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1] ?? fallback;
}

const LIMIT_RAW = argValue("--limit", "");
const LIMIT = LIMIT_RAW ? Number.parseInt(LIMIT_RAW, 10) : Number.POSITIVE_INFINITY;
if (LIMIT_RAW && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  die(`--limit must be a positive integer, got "${LIMIT_RAW}"`);
}
const PREFIX = argValue("--prefix", "skill:");

type SkillLike = {
  skill_id?: string;
  domain?: string;
  version?: string | number;
  updated_at?: string | number;
};

type EdbEntry = { key: string; value: string };

function headersFor(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function edbGetIndex(apiKey: string, namespace: string): Promise<string[]> {
  const fullKey = `${namespace}:_idx`;
  const res = await fetch(`${EBASE}/qdkv/get`, {
    method: "POST",
    headers: headersFor(apiKey),
    body: JSON.stringify({ key: fullKey }),
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `qdkv get _idx failed for ${fullKey}: ${res.status} ${await res.text()}`,
    );
  }
  const data: any = await res.json();
  const value = data?.value ?? data?.result ?? data;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

async function edbGet(apiKey: string, namespace: string, key: string): Promise<string | null> {
  const fullKey = `${namespace}:${key}`;
  const res = await fetch(`${EBASE}/qdkv/get`, {
    method: "POST",
    headers: headersFor(apiKey),
    body: JSON.stringify({ key: fullKey }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`qdkv get failed for ${fullKey}: ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  const value = data?.value ?? data?.result ?? null;
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function edbSet(apiKey: string, namespace: string, key: string, value: string): Promise<void> {
  const fullKey = `${namespace}:${key}`;
  const res = await fetch(`${EBASE}/qdkv/set`, {
    method: "POST",
    headers: headersFor(apiKey),
    body: JSON.stringify({ key: fullKey, value }),
  });
  if (!res.ok) {
    throw new Error(`qdkv set failed for ${fullKey}: ${res.status} ${await res.text()}`);
  }
}

function parseSkill(raw: string | null): SkillLike | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillLike;
  } catch {
    return null;
  }
}

function toMillis(updatedAt: SkillLike["updated_at"]): number {
  if (updatedAt == null) return 0;
  if (typeof updatedAt === "number") return updatedAt;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? t : 0;
}

async function main(): Promise<void> {
  console.log(`mirror-prod-to-staging  prod="${PROD_NAMESPACE}" -> staging="${STAGING_NAMESPACE}"`);
  console.log(`  dry_run=${DRY_RUN}  limit=${LIMIT === Number.POSITIVE_INFINITY ? "unlimited" : LIMIT}  prefix="${PREFIX}"`);

  const allKeys = await edbGetIndex(PROD_KEY!, PROD_NAMESPACE);
  const keys = allKeys.filter((k) => typeof k === "string" && k.startsWith(PREFIX));
  console.log(`prod index: ${allKeys.length} total keys, ${keys.length} match prefix "${PREFIX}"`);

  const targetKeys = Number.isFinite(LIMIT) ? keys.slice(0, LIMIT) : keys;
  console.log(`will process ${targetKeys.length} key(s)`);

  let written = 0;
  let skippedNewer = 0;
  let skippedDry = 0;
  let errors = 0;

  for (const key of targetKeys) {
    try {
      const prodRaw = await edbGet(PROD_KEY!, PROD_NAMESPACE, key);
      if (prodRaw == null) {
        console.log(`  [miss] ${key}  prod returned no value (stale index?)`);
        continue;
      }
      const prodSkill = parseSkill(prodRaw);
      const summary = prodSkill
        ? `skill_id=${prodSkill.skill_id ?? "?"} domain=${prodSkill.domain ?? "?"} version=${prodSkill.version ?? "?"}`
        : `(unparseable JSON; ${prodRaw.length}B)`;
      console.log(`  [prod] ${key}  ${summary}`);

      if (DRY_RUN) {
        skippedDry++;
        continue;
      }

      const stagingRaw = await edbGet(STAGING_KEY!, STAGING_NAMESPACE, key);
      if (stagingRaw) {
        const stagingSkill = parseSkill(stagingRaw);
        const stagingUpd = toMillis(stagingSkill?.updated_at);
        const prodUpd = toMillis(prodSkill?.updated_at);
        const sameId =
          stagingSkill?.skill_id != null &&
          prodSkill?.skill_id != null &&
          stagingSkill.skill_id === prodSkill.skill_id;
        if (sameId && stagingUpd > prodUpd) {
          console.log(
            `    skip: staging updated_at (${stagingSkill?.updated_at}) > prod (${prodSkill?.updated_at})`,
          );
          skippedNewer++;
          continue;
        }
      }

      await edbSet(STAGING_KEY!, STAGING_NAMESPACE, key, prodRaw);
      written++;
      console.log(`    write: ${key}`);
    } catch (e) {
      errors++;
      console.error(`  [err] ${key}: ${(e as Error).message}`);
    }
  }

  console.log("");
  console.log(
    `done. processed=${targetKeys.length} written=${written} skipped_newer_in_staging=${skippedNewer} dry_run_sampled=${skippedDry} errors=${errors}`,
  );
  if (errors > 0) process.exit(2);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
