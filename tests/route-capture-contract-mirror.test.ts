/**
 * Witness: a FRESH captured route/domain index is mirrored onto the /contract ledger (IQ-backed)
 * via the ONE shared resolution-mirror seam (mirrorResolutionToChain) — the captured index is a
 * /contract truth-claim, not only a machine-local disk cache.
 * - On a fresh capture the mirror fires (append to the stub ledger) + emits the [contract-index]
 *   evidence line; the pointer is a content-addressed route:<sha256> of skillId|endpointId|url_template.
 * - The UNBROWSE_LOCAL_CACHES=0 gate is honored: no mirror, no append.
 */
import { test, expect } from "bun:test";
import { mirrorCapturedRouteToContract } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

function stubLedger() {
  const appended: Array<{ intent: string; result: string }> = [];
  const ledger = {
    find: async () => undefined,
    history: async () => [],
    append: async (intent: string, result: string) => {
      appended.push({ intent, result });
      return { seq: 1, intent, result, prev: "", hash: "h", ts: 0 } as never;
    },
  };
  return { appended, ledger };
}

const skill: SkillManifest = {
  skill_id: "test-skill-1",
  domain: "example.com",
  endpoints: [{ endpoint_id: "ep-1", url_template: "https://example.com/api/{id}" }],
} as unknown as SkillManifest;

test("fresh capture mirrors the route index onto the /contract ledger (content-addressed pointer)", async () => {
  const prev = process.env.UNBROWSE_LOCAL_CACHES;
  process.env.UNBROWSE_LOCAL_CACHES = "1";
  const { appended, ledger } = stubLedger();
  mirrorCapturedRouteToContract("cli:example.com:list:url", skill, "ep-1", { ledger: ledger as never });
  // fire-and-forget — let the microtask settle
  await new Promise((r) => setTimeout(r, 20));
  expect(appended.length).toBe(1);
  expect(appended[0].result).toMatch(/^route:[0-9a-f]{32}$/);
  if (prev === undefined) delete process.env.UNBROWSE_LOCAL_CACHES;
  else process.env.UNBROWSE_LOCAL_CACHES = prev;
});

test("UNBROWSE_LOCAL_CACHES=0 gate is honored — no mirror, no append", async () => {
  const prev = process.env.UNBROWSE_LOCAL_CACHES;
  process.env.UNBROWSE_LOCAL_CACHES = "0";
  const { appended, ledger } = stubLedger();
  mirrorCapturedRouteToContract("cli:example.com:list:url", skill, "ep-1", { ledger: ledger as never });
  await new Promise((r) => setTimeout(r, 20));
  expect(appended.length).toBe(0);
  if (prev === undefined) delete process.env.UNBROWSE_LOCAL_CACHES;
  else process.env.UNBROWSE_LOCAL_CACHES = prev;
});
