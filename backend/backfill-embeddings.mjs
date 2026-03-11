#!/usr/bin/env node
/**
 * Backfill EmergentDB vector index with Nebius Qwen3-Embedding-8B embeddings.
 * Reads existing skills from the OLD vector namespace (unbrowse--global),
 * re-embeds with Nebius, and writes to v2 namespaces.
 *
 * Usage: NEBIUS_API_KEY=... EMERGENTDB_API_KEY=... node backfill-embeddings.mjs
 */

const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY;
const EMERGENTDB_API_KEY = process.env.EMERGENTDB_API_KEY || "emdb_t2nmTrwHB6x2j7lJhe51GvmoG8bIS0Ii";
const EBASE = "https://api.emergentdb.com";
const DIMS = 1536;

// Old namespace (source) vs new namespace (target)
const OLD_GLOBAL_NS = "unbrowse--global";
const NS_PREFIX = "unbrowse-v2--";

if (!NEBIUS_API_KEY) {
  console.error("NEBIUS_API_KEY is required");
  process.exit(1);
}

const edbHeaders = {
  Authorization: `Bearer ${EMERGENTDB_API_KEY}`,
  "Content-Type": "application/json",
};

function domainNamespace(domain) {
  return `${NS_PREFIX}${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}

async function embedIntent(text) {
  const res = await fetch(
    "https://api.tokenfactory.nebius.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NEBIUS_API_KEY}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-Embedding-8B",
        input: text,
        dimensions: DIMS,
      }),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Nebius embed failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  const raw = data.data?.[0]?.embedding ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

async function vectorSearch(namespace, vector, k) {
  const res = await fetch(`${EBASE}/vectors/search`, {
    method: "POST",
    headers: edbHeaders,
    body: JSON.stringify({ vector, k, include_metadata: true, namespace }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`vector search failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.results || [];
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

/**
 * Pull all skills from the old vector namespace by doing a broad search.
 * We use a random vector and request k=200 to get everything.
 */
async function getAllSkillsFromVectorStore() {
  // Use a real embedding to get a valid vector shape
  const probeVector = await embedIntent("API skill endpoint");
  const results = await vectorSearch(OLD_GLOBAL_NS, probeVector, 200);
  return results.filter((r) => r.metadata);
}

async function main() {
  console.log(`=== Backfill Embeddings: Nebius Qwen3-Embedding-8B → ${NS_PREFIX}* namespaces ===\n`);

  // Test embedding call first
  console.log("Testing Nebius embedding API...");
  try {
    const testVec = await embedIntent("test");
    console.log(`OK — got ${testVec.length}-dim vector\n`);
  } catch (e) {
    console.error("Nebius embedding test failed:", e.message);
    process.exit(1);
  }

  console.log(`Fetching skills from old vector store (${OLD_GLOBAL_NS})...`);
  const oldSkills = await getAllSkillsFromVectorStore();
  console.log(`Found ${oldSkills.length} skills with metadata\n`);

  let embedded = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < oldSkills.length; i++) {
    const result = oldSkills[i];
    const meta = result.metadata;
    try {
      const title = meta.title;
      if (!title || title === "undefined" || title === "test") {
        skipped++;
        continue;
      }

      // Parse the content JSON to get skill_id and domain
      let contentData = {};
      try { contentData = JSON.parse(meta.content || "{}"); } catch { /* empty */ }

      const skillId = contentData.skill_id;
      const domain = contentData.domain || meta.source_url || "global";
      if (!skillId) {
        skipped++;
        continue;
      }

      // Re-embed the intent signature with Nebius
      const vector = await embedIntent(title);

      const newMeta = {
        title,
        content: meta.content,
        tags: meta.tags || [domain],
        source_url: meta.source_url || domain,
      };

      const ns = domainNamespace(domain);
      await Promise.all([
        vectorInsert(ns, result.id, vector, newMeta),
        vectorInsert(`${NS_PREFIX}global`, result.id, vector, newMeta),
      ]);

      embedded++;
      process.stdout.write(`\r  ${embedded} embedded, ${skipped} skipped, ${errors} errors (${i + 1}/${oldSkills.length})`);
    } catch (e) {
      errors++;
      console.log(`\n  ERROR id=${result.id}: ${e.message}`);
    }
  }

  console.log(`\n\n=== Backfill complete ===`);
  console.log(`  Embedded: ${embedded}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
