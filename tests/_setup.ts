// Test setup — preloaded via bunfig.toml.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate the self-custody identity wallet to a throwaway directory so NO test
// can read, mint, or ROTATE the developer's real ~/.unbrowse/wallet.{json,enc}
// or the macOS login-keychain key. UNBROWSE_WALLET_DIR also makes the signer
// skip the keychain entirely (keychainEnabled() returns false), so the real key
// is untouchable from tests — concurrent `bun test` runs no longer churn the
// real identity. A test that needs its own wallet dir overrides this; the
// default just guarantees the real wallet is safe.
process.env.UNBROWSE_WALLET_DIR ??= mkdtempSync(join(tmpdir(), "unbrowse-test-wallet-"));
// Forces inline-mode for the disk-backed index queue so `bun test` never
// touches ~/.unbrowse/queue/ or spawns drain workers. Tests that want
// the disk path must explicitly clear this env var inside the test.
process.env.UNBROWSE_INLINE_INDEX ??= "1";
// Belt-and-suspenders: also opt out of the opportunistic startup sweep.
process.env.UNBROWSE_NO_SWEEP ??= "1";
// Insulate ranking unit tests from the developer's real ~/.unbrowse/traces
// ledger: the live ledger-energy signal (src/lib/ranking-core/signals/ledger-energy.ts)
// must not perturb deterministic structural-ranking fixtures. Tests that
// exercise the signal clear this env var and point UNBROWSE_TRACES at a temp dir.
process.env.UNBROWSE_LEDGER_ENERGY ??= "0";
