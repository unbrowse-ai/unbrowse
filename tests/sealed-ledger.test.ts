/**
 * sealed-ledger.test — the witness for the sealed, signed, hash-chained ledger
 * (src/values/sealed-ledger.ts): value sealed to the wallet (only the holder
 * reveals), the log carrying only a signed, ordered, Merkle-rooted commitment to
 * its hash. Proves: the chain verifies + signs; tampering any row breaks it; the
 * value is recoverable only by the wallet and never appears in the log; the Merkle
 * root commits to the whole log and moves on append.
 */
import { describe, expect, it } from "bun:test";
import { SealedLedger } from "../src/values/sealed-ledger.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("sealed signed ledger", () => {
  it("appends seal+commit rows that verify as a signed hash chain", async () => {
    const led = new SealedLedger();
    await led.append(enc("token=A"), 1);
    await led.append(enc("token=B"), 2);
    await led.append(enc("token=C"), 3);
    expect(led.rows().length).toBe(3);
    expect(led.rows().map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(led.verifyChain()).toBe(true);
  });

  it("the value is sealed off-log — never in plaintext, revealed only by the wallet", async () => {
    const led = new SealedLedger();
    const e = await led.append(enc("session=sk_live_LEDGER_SECRET"), 10);
    expect(JSON.stringify(led.rows())).not.toContain("LEDGER_SECRET"); // log holds only the hash
    expect(dec(led.reveal(e.valueHash))).toBe("session=sk_live_LEDGER_SECRET"); // holder opens
  });

  it("tampering any past row breaks every row after it", async () => {
    const led = new SealedLedger();
    await led.append(enc("a"), 1);
    await led.append(enc("b"), 2);
    expect(led.verifyChain()).toBe(true);
    (led.rows()[0] as { ts: number }).ts = 999; // edit a past row's signed field
    expect(led.verifyChain()).toBe(false);
  });

  it("the Merkle root commits to the whole log and changes on append", async () => {
    const led = new SealedLedger();
    await led.append(enc("x"), 1);
    const r1 = led.root();
    expect(r1).toMatch(/^[0-9a-f]{64}$/);
    await led.append(enc("y"), 2);
    expect(led.root()).not.toBe(r1); // a new commitment after the new row
  });

  it("an empty ledger verifies and roots to sha256(\"\")", () => {
    const led = new SealedLedger();
    expect(led.verifyChain()).toBe(true);
    expect(led.root()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
