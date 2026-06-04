/**
 * Witness: the pointer-dependent KV cache. Entries are HIT until a pointer they depend on
 * CHANGES VALUE, then they go stale (recompute) while unrelated entries stay cached —
 * docker-layer-style invalidation, pointer-reactive.
 */
import { test, expect } from "bun:test";
import { PointerCache, pointerAddress } from "../src/values/pointer-cache.js";

test("changing a pointer's value invalidates only its dependents", async () => {
  const c = new PointerCache();
  await c.setPointer("user", { id: 1 });

  await c.set("profile", { name: "alice" }, { deps: ["user"] }); // depends on user
  await c.set("static", 42, { deps: [] }); // depends on nothing

  expect((await c.get("profile")).hit).toBe(true);
  expect((await c.get("static")).hit).toBe(true);

  // the pointer's VALUE changes → its address changes → dependents go stale
  await c.setPointer("user", { id: 2 });

  const p = await c.get("profile");
  expect(p.hit).toBe(false);
  expect(p.stale).toBe(true); // present, but a dependency changed → recompute
  expect((await c.get("static")).hit).toBe(true); // unrelated → still cached (fast)
  expect(c.recomputeCount).toBe(1);

  // recompute + re-cache against the new pointer → HIT again
  await c.set("profile", { name: "alice-v2" }, { deps: ["user"] });
  const p2 = await c.get("profile");
  expect(p2.hit).toBe(true);
  expect(p2.value).toEqual({ name: "alice-v2" });
});

test("setting a pointer to the SAME value does not invalidate (content-addressed)", async () => {
  const c = new PointerCache();
  await c.setPointer("cfg", { region: "us" });
  await c.set("derived", "x", { deps: ["cfg"] });
  expect((await c.get("derived")).hit).toBe(true);

  await c.setPointer("cfg", { region: "us" }); // identical value → identical address
  expect((await c.get("derived")).hit).toBe(true); // no spurious recompute
  expect(c.recomputeCount).toBe(0);
});

test("a dependency on an as-yet-unset pointer stales once that pointer appears", async () => {
  const c = new PointerCache();
  await c.set("waiting", "v", { deps: ["later"] }); // 'later' not set yet
  expect((await c.get("waiting")).hit).toBe(true);
  await c.setPointer("later", { ready: true }); // pointer appears → entry stales
  expect((await c.get("waiting")).stale).toBe(true);
});

test("pointerAddress is stable and content-addressed", async () => {
  expect(await pointerAddress({ a: 1 })).toBe(await pointerAddress({ a: 1 }));
  expect(await pointerAddress({ a: 1 })).not.toBe(await pointerAddress({ a: 2 }));
});
