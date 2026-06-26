import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  bindContractToTorah,
  loadTorahCorpus,
  torahBindingText,
} from "../src/values/contract-torah-root.js";
import { nativeAvailable } from "../src/values/contract-native.js";

describe("contract Torah root binding", () => {
  it("loads the complete Torah corpus in canonical order", async () => {
    const torah = await loadTorahCorpus();
    expect(torah.length).toBe(5852);
    expect(torah[0].ref).toBe("Genesis 1:1");
    expect(torah.at(-1)?.ref).toBe("Deuteronomy 34:12");
  });

  it("binds a contract to both a sequence anchor and a semantic Torah witness", async () => {
    const binding = await bindContractToTorah(
      { id: "torah-test", text: "contract rows must align against the Torah root" },
      { position: { index: 0, total: 2 } },
    );
    expect(binding.root).toBe("torah");
    expect(binding.sequence.ref).toBe("Genesis 1:1");
    expect(binding.semantic.ref).toMatch(/^(Genesis|Exodus|Leviticus|Numbers|Deuteronomy) \d+:\d+$/);
    expect(binding.semantic.score).toBeGreaterThan(0);
    expect(binding.timeGradient.direction).toBe("forward");
    expect(binding.timeGradient.progress).toBe(0);
    expect(binding.ast.kind).toBe("verse");
    expect(binding.ast.children?.some((node) => node.kind === "token")).toBe(true);
    expect(binding.lexicon.some((token) => token.language === "en")).toBe(true);
    expect(binding.lexicon.some((token) => token.language === "he" && typeof token.gematria === "number")).toBe(true);
    expect(binding.numbersFibonacci.map((row) => row.fibonacci)).toEqual([1, 1, 2, 3, 5, 8, 13]);
    expect(binding.numbersFibonacci.every((row) => row.ref.startsWith("Numbers "))).toBe(true);
    if (nativeAvailable()) expect(binding.nativeBibleAnchorIndex).not.toBeNull();
    expect(torahBindingText(binding)).toContain("torah.sequence=");
    expect(torahBindingText(binding)).toContain("torah.semantic=");
    expect(torahBindingText(binding)).toContain("torah.gradient=forward:");
    expect(torahBindingText(binding)).toContain("torah.numbers_fibonacci=");
    expect(torahBindingText(binding)).toContain("torah.lexicon=");
  });

  it("the persistence seam imports and applies the Torah binding before indexing", async () => {
    const source = await readFile("src/values/contract-everything.ts", "utf8");
    expect(source).toContain("bindContractToTorah");
    expect(source).toContain("out.torah = await bindContractToTorah");
    expect(source).toContain("torahBindingText(out.torah)");
  });
});
