#!/usr/bin/env bun
// Backfill the local skill caches → backend marketplace. Publishing was historically
// broken, so real captures live only in ~/.unbrowse/skill-snapshots + skill-cache.
// This publishes the ones whose FORMAT SHAPE MATCHES (isBackfillableManifest), via the
// real publishSkill path (now bearer-optional). Junk/malformed/non-indexable skipped.
//
//   bun scripts/backfill-local-cache.ts            # DRY RUN (counts only)
//   bun scripts/backfill-local-cache.ts --apply    # actually publish
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isBackfillableManifest, cleanBackfillManifest, dedupeBackfill, type BackfillCandidate } from "../src/lib/backfill.js";
import { publishSkill } from "../src/marketplace/index.js";

const APPLY = process.argv.includes("--apply");
const root = process.env.UNBROWSE_CONFIG_DIR || join(homedir(), ".unbrowse");
const dirs = [join(root, "skill-snapshots"), join(root, "skill-cache")];

const candidates: (BackfillCandidate & Record<string, unknown>)[] = [];
let scanned = 0, malformed = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    scanned++;
    try {
      const obj = JSON.parse(readFileSync(join(dir, name), "utf-8"));
      if (isBackfillableManifest(obj)) candidates.push(obj as BackfillCandidate & Record<string, unknown>);
      else malformed++;
    } catch { malformed++; }
  }
}
const unique = dedupeBackfill(candidates);
console.error(`[backfill] scanned ${scanned} cached files · shape-match ${candidates.length} · unique ${unique.length} · skipped ${malformed}`);

if (!APPLY) {
  const byDomain: Record<string, number> = {};
  for (const m of unique) byDomain[m.domain] = (byDomain[m.domain] ?? 0) + 1;
  console.error("[backfill] DRY RUN — top domains:", Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 12));
  console.error("[backfill] re-run with --apply to publish.");
  process.exit(0);
}

let landed = 0, failed = 0, noEndpoints = 0, done = 0;
for (const m of unique) {
  const cleaned = cleanBackfillManifest(m); // strip junk endpoints; null ⇒ nothing publishable
  if (!cleaned) { noEndpoints++; continue; }
  try {
    const r = await publishSkill(cleaned as unknown as Parameters<typeof publishSkill>[0]);
    if ((r as { published_remotely?: boolean }).published_remotely === false) {
      failed++;
      console.error(`[backfill] not-landed ${m.skill_id} (${m.domain}) — remote rejected, local-cached only`);
    } else {
      landed++;
    }
  } catch (err) {
    failed++;
    console.error(`[backfill] FAILED ${m.skill_id} (${m.domain}): ${(err as Error)?.message ?? err}`);
  }
  done++;
  if (done % 5 === 0) console.error(`[backfill] ${done}/${unique.length} (landed ${landed})...`);
  await new Promise((res) => setTimeout(res, 600)); // pace under the /skills rate limit
}
console.error(`[backfill] DONE — landed(remote) ${landed} · failed ${failed} · no-publishable-endpoints ${noEndpoints} · skipped(malformed) ${malformed}`);
