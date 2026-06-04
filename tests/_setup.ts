// Test setup — preloaded via bunfig.toml.
// Forces inline-mode for the disk-backed index queue so `bun test` never
// touches ~/.unbrowse/queue/ or spawns drain workers. Tests that want
// the disk path must explicitly clear this env var inside the test.
process.env.UNBROWSE_INLINE_INDEX ??= "1";
// Belt-and-suspenders: also opt out of the opportunistic startup sweep.
process.env.UNBROWSE_NO_SWEEP ??= "1";
// Insulate ranking unit tests from the developer's real ~/.unbrowse/traces
// ledger: the live ledger-energy signal (src/ranking/signals/ledger-energy.ts)
// must not perturb deterministic structural-ranking fixtures. Tests that
// exercise the signal clear this env var and point UNBROWSE_TRACES at a temp dir.
process.env.UNBROWSE_LEDGER_ENERGY ??= "0";
