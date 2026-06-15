// Witness: the durable energy ledger is EmergentDB-first and fail-closed, and durable rows fold into
// real ranking energy (not NEUTRAL). Proves nodes 0-3 of the plan. Run:
// bun bench/capability/test_energy_ledger_emergent_first.ts
import { tierSource, emergentFirstKV, type DurableKV } from "../../src/values/emergent-first-tier.ts";
import {
  energyLedgerOverKV, energyLedgerFromEnv, loadDurableLedgerIndex, ENERGY_LEDGER_KEY,
} from "../../src/values/energy-ledger.ts";
import { ledgerEnergy, LEDGER_NEUTRAL } from "../../src/lib/ranking-core/signals/ledger-energy.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;
const R2 = { R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_BUCKET: "c", R2_ACCOUNT_ID: "d" };

// ── NODE 0: the single ordering authority — EmergentDB FIRST before anything else ──
ok(tierSource({}) === "none", "ordering: nothing configured → none (caller uses fs)");
ok(tierSource(R2) === "r2+iq", "ordering: only R2 creds → r2+iq");
ok(tierSource({ EMERGENTDB_API_KEY: "k" }) === "emergentdb", "ordering: EDB key → emergentdb");
ok(tierSource({ EMERGENTDB_API_KEY: "k", ...R2 }) === "emergentdb",
   "ordering: EDB key + R2 BOTH present → emergentdb wins (emergent FIRST before anything else)");

// ── fail-closed: no durable creds → null adapter (caller keeps local fs, byte-identical to today) ──
ok(emergentFirstKV({}) === null, "fail-closed: no creds → null DurableKV");
ok(emergentFirstKV({ EMERGENTDB_API_KEY: "k" })?.source === "emergentdb", "configured: EDB DurableKV, source=emergentdb");

// ── NODES 1-3: durable rows over an injected KV fold into REAL energy ──
const mem = new Map<string, string>();
const kv: DurableKV = {
  source: "emergentdb",
  async get(k) { return mem.get(k) ?? null; },
  async set(k, v) { mem.set(k, v); return true; },
};
const led = energyLedgerOverKV(kv);
await led.append({ domain: "x.example", endpoint_id: "feed", source: "api", outcome: "success" });
await led.append({ domain: "x.example", endpoint_id: "feed", source: "api", outcome: "success" });
await led.append({ domain: "x.example", endpoint_id: "feed", source: "api", outcome: "failure" });

ok((await led.read()).length === 3, "append+read: 3 rows round-trip through the one KV value");
ok(mem.has(ENERGY_LEDGER_KEY), "append: rows persisted under the dedicated energy key (distinct from resolution rows)");

const idx = await loadDurableLedgerIndex(led);
const feed = ledgerEnergy(idx, "x.example", "feed", "api"); // 2/3 success, Laplace (2+1)/(3+2)=0.6
ok(near(feed, 0.6), `read-fold: durable rows → real energy 0.6 (NOT neutral) (got ${feed})`);
ok(feed > LEDGER_NEUTRAL, "read-fold: success history raises energy above neutral — durable signal is live");

// ── cap: the single value stays bounded (oldest compacted out on write) ──
const big = JSON.stringify(Array.from({ length: 5000 }, () => ({ domain: "d", endpoint_id: "e", source: "s", outcome: "success" })));
mem.set(ENERGY_LEDGER_KEY, big);
await led.append({ domain: "x.example", endpoint_id: "feed", source: "api", outcome: "success" });
ok((await led.read()).length === 5000, "cap: value bounded at MAX_ROWS after overflow append (compacts oldest)");

// ── energyLedgerFromEnv: fail-closed vs emergent-first by env ──
ok(energyLedgerFromEnv({}) === null, "fromEnv: no creds → null (fs/NEUTRAL path, unchanged)");
ok(energyLedgerFromEnv({ EMERGENTDB_API_KEY: "k" })?.source === "emergentdb", "fromEnv: EDB key → emergent-first durable ledger");

console.log(fails === 0 ? "\nENERGY-LEDGER EMERGENT-FIRST WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
