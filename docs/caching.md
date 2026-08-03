# Pointer-reactive caching & the wallet auth vault

Unbrowse caches aggressively for speed, but a cache is only useful if it's also *correct*
when the world changes. The pointer-reactive cache keeps both: O(1) reads, and automatic
invalidation the instant a dependency changes.

## Pointer-dependent caching (docker-layer style, but reactive)

A **pointer** holds a value; its content address (`sha256:…`) is its identity. A cache
entry pins the addresses of the pointers it was built against. A read is a HIT only if
every dependency's *current* address still equals the pinned one:

- same dependency value → same address → **HIT** (fast — no recompute);
- a dependency's value **changes** → its address changes → the entry is **stale** → it
  recomputes; unrelated entries stay cached.

This is exactly how a Docker layer is valid only while its parent layer hash is unchanged —
but here it's reactive to live values, not a one-shot build.

```ts
import { PointerCache } from "unbrowse/values/pointer-cache";

const cache = new PointerCache();
await cache.setPointer("session", { sid: "a" });
await cache.set("cart", cartData, { deps: ["session"] });

await cache.get("cart");                 // { hit: true }
await cache.setPointer("session", { sid: "b" }); // a dependency changed
await cache.get("cart");                 // { hit: false, stale: true } → recompute
```

`recomputeCount` reports how many reads missed because a dependency had changed — the
cascade is observable, not silent.

## Wallet-sealed or public, per auth

Each entry is **public** (stored in the clear) or **wallet-sealed** (only the holder's
wallet reveals it), chosen by whether auth is required:

```ts
await cache.set("public-price", 9.99, { auth: false });            // anyone reads
await cache.set("private-token", tok, { auth: true, walletSecret }); // sealed to the wallet
await cache.get("private-token");            // { hit: false, sealed: true }  (locked)
await cache.get("private-token", walletSecret); // { hit: true, value: tok }
```

A sealed entry still respects pointer-dependency invalidation: if a dependency changes, it
recomputes even with the right wallet.

## The wallet auth vault

The wallet collects **all auth & identity material** — passwords, usernames, tokens,
cookies, headers, API keys, OAuth secrets — each sealed to the holder's private key.
Nothing is stored in the clear; only the holder reveals; a wrong wallet fails closed.

```ts
import { AuthVault } from "unbrowse/values/auth-vault";

const vault = new AuthVault();
await vault.collect("password", "github.com", "hunter2", walletSecret);
await vault.collect("token", "api.stripe.com", "sk_live_…", walletSecret);

await vault.reveal("password", "github.com", walletSecret); // "hunter2" (holder only)
await vault.reveal("password", "github.com", wrongWallet);  // undefined (fails closed)
vault.kinds(); // ["password", "token", …] — kinds collected, no values
```

Every credential the agent picks up is bound to one identity — the wallet's private key —
so auth travels as a sealed pointer, never a plaintext secret on the wire.
