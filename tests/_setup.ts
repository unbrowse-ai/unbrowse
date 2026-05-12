// Test setup — preloaded via bunfig.toml.
// Forces inline-mode for the disk-backed index queue so `bun test` never
// touches ~/.unbrowse/queue/ or spawns drain workers. Tests that want
// the disk path must explicitly clear this env var inside the test.
process.env.UNBROWSE_INLINE_INDEX ??= "1";
// Belt-and-suspenders: also opt out of the opportunistic startup sweep.
process.env.UNBROWSE_NO_SWEEP ??= "1";
