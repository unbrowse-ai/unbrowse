/**
 * A stated timeout is a ceiling, not a suggestion.
 *
 * Found by a flaky gate witness, not by reading: `anti-bot-rescue.test.ts` failed
 * 1 run in 8 with "this test timed out after 5000ms" on a test that had asked for
 * `timeoutMs: 2_000`. The cause was a real defect, not a slow machine:
 *
 *   timeoutMs: Math.max(opts.timeoutMs ?? 0, 120_000)
 *
 * `Math.max` against a 120s floor makes an explicit 2s budget into 120s — sixty
 * times what the caller asked for. And `rescueBlockedPage` runs the free rungs
 * and then the paid rungs in sequence, handing the SAME budget to each, so the
 * total could exceed the stated deadline twice over.
 *
 * That is the unbounded-recovery failure class: an agent that sets a deadline so
 * it can fall back cannot fall back, because the call it is waiting on ignored
 * the deadline. The 120s default is still right when no budget is given — paid
 * captcha solvers really do need it.
 *
 * These are wall-clock assertions with generous slack: they are checking that a
 * budget is respected AT ALL (2s vs 120s), not micro-timing.
 */
import { describe, expect, test } from "bun:test";
import { rescueBlockedPage, rescueBlockedPageFree, paidRungBudgetMs } from "../src/execution/anti-bot-rescue.js";

// Reserved TLD (RFC 2606) — never resolves, so every rung must fail and the only
// thing under test is how long we are willing to wait for that.
const DEAD = "https://example.invalid/";

const PAID_ENV = {
  UNBROWSE_ANTI_BOT_RESCUE: "1",
  UNBROWSE_DIRECT_EGRESS: "1",
  // Present so the paid rungs are ATTEMPTED — with no key configured they are
  // skipped entirely and the budget bug cannot show itself.
  UNBROWSE_CAPZY_KEY: "test-key-not-used",
  UNBROWSE_WALLET_ADAPTER: "none",
};

describe("rescue honours the caller's deadline", () => {
  test("a 2s budget does not become a 120s walk", async () => {
    const t0 = Date.now();
    const out = await rescueBlockedPage({
      url: DEAD,
      timeoutMs: 2_000,
      html: "<html>challenge</html>", // trips the Capzy rung so paid is reached
      env: PAID_ENV,
    });
    const elapsed = Date.now() - t0;
    // Pre-fix this could run to the 120s floor. 15s is far below that and far
    // above any honest 2s walk, so it fails loudly on the old behaviour without
    // being flaky on a loaded machine.
    expect(elapsed).toBeLessThan(15_000);
    expect(out.html).toBeNull();
  }, 30_000);

  test("the free half alone also respects its budget", async () => {
    const t0 = Date.now();
    const out = await rescueBlockedPageFree({ url: DEAD, timeoutMs: 1_500, env: PAID_ENV });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(out.html).toBeNull();
  }, 30_000);

  test("the budget rule itself: default kept, explicit budget never raised", () => {
    // Asserted on the pure function, not on source text. A first attempt DID
    // grep the source and failed — the doc comment explaining the fix quotes the
    // old `Math.max(...)` line, so `not.toContain` matched the comment. A test
    // that reads code as a string breaks on its own documentation.
    //
    // Guards BOTH directions. Clamping everything small would break real captcha
    // solving, which is why the 120s floor existed at all.
    expect(paidRungBudgetMs({ timeoutMs: undefined })).toBe(120_000); // default kept
    expect(paidRungBudgetMs({ timeoutMs: 2_000 })).toBe(2_000);       // never raised
    expect(paidRungBudgetMs({ timeoutMs: 300_000 })).toBe(300_000);   // never lowered either
    expect(paidRungBudgetMs({ timeoutMs: 0 })).toBe(0);               // 0 means 0, not 120s
  });
});
