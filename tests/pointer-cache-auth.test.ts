/**
 * Witness: cache entries are wallet-SEALED when auth is required (only the holder reveals)
 * and PUBLIC otherwise — and sealing composes with pointer-dependency invalidation.
 */
import { test, expect } from "bun:test";
import { PointerCache } from "../src/values/pointer-cache.js";

const WALLET = "wallet-secret-AAAA";
const WRONG = "wallet-secret-BBBB";

test("a public entry is open to anyone", async () => {
  const c = new PointerCache();
  await c.set("public-route", { price: 9.99 }, { auth: false });
  const r = await c.get("public-route");
  expect(r.hit).toBe(true);
  expect(r.value).toEqual({ price: 9.99 });
});

test("an auth-required entry is sealed: only the holder's wallet reveals it", async () => {
  const c = new PointerCache();
  await c.set("private-route", { token: "secret-xyz" }, { auth: true, walletSecret: WALLET });

  // present but locked without the wallet
  const locked = await c.get("private-route");
  expect(locked.hit).toBe(false);
  expect(locked.sealed).toBe(true);

  // wrong wallet → fails closed
  const wrong = await c.get("private-route", WRONG);
  expect(wrong.hit).toBe(false);
  expect(wrong.sealed).toBe(true);

  // the holder reveals it
  const open = await c.get("private-route", WALLET);
  expect(open.hit).toBe(true);
  expect(open.value).toEqual({ token: "secret-xyz" });
});

test("sealing an entry requires a wallet secret", async () => {
  const c = new PointerCache();
  await expect(c.set("x", "v", { auth: true })).rejects.toThrow(/walletSecret/);
});

test("a sealed entry still respects pointer-dependency invalidation", async () => {
  const c = new PointerCache();
  await c.setPointer("session", { sid: "a" });
  await c.set("sealed-dep", { tok: "t1" }, { auth: true, walletSecret: WALLET, deps: ["session"] });
  expect((await c.get("sealed-dep", WALLET)).hit).toBe(true);

  await c.setPointer("session", { sid: "b" }); // dependency changed
  const stale = await c.get("sealed-dep", WALLET);
  expect(stale.hit).toBe(false);
  expect(stale.stale).toBe(true); // recompute even with the right wallet
});
