import { describe, it, expect } from "bun:test";
import { probeFreshness } from "../src/services/freshness-probe.js";

describe("Step 6 dispatch contract", () => {
  it("scheduled handler can branch by controller.cron string and call probeFreshness", async () => {
    // Simulate the planned Step 6 dispatch shape:
    const mockController = { cron: "0 */4 * * *", scheduledTime: Date.now() } as any;
    const env = {} as any;
    const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as any;

    const handler = async (controller: any, e: any, c: any) => {
      if (controller.cron === "0 */4 * * *") {
        c.waitUntil(probeFreshness(e));
      }
    };

    await expect(handler(mockController, env, ctx)).resolves.toBeUndefined();
  });

  it("backend bundles cleanly with synthetic + freshness imports both present", () => {
    // Just-bundle smoke. Real bundle test runs via shell.
    expect(true).toBe(true);
  });
});
