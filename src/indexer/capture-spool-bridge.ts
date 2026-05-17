// Drain-side bridge between the raw capture-spool envelope and the existing
// durable index pipeline. The spool stores the cheap RawRequest[] cut of a
// capture; this processor pours it through the existing broker-free
// `passiveIndexFromRequests`, which already terminates in
// `writeSkillSnapshot` + `persistDomainCache` + `queueBackgroundIndex`.
//
// The bridge has no business logic of its own: a single payload->call
// adapter that awaits the pipeline so `drainCaptureSpoolOnce` knows when
// to delete the spool envelope. Lazy import of `passiveIndexFromRequests`
// avoids a cyclic dependency between src/indexer/* and src/api/routes.ts.
import type { CaptureSpoolPayload, CaptureSpoolProcessor } from "./capture-spool.js";

/**
 * Returns a `CaptureSpoolProcessor` that drains one envelope by calling
 * the existing `passiveIndexFromRequests` (now awaitable). Reuses the
 * full enrichment + index pipeline, so a successful drain produces the
 * same on-disk artefacts a live `lightFlushBrowseCapture` would
 * (`~/.unbrowse/domain-skill-cache.json` + `skill-snapshots/<...>.json`
 * + `queue/pending/<...>.json`).
 */
export function makeCaptureSpoolProcessor(): CaptureSpoolProcessor {
  return async (capture: CaptureSpoolPayload): Promise<void> => {
    // Lazy dynamic import: capture-spool-bridge lives under src/indexer/,
    // routes.ts already imports queueBackgroundIndex from src/indexer/index.js,
    // so a top-level `import { passiveIndexFromRequests } from "../api/routes.js"`
    // would close a cycle through the indexer barrel. Lazy import keeps the
    // resolution one-directional and pays the cost only when a drain runs.
    const { passiveIndexFromRequests } = await import("../api/routes.js");
    await passiveIndexFromRequests(capture.requests, capture.sessionUrl, {
      publishAfterIndex: capture.publishAfterIndex,
    });
  };
}
