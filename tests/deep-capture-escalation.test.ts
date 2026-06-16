import { describe, it, expect } from "bun:test";
import { escalateThinViaBrowser } from "../src/execution/index.js";

// #838 machine witness: the escalation COMPOSITION (browser render → direct-document markdown) is
// verified deterministically with an injected capture fn — no flaky ~20-80s live browser render.
// The live primitives are witnessed elsewhere (captureSession full-rendered aetna.com + 122 network
// events; buildBloombergDirectDocumentResult produced markdown in the HTML-holes work); this test
// witnesses that the gate composes them into a real answer / degrades honestly.

const realPage =
  "<html><head><title>Aetna Health Insurance Plans</title></head><body>" +
  "<p>Aetna offers medical, dental, and vision insurance plans, with coverage data on claims, " +
  "member benefits, and provider networks for individuals, families, and employers. </p>".repeat(70) +
  "</body></html>"; // > 5000-byte direct-document floor

describe("#838 escalateThinViaBrowser", () => {
  it("returns the rendered direct-document when the browser capture yields real html", async () => {
    const capFn = async () => ({ html: realPage }) as any;
    const r = await escalateThinViaBrowser(
      "https://aetna.com",
      "find insurance plans and coverage data",
      undefined,
      undefined,
      capFn,
    );
    expect(r).not.toBeNull();
    const blob = JSON.stringify(r).toLowerCase();
    expect(blob).toContain("aetna");
    expect(blob).toContain("markdown"); // the resolved VALUE is the page as markdown
  });

  it("returns null on a thin/empty render (caller keeps the honest extraction_too_thin error)", async () => {
    const capFn = async () => ({ html: "<html><body><div id=root></div></body></html>" }) as any;
    const r = await escalateThinViaBrowser("https://spa.example.com", "find the data", undefined, undefined, capFn);
    expect(r).toBeNull();
  });

  it("returns null when the browser capture throws (graceful degrade, no throw)", async () => {
    const capFn = async () => {
      throw new Error("kuri unavailable");
    };
    const r = await escalateThinViaBrowser("https://x.example.com", "find the data", undefined, undefined, capFn as any);
    expect(r).toBeNull();
  });
});
