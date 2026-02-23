#!/usr/bin/env node
/**
 * Migrate Cloudflare KV → EmergentDB qdkv + vector index.
 * Uses CF REST API for bulk reads (much faster than wrangler CLI).
 */

import { execSync } from "child_process";

const EMERGENTDB_API_KEY = "emdb_HgUO931Kj9BZQHppxTBB3VsoSibXozcS";
const GEMINI_API_KEY = "REMOVED_GOOGLE_API_KEY";
const EBASE = "https://api.emergentdb.com";
const DIMS = 1536;

// CF KV namespace IDs
const SKILLS_NS_ID = "dfc844e685144df485790a8933796b28";
const STATS_NS_ID = "1d315d7cda1742b785cf5d23c892c5d7";

// Get CF account ID and API token from wrangler
const CF_ACCOUNT_ID = execSync("npx wrangler whoami 2>/dev/null | grep -oE '[a-f0-9]{32}' | head -1").toString().trim();
// Use wrangler's own token
const CF_API_TOKEN = execSync("cat ~/.wrangler/config/default.toml 2>/dev/null | grep oauth_token | cut -d'\"' -f2 || echo ''").toString().trim();

// We'll use wrangler CLI for reads since getting the CF token programmatically is tricky
// But batch them with concurrency

const edbHeaders = {
  Authorization: `Bearer ${EMERGENTDB_API_KEY}`,
  "Content-Type": "application/json",
};

function domainNamespace(domain) {
  return `unbrowse--${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}

function hashToInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

async function embedIntent(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIMS,
      }),
    }
  );
  const data = await res.json();
  const raw = data.embedding?.values ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

async function edbPut(nsPrefix, key, value) {
  const fullKey = `${nsPrefix}:${key}`;
  const res = await fetch(`${EBASE}/qdkv/set`, {
    method: "POST",
    headers: edbHeaders,
    body: JSON.stringify({ key: fullKey, value }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`qdkv set failed for ${fullKey}: ${res.status} ${t}`);
  }
}

async function edbIdxSet(nsPrefix, keys) {
  const fullKey = `${nsPrefix}:_idx`;
  const res = await fetch(`${EBASE}/qdkv/set`, {
    method: "POST",
    headers: edbHeaders,
    body: JSON.stringify({ key: fullKey, value: JSON.stringify(keys) }),
  });
  if (!res.ok) throw new Error(`qdkv idx set failed: ${res.status}`);
}

async function vectorInsert(namespace, id, vector, metadata) {
  const res = await fetch(`${EBASE}/vectors/insert`, {
    method: "POST",
    headers: edbHeaders,
    body: JSON.stringify({ id, vector, metadata, namespace }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`vector insert failed: ${res.status} ${t}`);
  }
}

function cfGetValue(nsId, key) {
  try {
    return execSync(
      `npx wrangler kv key get --namespace-id ${nsId} "${key.replace(/"/g, '\\"')}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024 }
    ).toString();
  } catch {
    return null;
  }
}

function cfListKeys(nsId) {
  const raw = execSync(`npx wrangler kv key list --namespace-id ${nsId} 2>/dev/null`, {
    maxBuffer: 50 * 1024 * 1024,
  }).toString();
  return JSON.parse(raw).map((k) => k.name);
}

// Process N items concurrently
async function pool(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function migrateNamespace(nsId, edbPrefix, label, indexVectors = false) {
  console.log(`\n=== Migrating ${label} ===`);
  const allKeys = cfListKeys(nsId);
  console.log(`Found ${allKeys.length} keys`);

  const kvKeys = [];
  let written = 0;
  let vectors = 0;
  let errors = 0;

  // Read all values from CF first (this is the slow part)
  console.log("Reading values from CF KV...");
  const entries = [];
  for (let i = 0; i < allKeys.length; i++) {
    const key = allKeys[i];
    const value = cfGetValue(nsId, key);
    if (value != null) {
      entries.push({ key, value });
    }
    if ((i + 1) % 20 === 0 || i === allKeys.length - 1) {
      process.stdout.write(`\r  Read ${i + 1}/${allKeys.length}`);
    }
  }
  console.log(`\nRead ${entries.length} values, writing to EmergentDB...`);

  // Write to qdkv in parallel batches
  await pool(entries, async ({ key, value }) => {
    try {
      await edbPut(edbPrefix, key, value);
      kvKeys.push(key);
      written++;

      // Vector-index skill: keys
      if (indexVectors && key.startsWith("skill:")) {
        const skill = JSON.parse(value);
        if (skill.lifecycle === "active" && skill.intent_signature) {
          const vector = await embedIntent(skill.intent_signature);
          const numericId = hashToInt(skill.skill_id);
          const meta = {
            title: skill.intent_signature,
            content: JSON.stringify({
              skill_id: skill.skill_id,
              domain: skill.domain,
              subdomain: skill.subdomain,
              name: skill.name,
              description: skill.description,
              avg_reliability: 0.5,
              verified_ratio: 0,
              updated_at: skill.updated_at,
            }),
            tags: [skill.domain, skill.subdomain].filter(Boolean),
            source_url: skill.domain || "",
          };
          const ns = domainNamespace(skill.domain);
          await Promise.all([
            vectorInsert(ns, numericId, vector, meta),
            vectorInsert("unbrowse--global", numericId, vector, meta),
          ]);
          vectors++;
        }
      }

      if (written % 10 === 0) {
        process.stdout.write(`\r  Written ${written}/${entries.length} kv, ${vectors} vectors`);
      }
    } catch (e) {
      errors++;
      console.log(`\n  ERROR ${key}: ${e.message}`);
    }
  }, 5);

  // Write the index
  await edbIdxSet(edbPrefix, kvKeys);
  console.log(`\n${label} done: ${written} keys, ${vectors} vectors, ${errors} errors`);
}

async function main() {
  await migrateNamespace(SKILLS_NS_ID, "skills", "SKILLS_KV", true);
  await migrateNamespace(STATS_NS_ID, "stats", "STATS_KV", false);
  console.log("\n=== Migration complete ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
