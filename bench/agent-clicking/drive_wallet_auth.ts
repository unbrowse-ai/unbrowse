/**
 * drive_wallet_auth.ts — witness that auth (cookies/headers/PII) is bound to the WALLET in the
 * stateless browser primitive: revealed only under the holding wallet, isolated per op.
 *
 *   bun bench/agent-clicking/drive_wallet_auth.ts http://127.0.0.1:PORT/authpage.html
 *
 * Seals a cookie to walletA, then runs the stateless op twice against authpage.html (which echoes
 * its cookie into the button label):
 *   - walletA (holder)  -> page MUST see SID:SECRET123, authApplied.cookies == 1
 *   - walletB (wrong)   -> page MUST see SID:NONE,       authApplied.cookies == 0 (fails closed,
 *                          and no leak from the holder's prior op — jar isolated)
 * Emits one JSON line: {ok, right_sees, right_applied, wrong_sees, wrong_applied}.
 */
import { statelessSnapshot } from "../../src/kuri/stateless-primitive.js";
import { AuthVault } from "../../src/values/auth-vault.js";

const url = process.argv[2];
if (!url) {
  process.stdout.write(JSON.stringify({ ok: false, error: "usage: <url>" }) + "\n");
  process.exit(2);
}
const origin = new URL(url).origin;
const ex = (s?: string) => (s || "").split("\n").find((l) => /SID:/.test(l))?.trim() || "<none>";

const out: Record<string, unknown> = { ok: false };
try {
  const vault = new AuthVault();
  const cookie = [{ name: "sid", value: "SECRET123", domain: "127.0.0.1", path: "/" }];
  await vault.collect("cookie", origin, JSON.stringify(cookie), "walletA-secret");

  const right = await statelessSnapshot({ url, auth: { walletSecret: "walletA-secret", vault } });
  const wrong = await statelessSnapshot({ url, auth: { walletSecret: "walletB-WRONG", vault } });

  const rightSees = ex(right.snapshot);
  const wrongSees = ex(wrong.snapshot);
  const rightApplied = right.authApplied?.cookies ?? 0;
  const wrongApplied = wrong.authApplied?.cookies ?? 0;

  // Load-bearing: holder authenticates, wrong wallet is fail-closed AND isolated (no leak).
  const ok =
    /SECRET123/.test(rightSees) && rightApplied === 1 &&
    /NONE/.test(wrongSees) && wrongApplied === 0;

  out.ok = ok;
  out.right_sees = rightSees;
  out.right_applied = rightApplied;
  out.wrong_sees = wrongSees;
  out.wrong_applied = wrongApplied;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(ok ? 0 : 1);
} catch (e) {
  out.error = e instanceof Error ? e.message.slice(0, 240) : String(e);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(1);
}
