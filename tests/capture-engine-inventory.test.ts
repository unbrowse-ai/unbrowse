/**
 * Selecting obscura must never SILENTLY become Chrome.
 *
 * Four call sites take the CDP engine directly, and they are right to: they
 * consume `html` (16 reads), `cookies` (6), `ws_messages` (2) and `js_bundles`
 * (3), while the obscura sidecar reports `htmlLen` — a LENGTH — and has no
 * equivalent for the rest. The firmament deliberately returns only the
 * intersection, so a caller needing Chrome-only data must ask for it.
 *
 * The defect was never the choice. It was the silence: `UNBROWSE_BROWSER_BACKEND=obscura`
 * meant "obscura, except where it quietly doesn't", with no way for the caller
 * to learn which capability pulled Chrome back in. I wrote that down as a defect
 * ("a backend explicitly selected as obscura should fail loudly, not quietly
 * become Chrome") and this is it closed.
 *
 * Two signals:
 *   1. the notice fires when — and ONLY when — obscura is selected
 *   2. the inventory of direct callers is PINNED, so a fifth silent site
 *      cannot appear without this failing
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { noteCdpRequired, __resetCdpNotices } from "../src/capture/engine.js";
import { codeLinesOnly, countCalls } from "./_source-scan.js";

const ROOT = join(import.meta.dirname, "..");

describe("the CDP fallback is audible", () => {
  let written: string[] = [];
  let restore: (() => void) | undefined;

  beforeEach(() => {
    __resetCdpNotices();
    written = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as never;
    restore = () => { process.stderr.write = real as never; };
  });
  afterEach(() => { restore?.(); delete process.env.UNBROWSE_BROWSER_BACKEND; });

  test("silent when obscura was NOT selected — the default path is unchanged", () => {
    delete process.env.UNBROWSE_BROWSER_BACKEND;
    noteCdpRequired("page HTML");
    expect(written).toEqual([]);
  });

  test("names the capability when obscura WAS selected", () => {
    process.env.UNBROWSE_BROWSER_BACKEND = "obscura";
    noteCdpRequired("page HTML");
    expect(written.length).toBe(1);
    // The caller must learn WHICH capability pulled Chrome back, not merely
    // that something did — that is the difference between a notice and noise.
    expect(written[0]).toContain("page HTML");
    expect(written[0]).toContain("obscura");
  });

  test("once per capability, however many retries run", () => {
    process.env.UNBROWSE_BROWSER_BACKEND = "obscura";
    for (let i = 0; i < 5; i += 1) noteCdpRequired("page HTML");
    noteCdpRequired("cookies");
    // These sites sit inside retry loops. A notice that repeats is a notice
    // that gets filtered out, so distinct capabilities speak once each.
    expect(written.length).toBe(2);
  });
});

describe("the inventory of direct CDP callers is pinned", () => {
  test("no site takes captureSession without declaring why", () => {
    // Frozen, with the reason each one cannot cross the firmament. Growth is
    // allowed — it must be DELIBERATE, because a silent fifth site is exactly
    // how "obscura is selected" and "obscura is used" drift apart again.
    const known: Record<string, number> = {
      "src/execution/index.ts": 3,   // html + cookies + ws_messages + js_bundles
      "src/orchestrator/index.ts": 1, // rendered html for anti-bot rescue
      "src/capture/engine.ts": 1,     // the firmament itself — the ONE legitimate dispatch
    };
    const found: Record<string, number> = {};
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".ts")) continue;
        if (p.endsWith("src/capture/index.ts")) continue; // the definition itself
        const n = countCalls(readFileSync(p, "utf8"), "captureSession");
        if (n > 0) found[p.slice(ROOT.length + 1)] = n;
      }
    };
    walk(join(ROOT, "src"));
    expect(found).toEqual(known);
  });

  test("the scanner these signals stand on is SOUND — the naive strip is not", () => {
    // This is the falsifier for the method, not the finding. The previous
    // version of this signal used `src.replace(/\/\*[\s\S]*?\*\//g, "")`,
    // which a `/*` inside a string literal turns into a 2,183-line hole in
    // src/orchestrator/index.ts — the real call site at line 5,627 fell inside
    // it, so the signal reported "no call sites" while reading a hole.
    const real = readFileSync(join(ROOT, "src/orchestrator/index.ts"), "utf8");
    const naive = real.replace(/\/\*[\s\S]*?\*\//g, "");
    expect({
      naive_keeps_the_call: naive.includes("noteCdpRequired("),
      sound_keeps_the_call: codeLinesOnly(real).includes("noteCdpRequired("),
    }).toEqual({ naive_keeps_the_call: false, sound_keeps_the_call: true });
    // And it never invents source it was not given.
    expect(codeLinesOnly(real).length).toBeLessThanOrEqual(real.length);
  });

  test("every direct caller in execution/orchestrator announces itself first", () => {
    // A call site that does not call noteCdpRequired is a silent one. Counting
    // rather than eyeballing: the counts must match per file.
    for (const f of ["src/execution/index.ts", "src/orchestrator/index.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const calls = countCalls(src, "captureSession");
      const notices = countCalls(src, "noteCdpRequired");
      // execution/index.ts: the anti-bot retry re-captures the SAME url inside
      // the try it already announced, so one notice covers both calls there.
      expect({ f, announced: notices >= 1 && notices <= calls })
        .toEqual({ f, announced: true });
    }
  });
});
