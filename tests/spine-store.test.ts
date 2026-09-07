// AC-P4: the judged cross-layer spine persists to local disk + replays by (domain,target);
// re-judge fires only on a MISS (never stored) or STALE (fingerprint changed). Judge once,
// persist, replay.
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistSpine, loadSpine } from "../src/lib/graph-core/spine-store.js";
import { buildDescentSpine, verifyDescentSpine } from "../src/lib/graph-core/descent-spine.js";
import { getWalletPubkey } from "../src/values/signer.js";
import type { HoleDep } from "../src/capture/hole-template.js";

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const base = mkdtempSync(join(tmpdir(), "spine-store-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const deps: Partial<Record<string, HoleDep>> = {
  browser: { producer: "click_login", binding: "session", layer: "browser" },
  cli: { producer: "api_feed", binding: "token", layer: "cli" },
};

describe("AC-P4 — spine persist + replay", () => {
  it("persists then replays the same spine (mkdir -p into a nested store dir)", async () => {
    const dir = join(base, "nested", "store"); // does not exist yet
    const spine = await buildDescentSpine("read feed", deps);
    persistSpine(dir, "acme.dev", "feed", spine, "fp-1");
    const loaded = loadSpine(dir, "acme.dev", "feed", "fp-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.chain.length).toBe(spine.chain.length);
    // the replayed spine still verifies under the wallet root (seal survives the disk round-trip)
    const root = bytesToHex(await getWalletPubkey());
    expect(verifyDescentSpine(loaded!, root)).toBe(true);
  });

  it("returns null on a MISS (never stored) → caller re-judges", () => {
    const dir = join(base, "miss");
    expect(loadSpine(dir, "acme.dev", "never", "fp-1")).toBeNull();
  });

  it("returns null on STALE (fingerprint changed) → caller re-judges", async () => {
    const dir = join(base, "stale");
    const spine = await buildDescentSpine("read feed", deps);
    persistSpine(dir, "acme.dev", "feed", spine, "fp-1");
    expect(loadSpine(dir, "acme.dev", "feed", "fp-2")).toBeNull();   // changed inputs
    expect(loadSpine(dir, "acme.dev", "feed", "fp-1")).not.toBeNull(); // unchanged → replay
  });

  it("keys are isolated by (domain,target)", async () => {
    const dir = join(base, "keys");
    const spine = await buildDescentSpine("read feed", deps);
    persistSpine(dir, "acme.dev", "feed", spine, "fp-1");
    expect(loadSpine(dir, "other.dev", "feed", "fp-1")).toBeNull();
    expect(loadSpine(dir, "acme.dev", "profile", "fp-1")).toBeNull();
  });
});
