// Cycle-3 bench-gate (20260521T010031Z) regression: 4 probes returned
// page-metadata-only envelopes (151B / 181B / 21B / 55B) as platform
// "success" because assessIntentResult returned `skip` for unclassified
// shapes like {title:"Instagram"}. Live artifacts:
//   - 018 openlibrary.org/works/OL45804W -> [{title:"Alfaguara"},
//       {title:"Spanish"}] (151B, 2 chips, "get openlibrary work")
//   - 019 openlibrary.org/works/OL27448W -> [{title:"Metis Yayıncılık"},
//       {title:"Turkish"}] (181B, "get openlibrary work")
//   - 025 instagram.com/reels -> {title:"Instagram"} (21B,
//       "get instagram reels feed")
//   - 029 beatsaver.com/?q=camellia -> {title:"BeatSaver.com",
//       url:"https://beatsaver.com"} (55B, "search beatsaver maps")
//
// Fix: platform-faithful tiny-extraction gate in src/execution/index.ts
// using the looksLikeTinyContentReadResult helper from src/extraction.
// Real-runtime: tests call the exported helper directly — no mocks,
// no fixtures — and assert the structural verdict on live bytes.

import { describe, expect, test } from "bun:test";
import { looksLikeTinyContentReadResult } from "../src/extraction/index.js";

describe("tiny-extraction fallthrough gate (cycle-3 reproducer)", () => {
  test("openlibrary 019 cycle-3 live byte-for-byte (181B chip array) trips gate", () => {
    // Live shape from .bench-gate/20260521T010031Z/019/execute.response.raw
    const data = [
      { link: "/publishers/Metis_Yayıncılık", url: "/publishers/Metis_Yayıncılık", title: "Metis Yayıncılık" },
      { link: "/languages/tur", url: "/languages/tur", title: "Turkish" },
    ];
    const verdict = looksLikeTinyContentReadResult(data, "get openlibrary work");
    expect(verdict.tiny).toBe(true);
    expect(verdict.reason).toMatch(/tiny_extraction/);
    expect(verdict.bytes).toBeLessThan(300);
  });

  test("openlibrary 018 cycle-3 live byte-for-byte (151B chip array): tiny verdict, diagnostic populated", () => {
    const data = [
      { link: "/publishers/Alfaguara", url: "/publishers/Alfaguara", title: "Alfaguara" },
      { link: "/languages/spa", url: "/languages/spa", title: "Spanish" },
    ];
    const verdict = looksLikeTinyContentReadResult(data, "get openlibrary work");
    expect(verdict.tiny).toBe(true);
    expect(verdict.bytes).toBeLessThan(200);
    expect(verdict.stringLeafChars).toBeLessThan(120);
  });

  test("instagram-shaped reproducer: 21B {title:'Instagram'} trips gate for content-read intent", () => {
    const data = { title: "Instagram" };
    const verdict = looksLikeTinyContentReadResult(data, "get instagram reels feed");
    expect(verdict.tiny).toBe(true);
    expect(verdict.bytes).toBe(21);
  });

  test("beatsaver-shaped reproducer: 55B {title, url} trips gate for search intent", () => {
    const data = { title: "BeatSaver.com", url: "https://beatsaver.com" };
    const verdict = looksLikeTinyContentReadResult(data, "search beatsaver maps");
    expect(verdict.tiny).toBe(true);
    expect(verdict.bytes).toBe(55);
  });

  test("falsifier: legitimate tiny status-check {result:'ok', id:42} is NOT trapped (non-content-read intent)", () => {
    const data = { result: "ok", id: 42 };
    const verdict = looksLikeTinyContentReadResult(data, "check upload status");
    expect(verdict.tiny).toBe(false);
  });

  test("falsifier: single card with real description (>=40 chars) survives via content-field escape", () => {
    // Total bytes well under 300 but a real description carries meaning -
    // the content-field escape hatch protects sparse-but-rich cards.
    const data = {
      title: "Title",
      url: "https://x/y",
      description: "Real meaningful description text long enough to count",
    };
    const verdict = looksLikeTinyContentReadResult(data, "search articles");
    expect(verdict.tiny).toBe(false);
  });

  test("falsifier: 250B+ JSON with one card carrying real content survives the gate", () => {
    const data = {
      title: "Real Article Title Here",
      url: "https://example.com/articles/real-content-123",
      description: "A meaningful article description that contains real content - enough scalar text to demonstrate the page actually rendered useful data for the user.",
    };
    const verdict = looksLikeTinyContentReadResult(data, "search articles");
    expect(verdict.tiny).toBe(false);
    expect(verdict.stringLeafChars).toBeGreaterThanOrEqual(120);
  });

  test("intent unspecified -> gate is inert (no false positives without intent signal)", () => {
    const data = { title: "Instagram" };
    const verdict = looksLikeTinyContentReadResult(data, undefined);
    expect(verdict.tiny).toBe(false);
  });

  test("null data -> gate is inert (defensive)", () => {
    const verdict = looksLikeTinyContentReadResult(null, "search items");
    expect(verdict.tiny).toBe(false);
  });

  test("falsifier: large payload (>=300B) is NOT a tiny extraction regardless of shape", () => {
    const data = {
      title: "A".repeat(400),
    };
    const verdict = looksLikeTinyContentReadResult(data, "search articles");
    expect(verdict.tiny).toBe(false);
    expect(verdict.bytes).toBeGreaterThanOrEqual(300);
  });
});
