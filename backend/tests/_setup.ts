// Backend test setup — preloaded via backend/bunfig.toml.
// Mirrors root tests/_setup.ts. Bun does not honor relative `..`
// paths in bunfig preload, so we keep a local copy here.
process.env.UNBROWSE_INLINE_INDEX ??= "1";
process.env.UNBROWSE_NO_SWEEP ??= "1";
// Mirror root: isolate the self-custody wallet so no test touches the real
// ~/.unbrowse/wallet.* or the macOS keychain (also disables the keychain path
// in the signer). Future-proof — backend doesn't import the signer today.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.UNBROWSE_WALLET_DIR ??= mkdtempSync(join(tmpdir(), "unbrowse-test-wallet-"));
