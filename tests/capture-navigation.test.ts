import { describe, expect, it } from "bun:test";
import { navigatePageForCapture } from "../src/capture/index.js";

describe("capture navigation", () => {
  it("uses domcontentloaded with a bounded timeout", async () => {
    const calls: Array<{ url: string; options: { waitUntil: "domcontentloaded"; timeout: number } }> = [];
    await navigatePageForCapture(
      {
        async goto(url, options) {
          calls.push({ url, options });
        },
      },
      "https://finance.yahoo.com/quote/AAPL",
    );

    expect(calls).toEqual([
      {
        url: "https://finance.yahoo.com/quote/AAPL",
        options: { waitUntil: "domcontentloaded", timeout: 20000 },
      },
    ]);
  });
});
