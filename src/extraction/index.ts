// Strangler-fig re-export shim. The extraction logic moved to the
// @unbrowse/extraction-core workspace package (Wave 2 STEP 1 of the
// move-only-the-deterministic-credential-free-non- harness) so the
// backend Cloudflare Worker can import the SAME deterministic code
// without a cross-tree import that breaks tsconfig rootDir.
//
// This file stays as a re-export so every existing
// `import { extractFromDOM } from "../extraction/index.js"` call site
// keeps resolving unchanged — the migration is invisible to callers;
// only the physical file location moved. New code should import from
// "@unbrowse/extraction-core" directly.
export * from "@unbrowse/extraction-core";
