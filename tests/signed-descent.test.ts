/**
 * signed-descent.test — the witness for signed descent through every layer
 * (src/values/signed-descent.ts): one wallet root signs an action record at every
 * layer (screen→browser→cli→os→kernel→packet), hash-chained. Proves: a real descent
 * verifies; tamper at any layer fails; a wrong root fails; the chain links to the
 * one identity; an empty chain fails closed.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { descend, verifyDescent, LAYERS } from "../src/values/signed-descent.js";

const OPS = {
  screen: "click@(412,318)",
  browser: "POST https://api.example.com/orders",
  cli: "unbrowse execute orders.create",
  os: "connect(fd=7, 93.184.216.34:443)",
  kernel: "sendmsg(sk, iov, MSG_DONTWAIT)",
  packet: "TLS1.3 JA4=t13d… 1420B",
};

describe("signed layer descent", () => {
  it("a full descent verifies against the wallet root", async () => {
    const chain = await descend("buy one widget", OPS);
    expect(chain.length).toBe(LAYERS.length);
    expect(chain.map((r) => r.layer)).toEqual([...LAYERS]);
    const root = chain[0].root;
    expect(verifyDescent(chain, root)).toBe(true);
  });

  it("every layer descends from the SAME one root", async () => {
    const chain = await descend("buy one widget", OPS);
    const roots = new Set(chain.map((r) => r.root));
    expect(roots.size).toBe(1); // one identity, not a credential per layer
  });

  it("tampering ANY layer's op breaks the descent", async () => {
    const chain = await descend("buy one widget", OPS);
    const root = chain[0].root;
    chain[3].op = "connect(fd=7, 6.6.6.6:443)"; // swap the OS-layer destination
    expect(verifyDescent(chain, root)).toBe(false);
  });

  it("re-ordering / re-chaining a layer breaks the chain", async () => {
    const chain = await descend("buy one widget", OPS);
    const root = chain[0].root;
    [chain[2], chain[3]] = [chain[3], chain[2]]; // swap two records
    expect(verifyDescent(chain, root)).toBe(false);
  });

  it("a different wallet root cannot verify the descent", async () => {
    const chain = await descend("buy one widget", OPS);
    const strangerRoot = Buffer.from(randomBytes(32)).toString("hex");
    expect(verifyDescent(chain, strangerRoot)).toBe(false);
  });

  it("an empty chain fails closed", () => {
    expect(verifyDescent([], "00".repeat(32))).toBe(false);
  });
});
