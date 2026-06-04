/**
 * layer-wallet-descent.test — the witness for wallet-hierarchy ∘ signed-descent:
 * each layer signs its OWN action with its OWN wallet, owned + routeed by the
 * layer above, rooted at the user wallet. Proves: every layer uses a distinct wallet
 * (not the root); the action is signed by THAT layer's wallet; the vertical ownership
 * route + horizontal chain verify from the root; tamper / wrong-root fail closed.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { descendByLayerWallet, verifyLayerWalletDescent } from "../src/values/layer-wallet-descent.js";
import { LAYERS } from "../src/values/signed-descent.js";

const OPS = { screen: "click", browser: "POST /x", cli: "execute", os: "connect", kernel: "sendmsg", packet: "TLS" };

describe("layer-wallet descent (vertical ownership ∘ signed descent)", () => {
  it("each layer signs with its OWN distinct wallet, not the root", () => {
    const { root, chain } = descendByLayerWallet("buy widget", OPS);
    expect(chain.length).toBe(LAYERS.length);
    const pubs = new Set(chain.map((r) => r.pubkey));
    expect(pubs.size).toBe(LAYERS.length);          // a distinct wallet per layer
    expect(pubs.has(root)).toBe(false);             // none of them IS the root
    expect(chain[0].parent).toBe(root);             // first layer owned by the root
    for (let i = 1; i < chain.length; i++) expect(chain[i].parent).toBe(chain[i - 1].pubkey);
  });

  it("the full descent verifies (ownership route + per-layer action sig + chain)", () => {
    const { root, chain } = descendByLayerWallet("buy widget", OPS);
    expect(verifyLayerWalletDescent(chain, root)).toBe(true);
  });

  it("tampering a layer's action breaks its own signature", () => {
    const { root, chain } = descendByLayerWallet("buy widget", OPS);
    chain[4].op = "exfiltrate"; // edit the kernel-layer action
    expect(verifyLayerWalletDescent(chain, root)).toBe(false);
  });

  it("splicing in a wallet the parent never routeed fails", () => {
    const { root, chain } = descendByLayerWallet("buy widget", OPS);
    const other = descendByLayerWallet("other", OPS);
    chain[2] = other.chain[2]; // a layer wallet from a different root
    expect(verifyLayerWalletDescent(chain, root)).toBe(false);
  });

  it("a wrong root cannot verify", () => {
    const { chain } = descendByLayerWallet("buy widget", OPS);
    expect(verifyLayerWalletDescent(chain, Buffer.from(randomBytes(32)).toString("hex"))).toBe(false);
  });
});
