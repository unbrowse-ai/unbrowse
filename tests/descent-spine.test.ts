// AC-P2: the cross-layer dep chain is routed into a single SIGNED descent over all six
// layers (screen→browser→cli→os→kernel→packet) under ONE wallet root. Captured layers
// carry real hole-dep edges; os/kernel/packet land as TYPED STUBS (present + marked,
// never silent gaps). Tamper any layer → fails closed.
import { describe, it, expect } from "bun:test";
import {
  buildDescentSpine,
  verifyDescentSpine,
  layerOpsFromDeps,
} from "../src/lib/graph-core/descent-spine.js";
import { verifyDescent, LAYERS } from "../src/values/signed-descent.js";
import { getWalletPubkey } from "../src/values/signer.js";
import type { HoleDep } from "../src/capture/hole-template.js";

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

// captured layers carry real edges; os/kernel/packet omitted → stubs.
const deps: Partial<Record<(typeof LAYERS)[number], HoleDep>> = {
  browser: { producer: "click_login", binding: "session", layer: "browser" },
  cli: { producer: "api_feed", binding: "token", layer: "cli" },
};

describe("AC-P2 — cross-layer descent spine", () => {
  it("layerOpsFromDeps yields all six layers; real where mapped, stub elsewhere", () => {
    const ops = layerOpsFromDeps(deps);
    expect(ops.map((o) => o.layer)).toEqual([...LAYERS]);
    expect(ops.find((o) => o.layer === "browser")).toEqual({ layer: "browser", op: "click_login:session", stub: false });
    expect(ops.find((o) => o.layer === "cli")).toEqual({ layer: "cli", op: "api_feed:token", stub: false });
    for (const layer of ["screen", "os", "kernel", "packet"] as const) {
      expect(ops.find((o) => o.layer === layer)).toEqual({ layer, op: `stub:${layer}`, stub: true });
    }
  });

  it("builds a spine signed under one wallet root and verifies", async () => {
    const spine = await buildDescentSpine("read my feed", deps);
    const root = bytesToHex(await getWalletPubkey());
    expect(spine.chain.length).toBe(LAYERS.length); // all six layers present
    expect(spine.chain.every((r) => r.root === root)).toBe(true); // ONE root
    expect(verifyDescent(spine.chain, root)).toBe(true);
    expect(verifyDescentSpine(spine, root)).toBe(true);
  });

  it("stubs are present + marked, never dropped (no silent gap)", async () => {
    const spine = await buildDescentSpine("read my feed", deps);
    const stubs = spine.layers.filter((l) => l.stub).map((l) => l.layer);
    expect(stubs.sort()).toEqual(["kernel", "os", "packet", "screen"]);
    expect(spine.layers.every((l) => l.op.length > 0)).toBe(true);
  });

  it("fails closed when a layer is tampered", async () => {
    const spine = await buildDescentSpine("read my feed", deps);
    const root = bytesToHex(await getWalletPubkey());
    const tampered = { ...spine, chain: spine.chain.map((r, i) => (i === 2 ? { ...r, op: "evil" } : r)) };
    expect(verifyDescentSpine(tampered, root)).toBe(false);
  });

  it("fails closed when a stub is unmarked (a gap masquerading as real)", async () => {
    const spine = await buildDescentSpine("read my feed", deps);
    const root = bytesToHex(await getWalletPubkey());
    // flip a stub's mark without changing its stub: op → spine self-consistency check trips
    const lying = { ...spine, layers: spine.layers.map((l) => (l.layer === "packet" ? { ...l, stub: false } : l)) };
    expect(verifyDescentSpine(lying, root)).toBe(false);
  });
});
