// Witness: the ranking energy ledger is store-agnostic — an ephemeral worker (no ~/.unbrowse/traces,
// no fs) can fold rows from the durable shared tier (IQLabs/R2) and serve real "what-worked" energy
// through the SAME sync ranker. Proves the fs read and the energy fold are decoupled, and the
// injection seam works. Run: bun bench/capability/test_ledger_tier_inject.ts
import {
  foldLedgerRows, ledgerEnergy, ledgerEnergyCached, setLedgerIndex, __resetLedgerCache,
  LEDGER_NEUTRAL, type LedgerRow,
} from "../../src/lib/ranking-core/signals/ledger-energy.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) < e;

// Rows as they'd arrive from the durable tier (IQLabs signed rows / R2), NOT from fs.
const rows: LedgerRow[] = [
  { domain: "x.example", endpoint_id: "feed", source: "api", outcome: "success" },
  { domain: "x.example", endpoint_id: "feed", source: "api", outcome: "success" },
  { domain: "x.example", endpoint_id: "feed", source: "api", outcome: "failure" },
  { domain: "x.example", endpoint_id: "login", source: "api", outcome: "failure" },
  { domain: "x.example", endpoint_id: "login", source: "api", outcome: "failure" },
  { outcome: "bogus" }, // ignored — not success/failure
];

// 1. foldLedgerRows builds the index with NO fs access at all (the worker builder).
const idx = foldLedgerRows(rows);
const feed = ledgerEnergy(idx, "x.example", "feed", "api");   // 2 succ / 3 total, Laplace (2+1)/(3+2)=0.6
const login = ledgerEnergy(idx, "x.example", "login", "api"); // 0 succ / 2 total → (0+1)/(2+2)=0.25
ok(near(feed, 0.6), `fold (no fs): feed energy = 0.6 from durable rows (got ${feed})`);
ok(near(login, 0.25), `fold (no fs): login energy = 0.25 (failures drag it below neutral) (got ${login})`);
ok(feed > LEDGER_NEUTRAL && login < LEDGER_NEUTRAL, "fold (no fs): success raises, failure lowers — real signal, not neutral");

// 2. INJECTION SEAM: install the durable index; the SYNC ranker serves it with no fs read.
__resetLedgerCache();
setLedgerIndex(idx);
const cachedFeed = ledgerEnergyCached("x.example", "feed", "api");
ok(near(cachedFeed, 0.6), `seam: sync ledgerEnergyCached serves the INJECTED durable index (got ${cachedFeed}) — worker has live energy w/o fs`);

// 3. an unseen route is honest-neutral even with the durable index installed.
ok(near(ledgerEnergyCached("y.other", "search", "api"), LEDGER_NEUTRAL), "seam: unseen route stays NEUTRAL (no opinion without evidence)");

// 4. clearing the seam falls back to the fs loader (which is empty here → neutral, the worker-cold default).
__resetLedgerCache();
const afterClear = ledgerEnergyCached("x.example", "feed", "api");
ok(near(afterClear, LEDGER_NEUTRAL), `seam cleared: falls back to fs loader → NEUTRAL here (got ${afterClear}) — proves the injected value came from the tier, not fs`);

console.log(fails === 0 ? "\nLEDGER TIER-INJECT WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
