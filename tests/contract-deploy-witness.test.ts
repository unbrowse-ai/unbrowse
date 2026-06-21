/**
 * Live witness for the NEW /contract-deploy: a deploy is itself a /contract on the stack.
 *
 * Proves recordDeploy persists a deploy event LIVE across IQ + emergent KV + emergent RAG,
 * and that it is recallable by id and findable by meaning (semantic deploy search). Runs the
 * live assertions only under CONTRACT_EVERYTHING_E2E=1 (the gate sets it + assembles creds);
 * without the flag the suite stays green (skipped) so default `bun test` is unaffected.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  recordDeploy,
  recallDeploy,
  searchDeploys,
  deployContractId,
  type DeployManifest,
} from "../src/values/contract-deploy.js";
import { recallContract } from "../src/values/contract-everything.js";

const LIVE = process.env.CONTRACT_EVERYTHING_E2E === "1";

test.skipIf(!LIVE)(
  "a deploy is recorded as a /contract on the full stack: IQ + emergent KV + emergent RAG",
  async () => {
    const tag = randomUUID().slice(0, 8);
    const m: DeployManifest = {
      kind: "server",
      release_version: `0.0.0-witness-${tag}`,
      git_sha: `${tag}deadbeef0000`,
      artifact_sha: `art${tag}`,
      target: "cloudflare-worker-witness",
      live_url: "https://beta-api.unbrowse.ai",
      witness: "contract-deploy-gate.sh",
      ts: Date.parse("2026-06-22T00:00:00Z") + Number(`0x${tag.slice(0, 6)}`),
    };

    const rec = await recordDeploy(m);
    expect(rec.id).toBe(deployContractId(m));
    // Every stack tier must land — the deploy is on-chain + cached + RAG-indexed.
    expect(rec.persisted.iq, `deploy IQ tier (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.kv, `deploy emergent KV tier (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);
    expect(rec.persisted.rag, `deploy emergent RAG tier (notes: ${rec.persisted.notes.join("; ")})`).toBe(true);

    // Recall the deploy manifest by id (emergent KV → IQ behind).
    const back = await recallDeploy(rec.id);
    expect(back, "recallDeploy must return the manifest").toEqual(m);

    // Semantic deploy search finds this deploy by meaning.
    const hits = await searchDeploys(`server deploy ${m.release_version} ${m.target}`, 10);
    expect(hits.some((h) => h.id === rec.id), `deploy search must surface ${rec.id} (got ${hits.map((h) => h.id).join(",")})`).toBe(true);

    // It is a /contract on the SAME stack the resolution boundary uses (durable readback).
    const raw = await recallContract(rec.id, { namespace: "ubz-deploys" });
    expect(raw, "the deploy contract must be recallable from the stack").toBeTruthy();
  },
  120_000,
);

test("placeholder so the file is never an empty suite when CONTRACT_EVERYTHING_E2E is unset", () => {
  expect(true).toBe(true);
});
