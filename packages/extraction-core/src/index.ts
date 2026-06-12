// @unbrowse/extraction-core — runtime-neutral deterministic extraction.
//
// The shared, Worker-clean extraction logic. Imported by both the CLI
// (src/) and the Cloudflare Worker backend (backend/src/) so the
// deterministic post-capture processing has ONE source of truth instead
// of a cross-tree import that breaks each side's tsconfig rootDir.
//
// Wave 2 STEP 1 of the move-only-the-deterministic-credential-free-non-
// harness (pointer-not-payload principle 20260522T031732Z-3c67f936).
//
// This package MUST stay runtime-neutral: no browser, no credentials,
// no Node-only (fs/child_process/process.env) and no Worker-only APIs.
// Its tsconfig deliberately omits the DOM, node, and workers type libs
// so a runtime-specific dependency fails to compile here — the boundary
// enforces itself.

export * from "./dom.js";
export { projectIntentData, assessIntentResult } from "./intent-match.js";
