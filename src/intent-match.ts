// Strangler-fig re-export shim. intent-match moved to the
// @unbrowse/extraction-core workspace package (Wave 2 STEP 1 of the
// move-only-the-deterministic-credential-free-non- harness). This file
// stays as a re-export so every existing
// `import { assessIntentResult } from "../intent-match.js"` call site
// keeps resolving unchanged. New code should import from
// "@unbrowse/extraction-core/intent-match" directly.
export * from "@unbrowse/extraction-core/intent-match";
