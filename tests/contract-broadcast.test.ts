/**
 * Witness for the Notion + Outline reflection tiers: FAIL-OPEN by contract. With no creds the
 * sinks return a surfaced note (never throw), so a bind/deploy is never blocked. The live publish
 * leg is opt-in (CONTRACT_BROADCAST_E2E=1 with real tokens present) and default-skipped.
 */
import { test, expect } from "bun:test";
import {
  reflectToNotion,
  reflectToOutline,
  broadcastContract,
  broadcastNotes,
  type BroadcastDoc,
} from "../src/values/contract-broadcast.js";

const LIVE = process.env.CONTRACT_BROADCAST_E2E === "1";
const DOC: BroadcastDoc = { id: "chain:test:0", title: "test chain", body: "# bound\npapers→code→cli→frontend" };

test.skipIf(LIVE)("not opted-in / unconfigured → each sink fails OPEN with a surfaced note, never throws", async () => {
  // Force the skip path deterministically regardless of the host machine's config: Notion is
  // opt-in (CONTRACT_BROADCAST_NOTION unset → skip), Outline needs a target collection id.
  const save = {
    CONTRACT_BROADCAST_NOTION: process.env.CONTRACT_BROADCAST_NOTION,
    OUTLINE_CHAIN_COLLECTION_ID: process.env.OUTLINE_CHAIN_COLLECTION_ID,
  };
  delete process.env.CONTRACT_BROADCAST_NOTION;
  delete process.env.OUTLINE_CHAIN_COLLECTION_ID;
  try {
    const out = await broadcastContract(DOC);
    expect(out.notion.ok).toBe(false);
    expect(out.outline.ok).toBe(false);
    const notes = broadcastNotes(out);
    expect(notes.length).toBe(2);
    expect(notes.join(" ")).toContain("notion:");
    expect(notes.join(" ")).toContain("outline:");
  } finally {
    for (const [k, v] of Object.entries(save)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test.skipIf(!LIVE)("live: a contract reflects onto Notion and Outline", async () => {
  const out = await broadcastContract({ ...DOC, title: `test chain ${Date.now()}` });
  // At least one human surface must land when E2E is requested (configs may cover one or both).
  expect(out.notion.ok || out.outline.ok, `notes: ${broadcastNotes(out).join("; ")}`).toBe(true);
});
